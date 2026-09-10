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

_CONNECT_ERROR_NAMES = frozenset({
    "ConnectError",
    "ConnectTimeout",
    "ProxyError",
    "UnsupportedProtocol",
    "InvalidURL",
})
_WRITE_ERROR_NAMES = frozenset({"WriteError", "WriteTimeout"})
_READ_ERROR_NAMES = frozenset({"ReadError", "ReadTimeout", "SSLWantReadError"})

_TRACE_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
_HTTP_TRACE_PHASES = (
    "connect_tcp",
    "start_tls",
    "send_request_headers",
    "send_request_body",
    "receive_response_headers",
    "receive_response_body",
    "response_closed",
)
_HTTP_TRACE_SUFFIXES = ("started_ms", "completed_ms", "failed_ms", "ms", "error")
_HTTP_TRACE_DERIVED_FIELDS = (
    "request_sent_ms",
    "response_headers_wait_ms",
    "transport_total_ms",
)


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


def exception_snapshot(exc: BaseException | None) -> dict[str, Any]:
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
        "transport_phase": transport_phase(exc),
    }
    # Preserve errno/socket details when the nested exception exposes them.
    os_error = next((item for item in chain[1:] if isinstance(item, OSError)), None)
    if os_error is not None:
        snapshot["cause_errno"] = str(getattr(os_error, "errno", "") or "")
        snapshot["cause_strerror"] = _safe_value(getattr(os_error, "strerror", "") or "")

    client_state = getattr(exc, "_ak_client_state", None)
    timeout_scope = str(getattr(exc, "_ak_timeout_scope", "") or "").strip()
    if timeout_scope:
        snapshot["timeout_scope"] = timeout_scope
        snapshot["deadline_seconds"] = _safe_value(getattr(exc, "_ak_deadline_seconds", ""))
    if hasattr(exc, "_ak_cancel_pending"):
        snapshot["cancel_pending"] = _safe_value(getattr(exc, "_ak_cancel_pending"))
    if isinstance(client_state, dict):
        for key in (
            "client_closed", "client_retired", "client_current", "client_generation",
            "active_requests", "retire_pending", "retire_reason",
        ):
            if key in client_state:
                snapshot[key] = _safe_value(client_state[key])
        if client_state.get("client_closed"):
            snapshot["transport_origin"] = "local_client_close"
        elif client_state.get("client_retired"):
            snapshot["transport_origin"] = "retired_but_open"
        elif exc.__class__.__name__ in _UNCERTAIN_DELIVERY_ERROR_NAMES:
            snapshot["transport_origin"] = "remote_or_tunnel"
        else:
            snapshot["transport_origin"] = "unknown"
    elif exc.__class__.__name__ in _UNCERTAIN_DELIVERY_ERROR_NAMES:
        snapshot["transport_origin"] = "unknown"
    http_trace = getattr(exc, "_ak_http_trace", None)
    if isinstance(http_trace, dict):
        flattened_trace = transport_trace_snapshot(http_trace)
        snapshot["http_trace"] = flattened_trace
        # Keep each phase independently queryable and prevent the logger's
        # bounded rendering of the compatibility dictionary from hiding the
        # later send/receive fields.
        snapshot.update(flattened_trace)
    return snapshot


def finalize_transport_trace(http_trace: dict[str, Any] | None, elapsed_ms: int) -> dict[str, Any]:
    """Add credential-free derived timings to a raw httpcore trace."""
    trace = transport_trace_snapshot(http_trace)
    total_ms = max(0, int(elapsed_ms or 0))
    trace["transport_total_ms"] = total_ms

    sent_candidates = (
        trace.get("send_request_headers_completed_ms"),
        trace.get("send_request_body_completed_ms"),
    )
    sent_values = [value for value in sent_candidates if isinstance(value, int)]
    if sent_values:
        trace["request_sent_ms"] = max(sent_values)

    response_wait_started = trace.get("receive_response_headers_started_ms")
    if isinstance(response_wait_started, int):
        response_wait_ended = trace.get("receive_response_headers_completed_ms")
        if not isinstance(response_wait_ended, int):
            response_wait_ended = total_ms
        trace["response_headers_wait_ms"] = max(0, response_wait_ended - response_wait_started)
    return trace


def transport_trace_snapshot(http_trace: dict[str, Any] | None) -> dict[str, Any]:
    """Return only stable, credential-free HTTP transport timing fields."""
    if not isinstance(http_trace, dict):
        return {}
    allowed = {
        f"{phase}_{suffix}"
        for phase in _HTTP_TRACE_PHASES
        for suffix in _HTTP_TRACE_SUFFIXES
    }
    allowed.update(_HTTP_TRACE_DERIVED_FIELDS)
    return {
        str(key): value
        for key, value in http_trace.items()
        if str(key) in allowed and isinstance(value, (str, int, float, bool))
    }


def resolve_attempt_exit_name(carrier: Any, fallback: Any = None) -> str:
    """Resolve the exit that produced a response/error after fallback attempts."""
    extensions = getattr(carrier, "extensions", None)
    extension_name = extensions.get("ak_exit_name") if isinstance(extensions, dict) else ""
    return str(
        getattr(carrier, "_ak_exit_name", "")
        or extension_name
        or getattr(fallback, "name", "")
        or ""
    )


def transport_phase(exc: BaseException | None) -> str:
    """Infer the furthest observable HTTP transport phase from an exception chain.

    This is deliberately a transport observation, not a claim that the upstream
    application committed a state-changing request.
    """
    if exc is None:
        return "response"
    explicit = str(getattr(exc, "_ak_transport_phase", "") or "").strip()
    if explicit:
        return explicit
    chain = _exception_chain(exc)
    names = [item.__class__.__name__ for item in chain]
    if any(name in _CONNECT_ERROR_NAMES for name in names):
        return "connect"
    if any(name in _WRITE_ERROR_NAMES for name in names):
        return "write"
    if any(name in {"RemoteProtocolError", "LocalProtocolError"} for name in names):
        return "protocol"
    if any(name in _READ_ERROR_NAMES for name in names):
        return "read"
    if any(name in {"TimeoutError", "CancelledError"} for name in names):
        return "unknown"
    return "unknown"


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
