from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any

from fastapi import Request

from .security import normalize_username


DEFAULT_IDENTITY_COOKIE_NAME = 'ak_notify_identity'
DEFAULT_IDENTITY_TTL_SECONDS = 86400 * 30


def build_identity_cookie_value(username: str, secret: str, *, ttl_seconds: int = DEFAULT_IDENTITY_TTL_SECONDS,
                                now: int | None = None) -> str:
    normalized_username = normalize_username(username)
    normalized_secret = str(secret or '').strip()
    if not normalized_username or not normalized_secret:
        return ''

    issued_at = int(now if now is not None else time.time())
    ttl = max(60, int(ttl_seconds or DEFAULT_IDENTITY_TTL_SECONDS))
    payload = {
        'sub': normalized_username,
        'iat': issued_at,
        'exp': issued_at + ttl,
        'nonce': secrets.token_urlsafe(12),
    }
    body = _b64url_encode(json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8'))
    signed = f'v1.{body}'
    return f'{signed}.{_sign(signed, normalized_secret)}'


def verify_identity_cookie_value(value: str, secret: str, *, now: int | None = None) -> str:
    normalized_secret = str(secret or '').strip()
    token = str(value or '').strip()
    if not normalized_secret or not token:
        return ''

    parts = token.split('.')
    if len(parts) != 3 or parts[0] != 'v1':
        return ''

    signed = '.'.join(parts[:2])
    expected = _sign(signed, normalized_secret)
    if not hmac.compare_digest(expected, parts[2]):
        return ''

    try:
        payload = json.loads(_b64url_decode(parts[1]).decode('utf-8'))
    except Exception:
        return ''
    if not isinstance(payload, dict):
        return ''

    expires_at = _safe_int(payload.get('exp'))
    if expires_at <= int(now if now is not None else time.time()):
        return ''

    return normalize_username(payload.get('sub'))


def get_identity_cookie_username(request: Request, *, cookie_name: str, secret: str) -> str:
    try:
        return verify_identity_cookie_value(request.cookies.get(cookie_name or DEFAULT_IDENTITY_COOKIE_NAME), secret)
    except Exception:
        return ''


def attach_identity_cookie(response: Any, request: Request | None, *, username: str, secret: str,
                           cookie_name: str = DEFAULT_IDENTITY_COOKIE_NAME,
                           ttl_seconds: int = DEFAULT_IDENTITY_TTL_SECONDS) -> bool:
    value = build_identity_cookie_value(username, secret, ttl_seconds=ttl_seconds)
    if not value:
        return False
    response.set_cookie(
        key=cookie_name or DEFAULT_IDENTITY_COOKIE_NAME,
        value=value,
        max_age=max(60, int(ttl_seconds or DEFAULT_IDENTITY_TTL_SECONDS)),
        httponly=True,
        secure=_should_use_secure_cookie(request),
        samesite='lax',
        path='/',
    )
    return True


def _sign(value: str, secret: str) -> str:
    return hmac.new(secret.encode('utf-8'), value.encode('utf-8'), hashlib.sha256).hexdigest()


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode('ascii').rstrip('=')


def _b64url_decode(value: str) -> bytes:
    padding = '=' * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode('ascii'))


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def _should_use_secure_cookie(request: Request | None) -> bool:
    if request is None:
        return False
    try:
        forwarded_proto = str(request.headers.get('x-forwarded-proto') or '').split(',')[0].strip().lower()
        if forwarded_proto:
            return forwarded_proto == 'https'
        return str(request.url.scheme or '').lower() == 'https'
    except Exception:
        return False
