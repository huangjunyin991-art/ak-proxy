from __future__ import annotations

import base64
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from public_admin.deploy.env.ensure_env import EnvFile, ensure_env


PRIVATE_KEY_ENV = "LICENSE_AUTO_SELL_SIGNING_PRIVATE_KEY"
PUBLIC_KEY_ENV = "LICENSE_AUTO_SELL_SIGNING_PUBLIC_KEY"
KEY_ID_ENV = "LICENSE_AUTO_SELL_SIGNING_KEY_ID"
DEFAULT_KEY_ID = "ak-auto-sell-v1"
DEFAULT_ENV_FILE = "/etc/ak-proxy.env"


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


def _unquote_env_value(value: str) -> str:
    text = str(value or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        return text[1:-1]
    return text


def ensure_auto_sell_signing_private_key() -> str:
    """Generate the deployment signing key once, without replacing an existing value."""
    configured = str(os.environ.get(PRIVATE_KEY_ENV) or "").strip()
    if configured:
        return configured
    if PRIVATE_KEY_ENV in os.environ:
        raise RuntimeError(f"{PRIVATE_KEY_ENV} is explicitly empty")

    env_file = Path(os.environ.get("AK_PROXY_ENV_FILE") or DEFAULT_ENV_FILE)
    saved_env = EnvFile(str(env_file))
    if saved_env.has(PRIVATE_KEY_ENV) and not _unquote_env_value(saved_env.get(PRIVATE_KEY_ENV)):
        raise RuntimeError(f"{PRIVATE_KEY_ENV} is explicitly empty")
    ensure_env(str(env_file), only_keys={PRIVATE_KEY_ENV})
    persisted = _unquote_env_value(EnvFile(str(env_file)).get(PRIVATE_KEY_ENV))
    if not persisted:
        raise RuntimeError(f"missing {PRIVATE_KEY_ENV} after deployment initialization")
    os.environ[PRIVATE_KEY_ENV] = persisted
    return persisted


class OfflineAuthorizationSigner:
    """Issues compact Ed25519 credentials for the auto-sell client to verify offline."""

    def __init__(
        self,
        private_key_b64: str = "",
        public_key_b64: str = "",
        key_id: str = "",
        configuration_error: str = "",
    ) -> None:
        self._private_key_b64 = str(private_key_b64 or "").strip()
        self._public_key_b64 = str(public_key_b64 or "").strip()
        self.key_id = str(key_id or DEFAULT_KEY_ID).strip() or DEFAULT_KEY_ID
        self._configuration_error = str(configuration_error or "").strip()

    @classmethod
    def from_env(cls) -> "OfflineAuthorizationSigner":
        configuration_error = ""
        try:
            ensure_auto_sell_signing_private_key()
        except Exception as exc:
            configuration_error = str(exc or "offline authorization deployment initialization failed")
        return cls(
            private_key_b64=os.environ.get(PRIVATE_KEY_ENV, ""),
            public_key_b64=os.environ.get(PUBLIC_KEY_ENV, ""),
            key_id=os.environ.get(KEY_ID_ENV, ""),
            configuration_error=configuration_error,
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
        if self._configuration_error:
            raise RuntimeError(self._configuration_error)
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
