from __future__ import annotations

from typing import Any

from .channels.wxpusher import WxPusherChannel
from .config import WechatNotifyConfig
from .formatter import build_notification_content, build_notification_title, build_recipient_usernames
from .repository import WechatNotifyRepository
from .security import normalize_username


class WechatNotifyService:
    def __init__(self, *, config: WechatNotifyConfig, repository: WechatNotifyRepository, channel: WxPusherChannel):
        self.config = config
        self.repository = repository
        self.channel = channel

    async def ensure_schema(self) -> None:
        await self.repository.ensure_schema()

    async def build_status(self) -> dict[str, Any]:
        return {
            'enabled': self.config.enabled,
            'channel': self.config.channel,
            'channel_ready': self.config.is_channel_ready(),
            'wxpusher_enabled': self.config.wxpusher_enabled,
            'has_wxpusher_app_token': bool(self.config.wxpusher_app_token),
            'has_internal_secret': bool(self.config.internal_secret),
        }

    async def create_bind_qrcode(self, username: str) -> dict[str, Any]:
        normalized_username = normalize_username(username)
        if not normalized_username:
            raise ValueError('未识别当前用户')
        if not self.config.is_channel_ready():
            raise ValueError('微信提醒通道未启用或未完成配置')
        bind_token = await self.repository.create_bind_token(
            username=normalized_username,
            channel='wxpusher',
            ttl_seconds=self.config.bind_token_ttl_seconds,
        )
        token = str(bind_token.get('token') or '')
        qrcode = await self.channel.create_bind_qrcode(
            extra=token,
            valid_seconds=self.config.wxpusher_qrcode_expire_seconds,
        )
        if not qrcode.success:
            raise ValueError(qrcode.error or '创建绑定二维码失败')
        await self.repository.update_bind_token_qrcode(
            token=token,
            provider_code=qrcode.code,
            qrcode_url=qrcode.url or qrcode.short_url,
        )
        return {
            'token': token,
            'qrcode_url': qrcode.url,
            'short_url': qrcode.short_url,
            'provider_code': qrcode.code,
            'expires_at': bind_token.get('expires_at'),
            'expires_in': qrcode.expires_in or self.config.wxpusher_qrcode_expire_seconds,
        }

    async def handle_wxpusher_callback(self, payload: dict[str, Any]) -> dict[str, Any]:
        action = str(payload.get('action') or '').strip()
        data = payload.get('data') if isinstance(payload.get('data'), dict) else {}
        if action != 'app_subscribe':
            return {'accepted': True, 'ignored': True, 'action': action}
        uid = str(data.get('uid') or '').strip()
        extra = str(data.get('extra') or '').strip()
        if not uid or not extra:
            return {'accepted': False, 'message': '缺少 UID 或绑定参数'}
        binding = await self.repository.complete_binding(
            token=extra,
            channel='wxpusher',
            target_id=uid,
            metadata={'source': data.get('source'), 'app_id': data.get('appId'), 'app_name': data.get('appName')},
        )
        if not binding:
            return {'accepted': False, 'message': '绑定二维码已过期或无效'}
        return {'accepted': True, 'binding': binding}

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
            message_id=int(event.get('message_id') or 0),
            conversation_id=int(event.get('conversation_id') or 0),
            payload=event,
        )
        if not inserted:
            return {'accepted': True, 'duplicate': True, 'queued': 0}
        recipients = build_recipient_usernames(event)
        if not recipients:
            return {'accepted': True, 'queued': 0, 'reason': 'no_recipients'}
        bindings = await self.repository.get_active_bindings(recipients, 'wxpusher')
        title = build_notification_title(event)
        summary = title[:100]
        content = build_notification_content(event)
        conversation_id = int(event.get('conversation_id') or 0)
        queued = 0
        skipped_by_dedupe = 0
        for username in recipients:
            binding = bindings.get(username)
            if not binding:
                continue
            if await self.repository.recent_outbox_exists(
                channel='wxpusher',
                recipient_username=username,
                conversation_id=conversation_id,
                window_seconds=self.config.dedupe_window_seconds,
            ):
                skipped_by_dedupe += 1
                continue
            created = await self.repository.enqueue_outbox(
                event_id=event_id,
                channel='wxpusher',
                recipient_username=username,
                target_id=str(binding.get('target_id') or ''),
                title=title,
                summary=summary,
                content=content,
                url=self.config.public_base_url,
                payload=event,
                max_attempts=self.config.max_attempts,
            )
            if created:
                queued += 1
        return {'accepted': True, 'queued': queued, 'target_count': len(recipients), 'bound_count': len(bindings), 'skipped_by_dedupe': skipped_by_dedupe}

    async def flush_outbox_once(self) -> dict[str, int]:
        if not self.config.is_channel_ready():
            return {'claimed': 0, 'sent': 0, 'failed': 0}
        items = await self.repository.claim_pending_outbox(limit=self.config.outbox_batch_size)
        sent = 0
        failed = 0
        for item in items:
            result = await self.channel.send(
                target_id=str(item.get('target_id') or ''),
                title=str(item.get('title') or ''),
                content=str(item.get('content') or ''),
                summary=str(item.get('summary') or ''),
                url=str(item.get('url') or ''),
            )
            if result.success:
                await self.repository.mark_outbox_sent(
                    outbox_id=int(item.get('id') or 0),
                    provider_message_id=result.provider_message_id,
                    provider_record_id=result.provider_record_id,
                )
                sent += 1
            else:
                await self.repository.mark_outbox_failed(
                    outbox_id=int(item.get('id') or 0),
                    error=result.error,
                    retry_base_seconds=self.config.retry_base_seconds,
                )
                failed += 1
        return {'claimed': len(items), 'sent': sent, 'failed': failed}
