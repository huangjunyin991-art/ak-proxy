"""Short-lived, stateless markers for login-page requests.

The marker is deliberately only a first-party signal. It prevents an ordinary
browser double-submit from entering the IP short-interval ban counter, while
the existing password/account abuse guards remain active.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time


class LoginUiTokenService:
    """Issue and validate a signed login-page cookie value."""

    def __init__(self, secret: str, ttl_seconds: int = 900) -> None:
        self._secret = str(secret or "").encode("utf-8")
        self.ttl_seconds = max(60, int(ttl_seconds or 900))

    @property
    def enabled(self) -> bool:
        return bool(self._secret)

    def issue(self, now: int | None = None) -> str:
        if not self.enabled:
            return ""
        issued_at = int(time.time() if now is None else now)
        nonce = secrets.token_urlsafe(18)
        payload = f"{issued_at}.{nonce}".encode("utf-8")
        signature = hmac.new(self._secret, payload, hashlib.sha256).digest()
        encoded = base64.urlsafe_b64encode(signature).decode("ascii").rstrip("=")
        return f"{issued_at}.{nonce}.{encoded}"

    def validate(self, value: str, now: int | None = None) -> bool:
        if not self.enabled:
            return False
        parts = str(value or "").split(".")
        if len(parts) != 3:
            return False
        try:
            issued_at = int(parts[0])
        except (TypeError, ValueError):
            return False
        current = int(time.time() if now is None else now)
        if issued_at > current + 60 or current - issued_at > self.ttl_seconds:
            return False
        payload = f"{issued_at}.{parts[1]}".encode("utf-8")
        try:
            supplied = parts[2].encode("ascii")
        except UnicodeEncodeError:
            return False
        expected = base64.urlsafe_b64encode(
            hmac.new(self._secret, payload, hashlib.sha256).digest()
        ).decode("ascii").rstrip("=").encode("ascii")
        return hmac.compare_digest(supplied, expected)
