from __future__ import annotations

import hmac
import secrets
from collections.abc import Mapping


AK_SELL_INTERNAL_RPC_HEADER = "x-ak-sell-internal"


def create_internal_rpc_token() -> str:
    return secrets.token_urlsafe(32)


def is_trusted_internal_rpc_request(
    headers: Mapping[str, str],
    client_host: str,
    expected_token: str,
) -> bool:
    supplied_token = str(headers.get(AK_SELL_INTERNAL_RPC_HEADER) or "").strip()
    expected = str(expected_token or "").strip()
    return bool(
        expected
        and supplied_token
        and str(client_host or "").strip() in {"127.0.0.1", "::1"}
        and hmac.compare_digest(supplied_token, expected)
    )
