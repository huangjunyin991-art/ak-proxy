from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any


MASKED_CREDENTIAL = "***"
SET_CREDENTIAL_HINT = "已设置"

SENSITIVE_CREDENTIAL_KEYWORDS = (
    "password",
    "passwd",
    "pwd",
    "token",
    "authorization",
    "cookie",
    "secret",
    "userkey",
    "user_key",
    "ak_userkey",
    "session_key",
    "admin_key",
    "license_admin_key",
)


def has_credential(value: Any) -> bool:
    return value not in (None, "")


def is_credential_key(key: Any) -> bool:
    normalized = str(key or "").strip().lower()
    return any(item in normalized for item in SENSITIVE_CREDENTIAL_KEYWORDS)


def mask_credential(value: Any, *, empty: str = "") -> str:
    return MASKED_CREDENTIAL if has_credential(value) else empty


def credential_hint(value: Any, *, empty: str = "") -> str:
    return SET_CREDENTIAL_HINT if has_credential(value) else empty


def sanitize_credential_mapping(value: Any, *, max_list_items: int = 50) -> Any:
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for key, item in value.items():
            string_key = str(key)
            if is_credential_key(string_key):
                result[f"has_{string_key.lower()}"] = has_credential(item)
                result[string_key] = mask_credential(item)
            else:
                result[string_key] = sanitize_credential_mapping(item, max_list_items=max_list_items)
        return result
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [sanitize_credential_mapping(item, max_list_items=max_list_items) for item in list(value)[:max_list_items]]
    return value
