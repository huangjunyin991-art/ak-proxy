from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import httpx

from ..rpc_timeout_policy import (
    NOTICE_GUIDANCE_CONNECT_TIMEOUT_SECONDS,
    NOTICE_GUIDANCE_REQUEST_TIMEOUT_SECONDS,
    resolve_connect_timeout,
)
from ..security.upstream_http import resolve_upstream_tls_verify
from ..upstream_rpc_gate import RpcGateBusy
from .transport import resolve_nginx_rpc_base_url


class AKSellUpstreamError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        is_read_timeout: bool = False,
    ) -> None:
        super().__init__(str(message or "upstream request failed"))
        self.status_code = status_code
        self.is_read_timeout = bool(is_read_timeout)

    @property
    def is_rate_limited(self) -> bool:
        return self.status_code == 429


@dataclass(frozen=True)
class AKSellUpstreamReply:
    payload: dict[str, Any]
    headers: Mapping[str, str]
    url: str


class AKSellProvider:
    """Forwards the fixed AK sell RPC contract through the local Nginx entry point."""

    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = resolve_nginx_rpc_base_url(base_url)

    @staticmethod
    def _headers() -> dict[str, str]:
        return {
            "User-Agent": "AK-Proxy-Sell-Service/1.0",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": "https://ak2025.vip",
            "Referer": "https://ak2025.vip/",
        }

    def build_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            headers=self._headers(),
            verify=resolve_upstream_tls_verify("ak_sell", default=True),
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

    async def post_rpc(
        self,
        client: httpx.AsyncClient,
        endpoint: str,
        data: Mapping[str, Any],
    ) -> dict[str, Any]:
        return (await self.post_rpc_reply(client, endpoint, data)).payload

    async def post_rpc_reply(
        self,
        client: httpx.AsyncClient,
        endpoint: str,
        data: Mapping[str, Any],
        *,
        follow_redirects: bool = True,
        allow_non_json: bool = False,
    ) -> AKSellUpstreamReply:
        try:
            response = await client.post(
                self.base_url + str(endpoint or "").strip("/"),
                data=dict(data),
                follow_redirects=follow_redirects,
            )
        except httpx.ReadTimeout as exc:
            raise AKSellUpstreamError("ReadTimeout", is_read_timeout=True) from exc
        except httpx.TimeoutException as exc:
            raise AKSellUpstreamError("upstream request timed out") from exc
        except httpx.HTTPError as exc:
            raise AKSellUpstreamError(exc.__class__.__name__) from exc

        payload: Any = None
        try:
            payload = response.json()
        except (ValueError, TypeError):
            pass
        if response.status_code >= 400:
            if isinstance(payload, Mapping) and str(payload.get("Code") or "") == "rpc_gate_busy":
                raise RpcGateBusy()
            raise AKSellUpstreamError(
                f"upstream returned HTTP {response.status_code}",
                status_code=int(response.status_code),
            )
        if not isinstance(payload, Mapping) and not allow_non_json:
            raise AKSellUpstreamError("upstream payload is not an object")
        return AKSellUpstreamReply(
            payload=dict(payload) if isinstance(payload, Mapping) else {},
            headers=dict(response.headers),
            url=str(response.url),
        )
