from __future__ import annotations

import os


DEFAULT_AK_SELL_RPC_BASE_URL = "https://ak2025.vip/RPC/"


def resolve_nginx_rpc_base_url(base_url: str | None = None) -> str:
    value = str(
        base_url
        or os.getenv("AK_PROXY_AK_SELL_RPC_BASE_URL")
        or DEFAULT_AK_SELL_RPC_BASE_URL
    ).strip()
    if not value:
        value = DEFAULT_AK_SELL_RPC_BASE_URL
    return value if value.endswith("/") else value + "/"
