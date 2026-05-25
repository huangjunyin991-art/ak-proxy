from __future__ import annotations

import hashlib
from typing import Any

from .channels.web_push import WebPushChannel, is_invalid_push_endpoint
from .config import NotifyCenterConfig
from .formatter import build_notification_body, build_notification_title, build_notification_url, build_recipient_usernames
from .repository import NotifyCenterRepository
from .security import normalize_username

try:
    from .channels.pushdeer import PushDeerChannel
    from .channels.pushdeer.client import normalize_server_url
except Exception:
    PushDeerChannel = Any

    def normalize_server_url(value: str) -> str:
        text = str(value or '').strip().rstrip('/')
        return text or 'https://api2.pushdeer.com'


class NotifyCenterService:
    def __init__(self, *, config: NotifyCenterConfig, repository: NotifyCenterRepository, web_push_channel: WebPushChannel, pushdeer_channel: PushDeerChannel | None = None):
        self.config = config
        self.repository = repository
        self.web_push_channel = web_push_channel
        self.pushdeer_channel = pushdeer_channel

    async def ensure_schema(self) -> None:
        await self.repository.ensure_schema()

    async def build_status(self) -> dict[str, Any]:
        return {
            'enabled': self.config.enabled,
            'web_push_ready': self.config.is_web_push_ready(),
            'pushdeer_ready': self.pushdeer_channel is not None,
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
        await self._ensure_default_pushdeer_binding(normalized_username)
        data = await self.repository.get_user_push_diagnostics(normalized_username)
        data['pushdeer_binding'] = _public_pushdeer_binding(data.get('pushdeer_binding') or {}, username=normalized_username)
        return {
            'username': normalized_username,
            'enabled': self.config.enabled,
            'web_push_ready': self.config.is_web_push_ready(),
            'pushdeer_ready': self.pushdeer_channel is not None,
            **data,
        }

    async def get_pushdeer_binding(self, username: str) -> dict[str, Any]:
        normalized_username = normalize_username(username)
        if not normalized_username:
            raise ValueError('未识别当前用户')
        binding = await self._ensure_default_pushdeer_binding(normalized_username)
        return _public_pushdeer_binding(binding, username=normalized_username)

    async def _ensure_default_pushdeer_binding(self, username: str) -> dict[str, Any]:
        binding = await self.repository.get_pushdeer_binding(username)
        if binding:
            return binding
        return await self.repository.upsert_pushdeer_binding(
            username=username,
            pushkey=_build_default_pushdeer_key(username, self.config),
            server_url=normalize_server_url(''),
            enabled=True,
        )

    async def upsert_pushdeer_binding(self, *, username: str, pushkey: str, server_url: str, enabled: bool) -> dict[str, Any]:
        normalized_username = normalize_username(username)
        if not normalized_username:
            raise ValueError('未识别当前用户')
        normalized_pushkey = str(pushkey or '').strip()
        if not normalized_pushkey:
            existing = await self.repository.get_pushdeer_binding(normalized_username)
            normalized_pushkey = str(existing.get('pushkey') or '').strip()
            if not normalized_pushkey:
                raise ValueError('缺少 PushDeer 绑定码')
        binding = await self.repository.upsert_pushdeer_binding(
            username=normalized_username,
            pushkey=normalized_pushkey,
            server_url=normalize_server_url(server_url),
            enabled=bool(enabled),
        )
        return _public_pushdeer_binding(binding, username=normalized_username)

    async def delete_pushdeer_binding(self, *, username: str) -> dict[str, Any]:
        normalized_username = normalize_username(username)
        if not normalized_username:
            raise ValueError('未识别当前用户')
        deleted = await self.repository.delete_pushdeer_binding(username=normalized_username)
        return {'deleted': deleted, 'username': normalized_username}

    async def test_pushdeer_binding(self, *, username: str) -> dict[str, Any]:
        normalized_username = normalize_username(username)
        if not normalized_username:
            raise ValueError('未识别当前用户')
        if self.pushdeer_channel is None:
            raise ValueError('PushDeer 通道不可用')
        binding = await self.repository.get_pushdeer_binding(normalized_username)
        if not binding:
            raise ValueError('当前账号未绑定 PushDeer')
        result = await self.pushdeer_channel.send(
            binding=binding,
            notification={
                'title': 'PushDeer 测试通知',
                'body': f'账号 {normalized_username} 的 PushDeer 绑定已可用',
                'url': self.config.public_base_url or '/',
            },
        )
        binding_id = int(binding.get('id') or 0)
        if result.success:
            await self.repository.mark_pushdeer_binding_sent(binding_id)
            return {'sent': True, 'username': normalized_username, 'provider_record_id': result.provider_record_id}
        await self.repository.mark_pushdeer_binding_error(binding_id, result.error)
        return {'sent': False, 'username': normalized_username, 'error': result.error}

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
        pushdeer_bindings = await self.repository.get_active_pushdeer_bindings(recipients)
        title = build_notification_title(event)
        body = build_notification_body(event, show_preview=self.config.show_message_preview)
        url = build_notification_url(event, self.config.public_base_url)
        conversation_id = int(event.get('conversation_id') or 0)
        queued = 0
        skipped_by_dedupe = 0
        for username in recipients:
            user_subscriptions = [item for item in (subscriptions.get(username) or []) if not _is_mobile_web_push_subscription(item)]
            web_push_deduped = False
            if user_subscriptions:
                web_push_deduped = await self.repository.recent_outbox_exists(
                    channel='web_push',
                    recipient_username=username,
                    conversation_id=conversation_id,
                    window_seconds=self.config.dedupe_window_seconds,
                )
            if web_push_deduped:
                skipped_by_dedupe += len(user_subscriptions)
            else:
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
            pushdeer_binding = pushdeer_bindings.get(username) or {}
            pushdeer_deduped = False
            if pushdeer_binding:
                pushdeer_deduped = await self.repository.recent_outbox_exists(
                    channel='pushdeer',
                    recipient_username=username,
                    conversation_id=conversation_id,
                    window_seconds=self.config.dedupe_window_seconds,
                )
            if pushdeer_deduped:
                skipped_by_dedupe += 1
                continue
            if pushdeer_binding:
                created = await self.repository.enqueue_outbox(
                    event_id=event_id,
                    channel='pushdeer',
                    recipient_username=username,
                    subscription_id=int(pushdeer_binding.get('id') or 0),
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
            'pushdeer_bound_user_count': len(pushdeer_bindings),
            'skipped_by_dedupe': skipped_by_dedupe,
        }

    async def flush_outbox_once(self) -> dict[str, int]:
        if not self.config.enabled:
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
            channel = str(item.get('channel') or '')
            if channel == 'pushdeer':
                if self.pushdeer_channel is None:
                    await self.repository.mark_outbox_failed(
                        outbox_id=int(item.get('id') or 0),
                        error='PushDeer 通道不可用',
                        retry_base_seconds=self.config.retry_base_seconds,
                    )
                    failed += 1
                    continue
                result = await self.pushdeer_channel.send(binding=item.get('pushdeer_binding') or {}, notification=payload)
                binding_id = int(item.get('subscription_id') or 0)
                if result.success:
                    await self.repository.mark_pushdeer_binding_sent(binding_id)
                else:
                    await self.repository.mark_pushdeer_binding_error(binding_id, result.error)
            else:
                if not self.config.is_web_push_ready():
                    await self.repository.mark_outbox_failed(
                        outbox_id=int(item.get('id') or 0),
                        error='Web Push 通道未启用或 VAPID 未配置',
                        retry_base_seconds=self.config.retry_base_seconds,
                    )
                    failed += 1
                    continue
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


def _public_pushdeer_binding(binding: dict[str, Any], *, username: str) -> dict[str, Any]:
    item = binding if isinstance(binding, dict) else {}
    server_url = str(item.get('server_url') or 'https://api2.pushdeer.com')
    pushkey = str(item.get('pushkey') or '')
    return {
        'username': username,
        'bound': bool(item.get('id')),
        'enabled': bool(item.get('enabled')) if item else False,
        'server_url': server_url,
        'app_binding_account': username,
        'app_pushkey': pushkey,
        'app_server_url': server_url,
        'last_sent_at': str(item.get('last_sent_at') or ''),
        'last_error': str(item.get('last_error') or ''),
        'updated_at': str(item.get('updated_at') or ''),
    }


def _build_default_pushdeer_key(username: str, config: NotifyCenterConfig) -> str:
    seed = str(config.internal_secret or config.public_base_url or 'notify-center').strip()
    digest = hashlib.sha256(f'{seed}:{username}'.encode('utf-8')).hexdigest()
    return f'ak_{username}_{digest[:24]}'


def _is_mobile_web_push_subscription(subscription: dict[str, Any]) -> bool:
    text = ' '.join([
        str(subscription.get('platform') or ''),
        str(subscription.get('user_agent') or ''),
    ]).lower()
    if not text:
        return False
    return any(keyword in text for keyword in ('android', 'iphone', 'ipad', 'ipod', 'mobile', 'harmonyos'))
