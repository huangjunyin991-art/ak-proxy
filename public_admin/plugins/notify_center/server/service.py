from __future__ import annotations

from typing import Any

from .channels.web_push import WebPushChannel, is_invalid_push_endpoint
from .config import NotifyCenterConfig
from .formatter import build_notification_body, build_notification_title, build_notification_url, build_recipient_usernames
from .repository import NotifyCenterRepository
from .security import normalize_username


class NotifyCenterService:
    def __init__(self, *, config: NotifyCenterConfig, repository: NotifyCenterRepository, web_push_channel: WebPushChannel):
        self.config = config
        self.repository = repository
        self.web_push_channel = web_push_channel

    async def ensure_schema(self) -> None:
        await self.repository.ensure_schema()

    async def build_status(self) -> dict[str, Any]:
        return {
            'enabled': self.config.enabled,
            'web_push_ready': self.config.is_web_push_ready(),
            'has_internal_secret': bool(self.config.internal_secret),
            'has_vapid_public_key': bool(self.config.vapid_public_key),
            'has_vapid_private_key': bool(self.config.vapid_private_key),
        }

    async def get_vapid_public_key(self) -> dict[str, Any]:
        return {
            'enabled': self.config.enabled,
            'web_push_ready': self.config.is_web_push_ready(),
            'public_key': self.config.vapid_public_key if self.config.enabled else '',
        }

    async def get_user_web_push_diagnostics(self, username: str) -> dict[str, Any]:
        normalized_username = normalize_username(username)
        if not normalized_username:
            raise ValueError('未识别当前用户')
        data = await self.repository.get_user_push_diagnostics(normalized_username)
        return {
            'username': normalized_username,
            'enabled': self.config.enabled,
            'web_push_ready': self.config.is_web_push_ready(),
            **data,
        }

    async def upsert_web_push_subscription(self, *, username: str, subscription: dict[str, Any], user_agent: str, platform: str) -> dict[str, Any]:
        normalized_username = normalize_username(username)
        if not normalized_username:
            raise ValueError('未识别当前用户')
        endpoint = str(subscription.get('endpoint') or '').strip()
        keys = subscription.get('keys') if isinstance(subscription.get('keys'), dict) else {}
        p256dh = str(keys.get('p256dh') or '').strip()
        auth = str(keys.get('auth') or '').strip()
        if not endpoint or not p256dh or not auth:
            raise ValueError('Push subscription 不完整')
        if is_invalid_push_endpoint(endpoint):
            raise ValueError('浏览器返回了不可投递的 Push endpoint，请更换网络或关闭浏览器隐私代理后重试')
        item = await self.repository.upsert_subscription(
            username=normalized_username,
            endpoint=endpoint,
            p256dh=p256dh,
            auth=auth,
            user_agent=user_agent,
            platform=platform,
            metadata={'raw_keys': keys},
        )
        return {'subscription_id': item.get('id'), 'enabled': item.get('enabled')}

    async def disable_web_push_subscription(self, *, username: str, endpoint: str) -> dict[str, Any]:
        normalized_username = normalize_username(username)
        if not normalized_username:
            raise ValueError('未识别当前用户')
        disabled = await self.repository.disable_subscription(username=normalized_username, endpoint=str(endpoint or '').strip())
        return {'disabled': disabled}

    async def handle_im_message_event(self, event: dict[str, Any]) -> dict[str, Any]:
        if not self.config.enabled:
            return {'accepted': True, 'enabled': False, 'queued': 0}
        event_id = str(event.get('event_id') or '').strip()
        if not event_id:
            message_id = int(event.get('message_id') or 0)
            conversation_id = int(event.get('conversation_id') or 0)
            event_id = f'im:{conversation_id}:{message_id}'
            event['event_id'] = event_id
        inserted = await self.repository.record_event(
            event_id=event_id,
            event_type=str(event.get('event_type') or ''),
            message_id=int(event.get('message_id') or 0),
            conversation_id=int(event.get('conversation_id') or 0),
            payload=event,
        )
        if not inserted:
            return {'accepted': True, 'duplicate': True, 'queued': 0}
        recipients = build_recipient_usernames(event)
        if not recipients:
            return {'accepted': True, 'queued': 0, 'reason': 'no_recipients'}
        subscriptions = await self.repository.get_active_subscriptions(recipients)
        title = build_notification_title(event)
        body = build_notification_body(event, show_preview=self.config.show_message_preview)
        url = build_notification_url(event, self.config.public_base_url)
        conversation_id = int(event.get('conversation_id') or 0)
        queued = 0
        skipped_by_dedupe = 0
        for username in recipients:
            user_subscriptions = subscriptions.get(username) or []
            if not user_subscriptions:
                continue
            if await self.repository.recent_outbox_exists(
                channel='web_push',
                recipient_username=username,
                conversation_id=conversation_id,
                window_seconds=self.config.dedupe_window_seconds,
            ):
                skipped_by_dedupe += len(user_subscriptions)
                continue
            for subscription in user_subscriptions:
                created = await self.repository.enqueue_outbox(
                    event_id=event_id,
                    channel='web_push',
                    recipient_username=username,
                    subscription_id=int(subscription.get('id') or 0),
                    title=title,
                    body=body,
                    url=url,
                    payload=event,
                    max_attempts=self.config.max_attempts,
                )
                if created:
                    queued += 1
        return {
            'accepted': True,
            'queued': queued,
            'target_count': len(recipients),
            'subscribed_user_count': len(subscriptions),
            'skipped_by_dedupe': skipped_by_dedupe,
        }

    async def flush_outbox_once(self) -> dict[str, int]:
        if not self.config.is_web_push_ready():
            return {'claimed': 0, 'sent': 0, 'failed': 0, 'expired': 0}
        items = await self.repository.claim_pending_outbox(limit=self.config.outbox_batch_size)
        sent = 0
        failed = 0
        expired = 0
        for item in items:
            payload = {
                'title': str(item.get('title') or ''),
                'body': str(item.get('body') or ''),
                'url': str(item.get('url') or '/'),
                'tag': str(item.get('event_id') or item.get('id') or ''),
                'data': {
                    'event_id': str(item.get('event_id') or ''),
                    'conversation_id': int(item.get('conversation_id') or 0),
                },
            }
            result = await self.web_push_channel.send(subscription=item.get('subscription') or {}, payload=payload)
            if result.success:
                await self.repository.mark_outbox_sent(
                    outbox_id=int(item.get('id') or 0),
                    provider_message_id=result.provider_message_id,
                    provider_record_id=result.provider_record_id,
                )
                sent += 1
                continue
            if result.subscription_expired:
                await self.repository.disable_subscription_by_id(int(item.get('subscription_id') or 0))
                await self.repository.mark_outbox_permanent_failed(
                    outbox_id=int(item.get('id') or 0),
                    error=result.error or 'Push subscription 已失效',
                )
                expired += 1
                continue
            await self.repository.mark_outbox_failed(
                outbox_id=int(item.get('id') or 0),
                error=result.error,
                retry_base_seconds=self.config.retry_base_seconds,
            )
            failed += 1
        return {'claimed': len(items), 'sent': sent, 'failed': failed, 'expired': expired}
