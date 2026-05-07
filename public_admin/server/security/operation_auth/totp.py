import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote


class TotpProvider:
    def __init__(self, digits: int = 6, period_seconds: int = 30, algorithm=hashlib.sha1):
        self.digits = digits
        self.period_seconds = period_seconds
        self.algorithm = algorithm

    def generate_secret(self) -> str:
        raw = secrets.token_bytes(20)
        return base64.b32encode(raw).decode('ascii').rstrip('=')

    def code_at(self, secret: str, timestamp: int | None = None) -> str:
        counter = int((timestamp if timestamp is not None else time.time()) // self.period_seconds)
        key = self._decode_secret(secret)
        payload = struct.pack('>Q', counter)
        digest = hmac.new(key, payload, self.algorithm).digest()
        offset = digest[-1] & 0x0F
        value = struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7FFFFFFF
        return str(value % (10 ** self.digits)).zfill(self.digits)

    def verify(self, secret: str, code: str, window: int = 1) -> bool:
        normalized = ''.join(ch for ch in str(code or '') if ch.isdigit())
        if len(normalized) != self.digits:
            return False
        now = int(time.time())
        for step in range(-window, window + 1):
            candidate_time = now + step * self.period_seconds
            if hmac.compare_digest(self.code_at(secret, candidate_time), normalized):
                return True
        return False

    def otpauth_uri(self, issuer: str, account_name: str, secret: str) -> str:
        label = f"{issuer}:{account_name}"
        return (
            f"otpauth://totp/{quote(label)}"
            f"?secret={quote(secret)}&issuer={quote(issuer)}&digits={self.digits}&period={self.period_seconds}"
        )

    def _decode_secret(self, secret: str) -> bytes:
        normalized = ''.join(str(secret or '').strip().upper().split())
        padding = '=' * ((8 - len(normalized) % 8) % 8)
        return base64.b32decode(normalized + padding, casefold=True)
