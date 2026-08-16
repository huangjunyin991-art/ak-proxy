from __future__ import annotations

import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import httpx

from ..rpc_timeout_policy import (
    resolve_connect_timeout,
    resolve_ak_sell_response_timeout,
)
from ..security.upstream_http import resolve_upstream_tls_verify
from ..upstream_rpc_gate import RpcGateBusy
from .internal_rpc import AK_SELL_INTERNAL_RPC_HEADER
from .trace import AK_SELL_TRACE_HEADER, emit_trace, normalize_trace_id
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

    def __init__(self, base_url: str | None = None, *, internal_token: str = "", logger=None) -> None:
        self.base_url = resolve_nginx_rpc_base_url(base_url)
        self.internal_token = str(internal_token or "").strip()
        self.logger = logger or logging.getLogger("TransparentProxy")

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

    def build_client(self, operation: str = "", *, trace_id: str = "") -> httpx.AsyncClient:
        timeout_seconds = resolve_ak_sell_response_timeout(operation)
        headers = self._headers()
        trace_id = normalize_trace_id(trace_id)
        if trace_id:
            headers[AK_SELL_TRACE_HEADER] = trace_id
        return httpx.AsyncClient(
            headers=headers,
            verify=resolve_upstream_tls_verify("ak_sell", default=True),
            follow_redirects=True,
            trust_env=False,
            timeout=httpx.Timeout(
                timeout_seconds,
                connect=resolve_connect_timeout(
                    timeout_seconds,
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
        started_at = time.perf_counter()
        trace_id = normalize_trace_id(client.headers.get(AK_SELL_TRACE_HEADER, ""))
        endpoint_name = str(endpoint or "").strip("/")
        emit_trace(
            self.logger,
            "provider_request",
            trace_id,
            endpoint=endpoint_name,
            follow_redirects=follow_redirects,
        )
        request_headers = None
        if self.internal_token and str(endpoint or "").strip("/").lower() in {
            "login",
            "mnemonic_get01",
            "mnemonic_get03",
            "public_indexdata",
            "my_subaccount",
            "ace_sell",
            "ace_sell_son",
            "google_secret",
            "google_bind",
            "google_unbind",
        }:
            request_headers = {AK_SELL_INTERNAL_RPC_HEADER: self.internal_token}
        try:
            response = await client.post(
                self.base_url + str(endpoint or "").strip("/"),
                data=dict(data),
                headers=request_headers,
                follow_redirects=follow_redirects,
            )
        except httpx.ReadTimeout as exc:
            emit_trace(
                self.logger,
                "provider_timeout",
                trace_id,
                endpoint=endpoint_name,
                elapsed_ms=int((time.perf_counter() - started_at) * 1000),
                error="ReadTimeout",
            )
            raise AKSellUpstreamError("ReadTimeout", is_read_timeout=True) from exc
        except httpx.TimeoutException as exc:
            emit_trace(
                self.logger,
                "provider_timeout",
                trace_id,
                endpoint=endpoint_name,
                elapsed_ms=int((time.perf_counter() - started_at) * 1000),
                error=exc.__class__.__name__,
            )
            raise AKSellUpstreamError("upstream request timed out") from exc
        except httpx.HTTPError as exc:
            emit_trace(
                self.logger,
                "provider_http_error",
                trace_id,
                endpoint=endpoint_name,
                elapsed_ms=int((time.perf_counter() - started_at) * 1000),
                error=exc.__class__.__name__,
            )
            raise AKSellUpstreamError(exc.__class__.__name__) from exc

        payload: Any = None
        try:
            payload = response.json()
        except (ValueError, TypeError):
            pass
        if response.status_code >= 400:
            emit_trace(
                self.logger,
                "provider_response",
                trace_id,
                endpoint=endpoint_name,
                elapsed_ms=int((time.perf_counter() - started_at) * 1000),
                status_code=int(response.status_code),
                payload_json=isinstance(payload, Mapping),
                payload_error=bool(payload.get("Error")) if isinstance(payload, Mapping) else "",
                payload_msg=str(payload.get("Msg") or payload.get("Message") or "") if isinstance(payload, Mapping) else "",
            )
            if isinstance(payload, Mapping) and str(payload.get("Code") or "") == "rpc_gate_busy":
                raise RpcGateBusy()
            raise AKSellUpstreamError(
                f"upstream returned HTTP {response.status_code}",
                status_code=int(response.status_code),
            )
        if not isinstance(payload, Mapping) and not allow_non_json:
            emit_trace(
                self.logger,
                "provider_non_json",
                trace_id,
                endpoint=endpoint_name,
                elapsed_ms=int((time.perf_counter() - started_at) * 1000),
                status_code=int(response.status_code),
            )
            raise AKSellUpstreamError("upstream payload is not an object")
        emit_trace(
            self.logger,
            "provider_response",
            trace_id,
            endpoint=endpoint_name,
            elapsed_ms=int((time.perf_counter() - started_at) * 1000),
            status_code=int(response.status_code),
            payload_json=isinstance(payload, Mapping),
            payload_error=bool(payload.get("Error")) if isinstance(payload, Mapping) else "",
            payload_msg=str(payload.get("Msg") or payload.get("Message") or "") if isinstance(payload, Mapping) else "",
        )
        return AKSellUpstreamReply(
            payload=dict(payload) if isinstance(payload, Mapping) else {},
            headers=dict(response.headers),
            url=str(response.url),
        )
