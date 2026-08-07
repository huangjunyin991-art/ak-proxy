from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def _text(value: Any) -> str:
    return str(value or "").strip()


def _value(payload: Mapping[str, Any], *names: str) -> str:
    for name in names:
        value = payload.get(name)
        if value is not None and _text(value):
            return _text(value)
    folded = {str(key).casefold(): value for key, value in payload.items()}
    for name in names:
        value = folded.get(name.casefold())
        if value is not None and _text(value):
            return _text(value)
    return ""


def parse_success_payload(payload: Mapping[str, Any] | None) -> tuple[bool, str]:
    source = payload if isinstance(payload, Mapping) else {}
    return source.get("Error") is False, _value(source, "Msg", "message", "Message")


def sanitize_payload(payload: Mapping[str, Any] | None) -> dict[str, Any]:
    """Keep only a small, non-sensitive snapshot of the upstream response."""
    source = payload if isinstance(payload, Mapping) else {}
    def sensitive_key(key: Any) -> bool:
        name = str(key).casefold().replace("_", "")
        return (
            name in {"key", "userkey", "sokey", "gcode", "password", "pin"}
            or any(marker in name for marker in ("password", "cookie", "token", "mnemonic", "secret"))
        )

    def clean(value: Any, depth: int = 0) -> Any:
        if depth > 3:
            return "[truncated]"
        if isinstance(value, Mapping):
            return {
                str(key): clean(item, depth + 1)
                for key, item in value.items()
                if not sensitive_key(key)
            }
        if isinstance(value, list):
            return [clean(item, depth + 1) for item in value[:20]]
        if isinstance(value, (str, int, float, bool)) or value is None:
            text = str(value) if isinstance(value, str) else value
            return text[:1000] if isinstance(text, str) else text
        return str(value)[:1000]

    return clean(source)


def build_record(
    *,
    account: str,
    endpoint: str,
    request_data: Mapping[str, Any] | None,
    payload: Mapping[str, Any] | None,
    source: str,
    request_id: str = "",
) -> dict[str, Any] | None:
    success, message = parse_success_payload(payload)
    if not success:
        return None
    data = request_data if isinstance(request_data, Mapping) else {}
    sub_id = _value(data, "sonId", "son_id")
    sub_name = _value(data, "subAccountName", "sub_account_name", "sonName", "son_name")
    amount = _value(data, "count", "amount")
    return {
        "account": _text(account).lower(),
        "sub_account_id": sub_id,
        "sub_account_name": sub_name,
        "amount": amount,
        "endpoint": _text(endpoint),
        "message": message,
        "source": _text(source) or "unknown",
        "request_id": _text(request_id),
        "upstream_payload": sanitize_payload(payload),
    }
