from __future__ import annotations

import os
from dataclasses import dataclass


def _env_bool(name: str, default: bool = False) -> bool:
    value = str(os.environ.get(name, '')).strip().lower()
    if not value:
        return default
    return value in {'1', 'true', 'yes', 'on', 'enabled'}


def _env_bool_any(names: tuple[str, ...], default: bool = False) -> bool:
    for name in names:
        value = str(os.environ.get(name, '')).strip().lower()
        if value:
            return value in {'1', 'true', 'yes', 'on', 'enabled'}
    return default


def _env_int(name: str, default: int, minimum: int | None = None, maximum: int | None = None) -> int:
    try:
        value = int(str(os.environ.get(name, '')).strip() or default)
    except Exception:
        value = default
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


@dataclass(frozen=True)
class WechatNotifyConfig:
    enabled: bool
    channel: str
    internal_secret: str
    cookie_name: str
    public_base_url: str
    bind_token_ttl_seconds: int
    outbox_batch_size: int
    worker_interval_seconds: int
    max_attempts: int
    retry_base_seconds: int
    dedupe_window_seconds: int
    wxpusher_enabled: bool
    wxpusher_app_token: str
    wxpusher_api_base: str
    wxpusher_request_timeout_seconds: float
    wxpusher_qrcode_expire_seconds: int

    @classmethod
    def from_env(cls) -> 'WechatNotifyConfig':
        wxpusher_app_token = str(os.environ.get('WXPUSHER_APP_TOKEN') or os.environ.get('WECHAT_NOTIFY_WXPUSHER_APP_TOKEN') or '').strip()
        enabled = _env_bool_any(('WECHAT_NOTIFY_ENABLED', 'IM_WECHAT_NOTIFY_ENABLED'), False)
        wxpusher_enabled = _env_bool('WXPUSHER_ENABLED', enabled and bool(wxpusher_app_token))
        return cls(
            enabled=enabled,
            channel=str(os.environ.get('WECHAT_NOTIFY_CHANNEL') or 'wxpusher').strip().lower() or 'wxpusher',
            internal_secret=str(os.environ.get('WECHAT_NOTIFY_INTERNAL_SECRET') or os.environ.get('IM_WECHAT_NOTIFY_WEBHOOK_SECRET') or os.environ.get('IM_NOTIFY_INTERNAL_SECRET') or '').strip(),
            cookie_name=str(os.environ.get('WECHAT_NOTIFY_COOKIE_NAME') or os.environ.get('IM_AUTH_COOKIE') or 'ak_username').strip() or 'ak_username',
            public_base_url=str(os.environ.get('WECHAT_NOTIFY_PUBLIC_BASE_URL') or '').strip().rstrip('/'),
            bind_token_ttl_seconds=_env_int('WECHAT_NOTIFY_BIND_TOKEN_TTL_SECONDS', 1800, 60, 2592000),
            outbox_batch_size=_env_int('WECHAT_NOTIFY_OUTBOX_BATCH_SIZE', 50, 1, 200),
            worker_interval_seconds=_env_int('WECHAT_NOTIFY_WORKER_INTERVAL_SECONDS', 10, 2, 300),
            max_attempts=_env_int('WECHAT_NOTIFY_MAX_ATTEMPTS', 5, 1, 20),
            retry_base_seconds=_env_int('WECHAT_NOTIFY_RETRY_BASE_SECONDS', 60, 5, 3600),
            dedupe_window_seconds=_env_int('WECHAT_NOTIFY_DEDUPE_WINDOW_SECONDS', 30, 0, 3600),
            wxpusher_enabled=wxpusher_enabled,
            wxpusher_app_token=wxpusher_app_token,
            wxpusher_api_base=str(os.environ.get('WXPUSHER_API_BASE') or 'https://wxpusher.zjiecode.com').strip().rstrip('/'),
            wxpusher_request_timeout_seconds=float(str(os.environ.get('WXPUSHER_REQUEST_TIMEOUT_SECONDS') or '8').strip() or 8),
            wxpusher_qrcode_expire_seconds=_env_int('WXPUSHER_QRCODE_EXPIRE_SECONDS', 1800, 60, 2592000),
        )

    def is_channel_ready(self) -> bool:
        return self.enabled and self.channel == 'wxpusher' and self.wxpusher_enabled and bool(self.wxpusher_app_token)
