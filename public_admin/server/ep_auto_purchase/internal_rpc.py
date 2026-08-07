from __future__ import annotations

import hmac
import os
import secrets
from collections.abc import Mapping


EP_AUTO_PURCHASE_INTERNAL_HEADER = "x-ak-ep-auto-purchase-job"
# The worker runs beside the proxy. Keep the request on loopback so it enters
# the same RPC dispatcher without adding a public DNS/TLS/Nginx hairpin.
DEFAULT_EP_AUTO_PURCHASE_RPC_BASE_URL = "http://127.0.0.1:8080/RPC/"


def create_internal_rpc_token() -> str:
    return secrets.token_urlsafe(32)


def resolve_nginx_rpc_base_url(base_url: str | None = None) -> str:
    value = str(
        base_url
        or os.getenv("AK_PROXY_EP_AUTO_PURCHASE_RPC_BASE_URL")
        or DEFAULT_EP_AUTO_PURCHASE_RPC_BASE_URL
    ).strip()
    if not value:
        value = DEFAULT_EP_AUTO_PURCHASE_RPC_BASE_URL
    return value if value.endswith("/") else value + "/"


def is_trusted_internal_rpc_request(
    headers: Mapping[str, str],
    client_host: str,
    expected_token: str,
) -> bool:
    supplied_token = str(headers.get(EP_AUTO_PURCHASE_INTERNAL_HEADER) or "").strip()
    expected = str(expected_token or "").strip()
    return bool(
        expected
        and supplied_token
        and str(client_host or "").strip() in {"127.0.0.1", "::1"}
        and hmac.compare_digest(supplied_token, expected)
    )
