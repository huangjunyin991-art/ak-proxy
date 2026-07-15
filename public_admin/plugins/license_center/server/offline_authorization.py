from __future__ import annotations

import base64
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any


PRIVATE_KEY_ENV = "LICENSE_AUTO_SELL_SIGNING_PRIVATE_KEY"
PUBLIC_KEY_ENV = "LICENSE_AUTO_SELL_SIGNING_PUBLIC_KEY"
KEY_ID_ENV = "LICENSE_AUTO_SELL_SIGNING_KEY_ID"
DEFAULT_KEY_ID = "ak-auto-sell-v1"


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    text = str(value or "").strip().encode("ascii")
    return base64.urlsafe_b64decode(text + b"=" * (-len(text) % 4))


def _raw_public_key(public_key) -> bytes:
    from cryptography.hazmat.primitives import serialization

    return public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )


class OfflineAuthorizationSigner:
    """Issues compact Ed25519 credentials for the auto-sell client to verify offline."""

    def __init__(self, private_key_b64: str = "", public_key_b64: str = "", key_id: str = "") -> None:
        self._private_key_b64 = str(private_key_b64 or "").strip()
        self._public_key_b64 = str(public_key_b64 or "").strip()
        self.key_id = str(key_id or DEFAULT_KEY_ID).strip() or DEFAULT_KEY_ID

    @classmethod
    def from_env(cls) -> "OfflineAuthorizationSigner":
        return cls(
            private_key_b64=os.environ.get(PRIVATE_KEY_ENV, ""),
            public_key_b64=os.environ.get(PUBLIC_KEY_ENV, ""),
            key_id=os.environ.get(KEY_ID_ENV, ""),
        )

    def public_key(self) -> str:
        private_key, _ = self._load_keys()
        return _b64url_encode(_raw_public_key(private_key.public_key()))

    def issue(
        self,
        *,
        product_id: str,
        license_key: str,
        machine_id: str,
        issued_at: datetime | None = None,
        ttl_seconds: int,
    ) -> tuple[str, dict[str, Any]]:
        private_key, _ = self._load_keys()
        issued = issued_at or datetime.now(timezone.utc)
        if issued.tzinfo is not None:
            issued = issued.astimezone(timezone.utc).replace(tzinfo=None)
        expires = issued + timedelta(seconds=max(1, int(ttl_seconds)))
        payload = {
            "v": 1,
            "kid": self.key_id,
            "product_id": str(product_id or ""),
            "license_key": str(license_key or ""),
            "machine_id": str(machine_id or ""),
            "jti": secrets.token_urlsafe(12),
            "issued_at": issued.replace(microsecond=0).isoformat() + "Z",
            "expires_at": expires.replace(microsecond=0).isoformat() + "Z",
        }
        header = {"alg": "EdDSA", "kid": self.key_id, "typ": "AK-AUTH"}
        signing_input = ".".join((
            _b64url_encode(json.dumps(header, sort_keys=True, separators=(",", ":")).encode("utf-8")),
            _b64url_encode(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")),
        ))
        signature = private_key.sign(signing_input.encode("ascii"))
        return signing_input + "." + _b64url_encode(signature), payload

    def _load_keys(self):
        if not self._private_key_b64:
            raise RuntimeError(f"missing {PRIVATE_KEY_ENV}")
        try:
            from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

            private_key = Ed25519PrivateKey.from_private_bytes(_b64url_decode(self._private_key_b64))
        except ImportError as exc:
            raise RuntimeError("cryptography is unavailable") from exc
        except Exception as exc:
            raise RuntimeError(f"invalid {PRIVATE_KEY_ENV}") from exc
        derived_public_key = _b64url_encode(_raw_public_key(private_key.public_key()))
        if self._public_key_b64 and self._public_key_b64 != derived_public_key:
            raise RuntimeError(f"{PUBLIC_KEY_ENV} does not match {PRIVATE_KEY_ENV}")
        return private_key, derived_public_key
