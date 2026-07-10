from __future__ import annotations

from datetime import datetime
from typing import Any

import httpx

from ..rpc_timeout_policy import (
    NOTICE_GUIDANCE_CONNECT_TIMEOUT_SECONDS,
    NOTICE_GUIDANCE_REQUEST_TIMEOUT_SECONDS,
    resolve_connect_timeout,
)
from ..security.upstream_http import resolve_upstream_tls_verify

DEFAULT_BASE_URL = "http://127.0.0.1:8080/RPC/"
DEFAULT_PAGE_SIZE = 15


def make_v() -> str:
    now = datetime.now()
    return str(now.year + now.month + now.day + now.hour + now.minute)


def normalize_base_url(base_url: str) -> str:
    value = str(base_url or DEFAULT_BASE_URL).strip()
    return value if value.endswith("/") else value + "/"


def make_headers() -> dict[str, str]:
    return {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "X-Requested-With": "XMLHttpRequest",
        "Origin": "https://www.akapi1.com",
        "Referer": "https://www.akapi1.com/",
    }


class NoticeGuidanceProvider:
    def __init__(self, base_url: str = DEFAULT_BASE_URL):
        self.base_url = normalize_base_url(base_url)

    async def post_rpc(
        self,
        client: httpx.AsyncClient,
        endpoint: str,
        data: dict[str, Any],
        timeout: float = NOTICE_GUIDANCE_REQUEST_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        response = await client.post(self.base_url + endpoint, data=data, timeout=timeout)
        response.raise_for_status()
        payload = response.json()
        if payload.get("Error"):
            message = payload.get("Msg") or payload.get("Message") or "RPC returned Error=true"
            raise RuntimeError(str(message))
        return payload

    async def fetch_subaccount_page(
        self,
        client: httpx.AsyncClient,
        auth: dict[str, Any],
        page: int,
        page_size: int = DEFAULT_PAGE_SIZE,
    ) -> dict[str, Any]:
        payload = await self.post_rpc(
            client,
            "My_Subaccount",
            {
                "p": str(page),
                "size": str(page_size),
                "key": str(auth.get("key") or ""),
                "UserID": str(auth.get("user_id") or ""),
                "v": make_v(),
                "lang": "cn",
            },
            timeout=NOTICE_GUIDANCE_REQUEST_TIMEOUT_SECONDS,
        )
        data = payload.get("Data") or {}
        if not isinstance(data, dict):
            raise RuntimeError(f"My_Subaccount Data type invalid: {type(data).__name__}")
        rows = data.get("List") or []
        if not isinstance(rows, list):
            raise RuntimeError(f"My_Subaccount List type invalid: {type(rows).__name__}")
        return {
            "rows": rows,
            "page_size": int(data.get("PageSize") or page_size),
            "count": int(data.get("Count") or 0),
        }

    def build_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            headers=make_headers(),
            verify=resolve_upstream_tls_verify("notice_guidance", default=False),
            follow_redirects=True,
            trust_env=False,
            timeout=httpx.Timeout(
                NOTICE_GUIDANCE_REQUEST_TIMEOUT_SECONDS,
                connect=resolve_connect_timeout(
                    NOTICE_GUIDANCE_REQUEST_TIMEOUT_SECONDS,
                    connect_timeout_seconds=NOTICE_GUIDANCE_CONNECT_TIMEOUT_SECONDS,
                ),
            ),
        )
