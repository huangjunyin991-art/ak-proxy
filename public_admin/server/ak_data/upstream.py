from __future__ import annotations

from typing import Any

import httpx

from ..security.upstream_http import resolve_upstream_tls_verify


AK_UPSTREAM_BASE = "https://k937.com"


class AkUpstreamClient:
    def __init__(self, base_url: str = AK_UPSTREAM_BASE, timeout_seconds: int = 12,
                 retry_attempts: int = 1, retry_backoff_ms: int = 1200):
        self.base_url = str(base_url or AK_UPSTREAM_BASE).rstrip("/")
        self.timeout_seconds = max(3, min(int(timeout_seconds or 12), 60))
        self.retry_attempts = max(1, min(int(retry_attempts or 1), 10))
        self.retry_backoff_ms = max(100, min(int(retry_backoff_ms or 1200), 10000))

    async def fetch_json(self, endpoint: str, params: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        endpoint = str(endpoint or "").strip("/")
        url = f"{self.base_url}/RPC/{endpoint}"
        headers = {
            "accept": "application/json, text/plain, */*",
            "origin": self.base_url,
            "referer": f"{self.base_url}/pages/home.html?first=true",
            "user-agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
            ),
        }
        last_error = ""
        response = None
        for _attempt in range(1, self.retry_attempts + 1):
            try:
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(self.timeout_seconds, connect=min(6, self.timeout_seconds)),
                    follow_redirects=False,
                    trust_env=False,
                    verify=resolve_upstream_tls_verify("ak_data", default=False),
                ) as client:
                    response = await client.get(url, params=params, headers=headers)
                break
            except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError, httpx.TimeoutException) as exc:
                last_error = str(exc)[:500]
                response = None
        if response is None:
            return 0, {"Error": True, "Msg": last_error or "upstream request failed", "Data": None}
        payload: dict[str, Any]
        try:
            decoded = response.json()
            payload = decoded if isinstance(decoded, dict) else {"Error": True, "Msg": "上游返回非对象 JSON", "Data": decoded}
        except Exception:
            payload = {
                "Error": True,
                "Msg": response.text[:500],
                "Data": None,
            }
        return int(response.status_code), payload

    async def detail(self, trade_id: int, key: str, user_id: str, lang: str = "cn") -> tuple[int, dict[str, Any]]:
        return await self.fetch_json("Public_ACE_Detail", {
            "tId": int(trade_id),
            "key": key,
            "UserID": user_id,
            "v": 2123,
            "lang": lang,
        })

    async def buyers(self, trade_id: int, seller_user_id: str, key: str, user_id: str,
                     page: int = 1, page_size: int = 15, lang: str = "cn") -> tuple[int, dict[str, Any]]:
        return await self.fetch_json("Public_ACE_Detail_List", {
            "p": int(page),
            "pageSize": int(page_size),
            "tId": int(trade_id),
            "uId": seller_user_id,
            "key": key,
            "UserID": user_id,
            "v": 2117,
            "lang": lang,
        })
