from __future__ import annotations

from .config import (
    AK_SELL_READ_REQUEST_TIMEOUT,
    AK_SELL_WRITE_REQUEST_TIMEOUT,
    LOGIN_REQUEST_TIMEOUT,
    NOTICE_GUIDANCE_CONNECT_TIMEOUT,
    NOTICE_GUIDANCE_REQUEST_TIMEOUT,
    REQUEST_TIMEOUT,
    RPC_CONNECT_TIMEOUT,
)


REGULAR_RPC_TIMEOUT_SECONDS = max(0.1, float(REQUEST_TIMEOUT or 20.0))
LOGIN_RPC_TIMEOUT_SECONDS = max(REGULAR_RPC_TIMEOUT_SECONDS, float(LOGIN_REQUEST_TIMEOUT or 20.0))
RPC_CONNECT_TIMEOUT_SECONDS = max(0.1, float(RPC_CONNECT_TIMEOUT or 3.0))
NOTICE_GUIDANCE_REQUEST_TIMEOUT_SECONDS = max(0.1, float(NOTICE_GUIDANCE_REQUEST_TIMEOUT or 20.0))
NOTICE_GUIDANCE_CONNECT_TIMEOUT_SECONDS = max(
    0.1,
    float(NOTICE_GUIDANCE_CONNECT_TIMEOUT or 1.0),
)
AK_SELL_READ_TIMEOUT_SECONDS = max(0.1, float(AK_SELL_READ_REQUEST_TIMEOUT or 20.0))
AK_SELL_WRITE_TIMEOUT_SECONDS = max(0.1, float(AK_SELL_WRITE_REQUEST_TIMEOUT or 20.0))
# Browser-originated sell requests should be allowed to outlive the internal
# automated-sell budget. Nginx uses the same 30-second boundary.
PUBLIC_AK_SELL_FORWARD_TIMEOUT_SECONDS = 30.0


_AK_SELL_WRITE_OPERATIONS = frozenset({
    "submit",
    "google-bind",
    "google-unbind",
    "ace-sell",
    "ace-sell-son",
})


def normalize_rpc_api_path(api_path: str) -> str:
    path = str(api_path or "").strip().lower()
    if path.startswith("/rpc/"):
        path = path[5:]
    elif path.startswith("rpc/"):
        path = path[4:]
    return path.strip("/")


def resolve_rpc_forward_timeout(api_path: str = "", *, is_login: bool = False) -> float:
    if is_login or normalize_rpc_api_path(api_path) == "login":
        return LOGIN_RPC_TIMEOUT_SECONDS
    return REGULAR_RPC_TIMEOUT_SECONDS


def resolve_ak_sell_forward_timeout(api_path: str = "") -> float:
    """Keep read RPCs responsive while allowing the non-replayable submit to wait."""
    operation = normalize_rpc_api_path(api_path).replace("_", "-")
    return AK_SELL_WRITE_TIMEOUT_SECONDS if operation in _AK_SELL_WRITE_OPERATIONS else AK_SELL_READ_TIMEOUT_SECONDS


def resolve_public_ak_sell_forward_timeout(api_path: str = "") -> float | None:
    """Return the browser sell deadline; leave other public RPCs unchanged."""
    operation = normalize_rpc_api_path(api_path).replace("_", "-")
    if operation in {"ace-sell", "ace-sell-son"}:
        return PUBLIC_AK_SELL_FORWARD_TIMEOUT_SECONDS
    return None


def resolve_ak_sell_response_timeout(operation: str = "") -> float:
    """Leave a small local-proxy margin around the upstream attempt budget."""
    upstream_timeout = resolve_ak_sell_forward_timeout(operation)
    return upstream_timeout + 1.0


def resolve_connect_timeout(total_timeout_seconds: float, *, connect_timeout_seconds: float | None = None) -> float:
    total_timeout = max(0.1, float(total_timeout_seconds or 0.0))
    connect_timeout = max(
        0.1,
        float(
            RPC_CONNECT_TIMEOUT_SECONDS
            if connect_timeout_seconds is None
            else connect_timeout_seconds
        ),
    )
    return min(total_timeout, connect_timeout)
