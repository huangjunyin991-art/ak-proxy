from __future__ import annotations

import os
from dataclasses import dataclass


def _env_bool(name: str, default: bool = False) -> bool:
    value = str(os.environ.get(name, '')).strip().lower()
    if not value:
        return default
    return value in {'1', 'true', 'yes', 'on', 'enabled'}


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
class NotifyCenterConfig:
    enabled: bool
    internal_secret: str
    cookie_name: str
    public_base_url: str
    vapid_public_key: str
    vapid_private_key: str
    vapid_private_key_file: str
    vapid_subject: str
    outbox_batch_size: int
    worker_interval_seconds: int
    max_attempts: int
    retry_base_seconds: int
    dedupe_window_seconds: int
    show_message_preview: bool
    web_push_ttl_seconds: int
    web_push_timeout_seconds: int

    @classmethod
    def from_env(cls) -> 'NotifyCenterConfig':
        return cls(
            enabled=_env_bool('NOTIFY_CENTER_ENABLED', False),
            internal_secret=str(os.environ.get('NOTIFY_CENTER_INTERNAL_SECRET') or os.environ.get('IM_NOTIFY_CENTER_WEBHOOK_SECRET') or '').strip(),
            cookie_name=str(os.environ.get('NOTIFY_CENTER_COOKIE_NAME') or os.environ.get('IM_AUTH_COOKIE') or 'ak_username').strip() or 'ak_username',
            public_base_url=str(os.environ.get('NOTIFY_CENTER_PUBLIC_BASE_URL') or '').strip().rstrip('/'),
            vapid_public_key=str(os.environ.get('WEB_PUSH_VAPID_PUBLIC_KEY') or '').strip(),
            vapid_private_key=str(os.environ.get('WEB_PUSH_VAPID_PRIVATE_KEY') or '').strip(),
            vapid_private_key_file=str(os.environ.get('WEB_PUSH_VAPID_PRIVATE_KEY_FILE') or '').strip(),
            vapid_subject=str(os.environ.get('WEB_PUSH_VAPID_SUBJECT') or 'mailto:admin@example.com').strip() or 'mailto:admin@example.com',
            outbox_batch_size=_env_int('NOTIFY_CENTER_OUTBOX_BATCH_SIZE', 100, 1, 500),
            worker_interval_seconds=_env_int('NOTIFY_CENTER_WORKER_INTERVAL_SECONDS', 5, 2, 300),
            max_attempts=_env_int('NOTIFY_CENTER_MAX_ATTEMPTS', 5, 1, 20),
            retry_base_seconds=_env_int('NOTIFY_CENTER_RETRY_BASE_SECONDS', 60, 5, 3600),
            dedupe_window_seconds=_env_int('NOTIFY_CENTER_DEDUPE_WINDOW_SECONDS', 30, 0, 3600),
            show_message_preview=_env_bool('NOTIFY_CENTER_SHOW_MESSAGE_PREVIEW', False),
            web_push_ttl_seconds=_env_int('WEB_PUSH_TTL_SECONDS', 86400, 60, 2592000),
            web_push_timeout_seconds=_env_int('WEB_PUSH_TIMEOUT_SECONDS', 8, 1, 60),
        )

    def is_web_push_ready(self) -> bool:
        return self.enabled and bool(self.vapid_public_key) and bool(self.vapid_private_key or self.vapid_private_key_file)
