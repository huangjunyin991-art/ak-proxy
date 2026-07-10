from __future__ import annotations

from .config import (
    LOGIN_REQUEST_TIMEOUT,
    NOTICE_GUIDANCE_CONNECT_TIMEOUT,
    NOTICE_GUIDANCE_REQUEST_TIMEOUT,
    REQUEST_TIMEOUT,
    RPC_CONNECT_TIMEOUT,
)


REGULAR_RPC_TIMEOUT_SECONDS = max(0.1, float(REQUEST_TIMEOUT or 5.0))
LOGIN_RPC_TIMEOUT_SECONDS = max(REGULAR_RPC_TIMEOUT_SECONDS, float(LOGIN_REQUEST_TIMEOUT or 10.0))
RPC_CONNECT_TIMEOUT_SECONDS = max(0.1, float(RPC_CONNECT_TIMEOUT or 3.0))
NOTICE_GUIDANCE_REQUEST_TIMEOUT_SECONDS = max(0.1, float(NOTICE_GUIDANCE_REQUEST_TIMEOUT or 8.0))
NOTICE_GUIDANCE_CONNECT_TIMEOUT_SECONDS = max(
    0.1,
    float(NOTICE_GUIDANCE_CONNECT_TIMEOUT or 1.0),
)


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
