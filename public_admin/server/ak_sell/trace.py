from __future__ import annotations

import re
import uuid
from datetime import datetime, time, timedelta, timezone
from typing import Any


AK_SELL_TRACE_HEADER = "x-ak-sell-trace-id"
BEIJING_TIMEZONE = timezone(timedelta(hours=8))
TRACE_WINDOW_START = time(12, 0, 0)
TRACE_WINDOW_END = time(12, 5, 0)

_NOT_SENT_ERROR_NAMES = frozenset({
    "ConnectError",
    "ConnectTimeout",
    "ProxyError",
    "UnsupportedProtocol",
    "InvalidURL",
})
_UNCERTAIN_DELIVERY_ERROR_NAMES = frozenset({
    "ReadError",
    "ReadTimeout",
    "WriteError",
    "WriteTimeout",
    "RemoteProtocolError",
})

_TRACE_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")


def is_trace_window(now: datetime | None = None) -> bool:
    current = now or datetime.now(BEIJING_TIMEZONE)
    if current.tzinfo is None:
        current = current.replace(tzinfo=BEIJING_TIMEZONE)
    current = current.astimezone(BEIJING_TIMEZONE).time()
    return TRACE_WINDOW_START <= current < TRACE_WINDOW_END


def create_trace_id_if_needed() -> str:
    if not is_trace_window():
        return ""
    return "ak-sell-" + uuid.uuid4().hex[:16]


def normalize_trace_id(value: Any) -> str:
    text = str(value or "").strip()
    if not text or not _TRACE_ID_RE.match(text):
        return ""
    return text


def emit_trace(logger, stage: str, trace_id: str, **fields: Any) -> None:
    trace_id = normalize_trace_id(trace_id)
    if not trace_id or logger is None:
        return
    safe_fields = []
    for key in sorted(fields):
        name = _safe_key(key)
        if not name:
            continue
        limit = 1000 if name == "exception_chain" else 180
        safe_fields.append(f"{name}={_safe_value(fields[key], limit=limit)}")
    suffix = " " + " ".join(safe_fields) if safe_fields else ""
    logger.info("[AKSellTrace] trace_id=%s stage=%s%s", trace_id, _safe_key(stage) or "unknown", suffix)


def classify_delivery_state(exc: BaseException | None) -> str:
    """Classify transport failures without claiming whether the upstream committed a write."""
    if exc is None:
        return "response_received"
    name = exc.__class__.__name__
    if name in _UNCERTAIN_DELIVERY_ERROR_NAMES:
        return "uncertain_delivery"
    if name in _NOT_SENT_ERROR_NAMES:
        return "not_sent"
    return "unknown_delivery"


def exception_snapshot(exc: BaseException | None) -> dict[str, str]:
    """Return bounded, credential-free exception details for logs and diagnostics.

    httpx commonly wraps the useful socket/anyio exception one or more levels
    below ``ReadError``.  Keep the old first-cause fields for compatibility,
    but also persist the complete bounded chain and request-client state.
    """
    if exc is None:
        return {}
    chain = _exception_chain(exc)
    cause = chain[1] if len(chain) > 1 else None
    snapshot = {
        "exception_type": exc.__class__.__name__,
        "exception_repr": _safe_value(repr(exc)),
        "cause_type": cause.__class__.__name__ if cause is not None else "",
        "cause_repr": _safe_value(repr(cause)) if cause is not None else "",
        "exception_chain": _safe_value(" <- ".join(
            f"{item.__class__.__name__}:{repr(item)}" for item in chain
        ), limit=1000),
    }
    # Preserve errno/socket details when the nested exception exposes them.
    os_error = next((item for item in chain[1:] if isinstance(item, OSError)), None)
    if os_error is not None:
        snapshot["cause_errno"] = str(getattr(os_error, "errno", "") or "")
        snapshot["cause_strerror"] = _safe_value(getattr(os_error, "strerror", "") or "")

    client_state = getattr(exc, "_ak_client_state", None)
    if isinstance(client_state, dict):
        for key in (
            "client_closed", "client_retired", "client_current", "client_generation",
            "active_requests", "retire_pending", "retire_reason",
        ):
            if key in client_state:
                snapshot[key] = _safe_value(client_state[key])
        if client_state.get("client_closed") or client_state.get("client_retired"):
            snapshot["transport_origin"] = "local_client_close"
        elif exc.__class__.__name__ in _UNCERTAIN_DELIVERY_ERROR_NAMES:
            snapshot["transport_origin"] = "remote_or_tunnel"
        else:
            snapshot["transport_origin"] = "unknown"
    elif exc.__class__.__name__ in _UNCERTAIN_DELIVERY_ERROR_NAMES:
        snapshot["transport_origin"] = "unknown"
    return snapshot


def _exception_chain(exc: BaseException, max_depth: int = 8) -> list[BaseException]:
    chain: list[BaseException] = []
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and len(chain) < max_depth and id(current) not in seen:
        seen.add(id(current))
        chain.append(current)
        current = current.__cause__ or current.__context__
    return chain


def _safe_key(value: Any) -> str:
    return re.sub(r"[^A-Za-z0-9_.:-]+", "_", str(value or "").strip())[:64]


def _safe_value(value: Any, *, limit: int = 180) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value or "").replace("\n", " ").replace("\r", " ").strip()
    text = re.sub(r"\s+", " ", text)
    return text[:limit] if text else "-"
