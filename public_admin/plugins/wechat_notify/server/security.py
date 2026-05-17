from __future__ import annotations

import hashlib
import hmac
import time
from typing import Any


def build_signature(secret: str, timestamp: str, nonce: str, body: bytes) -> str:
    payload = b'\n'.join([
        str(timestamp or '').encode('utf-8'),
        str(nonce or '').encode('utf-8'),
        body or b'',
    ])
    return hmac.new(str(secret or '').encode('utf-8'), payload, hashlib.sha256).hexdigest()


def verify_signature(secret: str, timestamp: str, nonce: str, signature: str, body: bytes, max_skew_seconds: int = 300) -> bool:
    normalized_secret = str(secret or '').strip()
    if not normalized_secret:
        return False
    try:
        ts = int(str(timestamp or '').strip())
    except Exception:
        return False
    if abs(int(time.time()) - ts) > max_skew_seconds:
        return False
    if not str(nonce or '').strip() or not str(signature or '').strip():
        return False
    expected = build_signature(normalized_secret, str(ts), str(nonce), body)
    return hmac.compare_digest(expected, str(signature or '').strip().lower())


def normalize_username(value: Any) -> str:
    return str(value or '').strip().lower()


def normalize_text(value: Any, limit: int = 200) -> str:
    text = ' '.join(str(value or '').strip().split())
    if limit > 0 and len(text) > limit:
        return text[:limit]
    return text
