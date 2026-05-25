from __future__ import annotations

import asyncio
import base64
import json
import os
from typing import Any
from urllib.parse import urlparse

from ..config import NotifyCenterConfig
from .base import ChannelSendResult

try:
    from cryptography.hazmat.primitives import serialization
    _CRYPTOGRAPHY_IMPORT_ERROR = None
except Exception as e:
    serialization = None
    _CRYPTOGRAPHY_IMPORT_ERROR = e

try:
    from pywebpush import webpush
    _WEB_PUSH_IMPORT_ERROR = None
except Exception as e:
    webpush = None
    _WEB_PUSH_IMPORT_ERROR = e


class WebPushChannel:
    def __init__(self, config: NotifyCenterConfig):
        self._config = config

    async def send(self, *, subscription: dict[str, Any], payload: dict[str, Any]) -> ChannelSendResult:
        if not self._config.is_web_push_ready():
            return ChannelSendResult(success=False, error='Web Push 通道未启用或 VAPID 未配置')
        if webpush is None:
            return ChannelSendResult(success=False, error=f'pywebpush 不可用: {_WEB_PUSH_IMPORT_ERROR}')
        endpoint = str(subscription.get('endpoint') or '').strip()
        p256dh = str(subscription.get('p256dh') or '').strip()
        auth = str(subscription.get('auth') or '').strip()
        if not endpoint or not p256dh or not auth:
            return ChannelSendResult(success=False, error='Push subscription 不完整', subscription_expired=True)
        if is_invalid_push_endpoint(endpoint):
            return ChannelSendResult(success=False, error='Push endpoint 不可投递', subscription_expired=True)
        subscription_info = {
            'endpoint': endpoint,
            'keys': {
                'p256dh': p256dh,
                'auth': auth,
            },
        }
        data = json.dumps(payload or {}, ensure_ascii=False, separators=(',', ':'))
        vapid_private_key = self._resolve_vapid_private_key()
        try:
            response = await asyncio.wait_for(
                asyncio.to_thread(
                    webpush,
                    subscription_info=subscription_info,
                    data=data,
                    vapid_private_key=vapid_private_key,
                    vapid_claims={'sub': self._config.vapid_subject},
                    ttl=self._config.web_push_ttl_seconds,
                ),
                timeout=max(1, int(self._config.web_push_timeout_seconds or 8)),
            )
        except Exception as exc:
            expired = False
            status_code = 0
            response = getattr(exc, 'response', None)
            if response is not None:
                status_code = int(getattr(response, 'status_code', 0) or 0)
                expired = status_code in {404, 410}
            return ChannelSendResult(
                success=False,
                error=str(exc),
                subscription_expired=expired,
                raw={'status_code': status_code},
            )
        status_code = int(getattr(response, 'status_code', 201) or 201)
        success = 200 <= status_code < 300
        return ChannelSendResult(
            success=success,
            provider_message_id=str(getattr(response, 'headers', {}).get('Location') or ''),
            provider_record_id=str(status_code),
            error='' if success else f'Web Push HTTP {status_code}',
            subscription_expired=status_code in {404, 410},
            raw={'status_code': status_code},
        )

    def _resolve_vapid_private_key(self) -> str:
        key_file = str(getattr(self._config, 'vapid_private_key_file', '') or '').strip()
        if key_file:
            with open(key_file, 'r', encoding='utf-8') as handle:
                return _normalize_vapid_private_key(handle.read().strip())
        key = str(self._config.vapid_private_key or '').strip()
        if key and os.path.exists(key):
            with open(key, 'r', encoding='utf-8') as handle:
                return _normalize_vapid_private_key(handle.read().strip())
        if '\\n' in key:
            return _normalize_vapid_private_key(key.replace('\\n', '\n'))
        return _normalize_vapid_private_key(key)


def _normalize_vapid_private_key(key: str) -> str:
    value = str(key or '').strip()
    if 'BEGIN' not in value:
        return value
    if serialization is None:
        raise RuntimeError(f'cryptography 不可用: {_CRYPTOGRAPHY_IMPORT_ERROR}')
    private_key = serialization.load_pem_private_key(value.encode('utf-8'), password=None)
    private_value = private_key.private_numbers().private_value
    raw = private_value.to_bytes(32, 'big')
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def is_invalid_push_endpoint(endpoint: str) -> bool:
    host = str(urlparse(str(endpoint or '').strip()).hostname or '').strip().lower()
    return host == 'permanently-removed.invalid' or host.endswith('.invalid')
