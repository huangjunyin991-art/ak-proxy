from __future__ import annotations

from collections.abc import Mapping
from typing import Any

_MISSING = object()


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


def _raw_value(payload: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in payload:
            return payload[name]
    folded = {str(key).casefold(): value for key, value in payload.items()}
    for name in names:
        folded_value = folded.get(name.casefold(), _MISSING)
        if folded_value is not _MISSING:
            return folded_value
    return _MISSING


def _false_like(value: Any) -> bool:
    if value is False:
        return True
    if isinstance(value, str):
        return value.strip().casefold() in {"false", "0", "no", "否"}
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value == 0
    return False


def _true_like(value: Any) -> bool:
    if value is True:
        return True
    if isinstance(value, str):
        return value.strip().casefold() in {"true", "1", "yes", "是"}
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value == 1
    return False


def parse_success_payload(payload: Mapping[str, Any] | None) -> tuple[bool, str]:
    source = payload if isinstance(payload, Mapping) else {}
    error_value = _raw_value(source, "Error", "error")
    success_value = _raw_value(source, "success", "Success")
    success = _false_like(error_value) or _true_like(success_value)
    return success, _value(source, "Msg", "message", "Message")


def success_state(payload: Mapping[str, Any] | None) -> str:
    source = payload if isinstance(payload, Mapping) else {}
    error_value = _raw_value(source, "Error", "error")
    success_value = _raw_value(source, "success", "Success")
    if _false_like(error_value) or _true_like(success_value):
        return "success"
    if error_value is not _MISSING or success_value is not _MISSING:
        return "rejected"
    return "unknown"


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
    confirmation_method: str = "upstream_response",
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
        "confirmation_method": _text(confirmation_method) or "upstream_response",
        "upstream_payload": sanitize_payload(payload),
    }


def build_attempt_record(
    *,
    event_id: str,
    trace_id: str = "",
    request_id: str = "",
    account: str = "",
    endpoint: str = "",
    request_data: Mapping[str, Any] | None = None,
    payload: Mapping[str, Any] | None = None,
    source: str = "",
    state: str = "",
    message: str = "",
    confirmation_method: str = "",
    status_code: int | None = None,
    exit_name: str = "",
    upstream_ms: int | None = None,
    response_bytes: int | None = None,
    last_stage: str = "",
    diagnostics: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    data = request_data if isinstance(request_data, Mapping) else {}
    payload_source = payload if isinstance(payload, Mapping) else {}
    sub_id = _value(data, "sonId", "son_id", "sub_account_id")
    sub_name = _value(data, "subAccountName", "sub_account_name", "sonName", "son_name")
    amount = _value(data, "count", "amount")
    detected_state = success_state(payload_source)
    final_state = _text(state) or detected_state
    final_message = _text(message) or _value(payload_source, "Msg", "message", "Message")
    return {
        "event_id": _text(event_id),
        "trace_id": _text(trace_id),
        "request_id": _text(request_id),
        "account": _text(account).lower(),
        "sub_account_id": sub_id,
        "sub_account_name": sub_name,
        "amount": amount,
        "endpoint": _text(endpoint),
        "source": _text(source) or "unknown",
        "state": final_state or "unknown",
        "message": final_message,
        "confirmation_method": _text(confirmation_method),
        "status_code": status_code,
        "exit_name": _text(exit_name),
        "upstream_ms": upstream_ms,
        "response_bytes": response_bytes,
        "last_stage": _text(last_stage),
        "diagnostics": sanitize_payload(diagnostics),
        "request_snapshot": sanitize_payload(data),
        "upstream_payload": sanitize_payload(payload_source),
    }
