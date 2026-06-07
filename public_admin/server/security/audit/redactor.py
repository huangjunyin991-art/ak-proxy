import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from typing import Any


_SENSITIVE_KEYWORDS = (
    "password",
    "passwd",
    "pwd",
    "token",
    "authorization",
    "cookie",
    "secret",
    "code",
    "totp",
    "otp",
    "recovery",
    "userkey",
    "user_key",
    "ak_userkey",
    "session_key",
    "admin_key",
    "license_admin_key",
    "key",
)

_JSON_STRING_FIELD_RE = re.compile(
    r'(?i)("?(?:password|passwd|pwd|token|authorization|cookie|secret|code|totp|otp|recovery|userkey|user_key|ak_userkey|session_key|admin_key|license_admin_key|key)"?\s*[:=]\s*)"([^"\\]*(?:\\.[^"\\]*)*)"'
)
_QUERY_FIELD_RE = re.compile(
    r"(?i)([?&;\s](?:password|passwd|pwd|token|authorization|cookie|secret|code|totp|otp|recovery|userkey|user_key|ak_userkey|session_key|admin_key|license_admin_key|key)=)[^&;\s]+"
)


def is_sensitive_key(key: Any) -> bool:
    normalized = str(key or "").strip().lower()
    return any(item in normalized for item in _SENSITIVE_KEYWORDS)


def fingerprint_log_secret(value: Any, length: int = 12) -> str:
    text = str(value or "")
    if not text:
        return "-"
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:length]


def redact_log_text(value: Any, limit: int = 240) -> str:
    text = str(value or "")
    if not text:
        return ""
    text = _JSON_STRING_FIELD_RE.sub(r'\1"<redacted>"', text)
    text = _QUERY_FIELD_RE.sub(r"\1<redacted>", text)
    text = text.replace("\r", "\\r").replace("\n", "\\n")
    if limit > 0 and len(text) > limit:
        return text[:limit] + "...<truncated>"
    return text


def redact_log_value(value: Any, max_string: int = 160) -> Any:
    if isinstance(value, Mapping):
        result = {}
        for key, item in value.items():
            string_key = str(key)
            result[string_key] = "<redacted>" if is_sensitive_key(string_key) else redact_log_value(item, max_string=max_string)
        return result
    if isinstance(value, (str, bytes, bytearray)):
        if isinstance(value, (bytes, bytearray)):
            text = bytes(value).decode("utf-8", errors="replace")
        else:
            text = value
        return redact_log_text(text, limit=max_string)
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [redact_log_value(item, max_string=max_string) for item in list(value)[:20]]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return redact_log_text(value, limit=max_string)


def format_redacted_log_json(value: Any, max_string: int = 160) -> str:
    try:
        return json.dumps(redact_log_value(value, max_string=max_string), ensure_ascii=False, sort_keys=True)
    except Exception:
        return redact_log_text(value, limit=max_string)


def summarize_log_payload(value: Any, label: str = "body") -> str:
    if isinstance(value, (bytes, bytearray)):
        data = bytes(value)
    elif isinstance(value, str):
        data = value.encode("utf-8", errors="replace")
    else:
        try:
            data = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8", errors="replace")
        except Exception:
            data = str(value or "").encode("utf-8", errors="replace")
    digest = hashlib.sha256(data).hexdigest()[:16] if data else "-"
    return f"{label}_len={len(data)} {label}_sha256={digest}"
