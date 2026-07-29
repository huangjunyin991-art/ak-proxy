from __future__ import annotations

from typing import Any, Mapping

import httpx

from ..notice_guidance.provider import DEFAULT_BASE_URL, make_headers, make_v, normalize_base_url
from ..rpc_timeout_policy import (
    NOTICE_GUIDANCE_CONNECT_TIMEOUT_SECONDS,
    NOTICE_GUIDANCE_REQUEST_TIMEOUT_SECONDS,
    resolve_connect_timeout,
)
from ..security.upstream_http import resolve_upstream_tls_verify


AUTH_ERROR_MARKERS = ("key", "userkey", "token", "login", "登录", "未登录", "未登錄", "失效", "无效", "认证")


class EPAutoPurchaseUpstreamError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(str(message or "upstream request failed"))
        self.status_code = status_code

    @property
    def is_auth_error(self) -> bool:
        text = str(self).strip().lower()
        return any(marker in text for marker in AUTH_ERROR_MARKERS)

    @property
    def is_rate_limited(self) -> bool:
        return self.status_code == 429 or "429" in str(self)


def extract_auth_fields(payload: Mapping[str, Any] | None, fallback_key: str = "") -> dict[str, str]:
    source = payload if isinstance(payload, Mapping) else {}
    containers: list[Mapping[str, Any]] = [source]
    for name in ("UserData", "userData", "Data", "data"):
        value = source.get(name)
        if isinstance(value, Mapping):
            containers.append(value)
    user_id = ""
    key_value = str(fallback_key or "").strip()
    for item in containers:
        if not user_id:
            for name in ("UserID", "UserId", "userId", "user_id", "Id", "ID", "userid", "UID", "uid"):
                user_id = str(item.get(name) or "").strip()
                if user_id:
                    break
        if not key_value:
            for name in ("UserKey", "userKey", "userkey", "Key", "key"):
                key_value = str(item.get(name) or "").strip()
                if key_value:
                    break
    return {"user_id": user_id, "key": key_value}


class EPAutoPurchaseProvider:
    def __init__(self, base_url: str = DEFAULT_BASE_URL) -> None:
        self.base_url = normalize_base_url(base_url)

    def build_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            headers=make_headers(),
            verify=resolve_upstream_tls_verify("ep_auto_purchase", default=False),
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
        *,
        allow_rpc_error: bool = False,
    ) -> dict[str, Any]:
        try:
            response = await client.post(self.base_url + endpoint, data=dict(data))
        except Exception as exc:
            raise EPAutoPurchaseUpstreamError(str(exc) or exc.__class__.__name__) from exc
        if response.status_code >= 400:
            raise EPAutoPurchaseUpstreamError(
                f"HTTP {response.status_code}",
                status_code=int(response.status_code),
            )
        try:
            payload = response.json()
        except Exception as exc:
            raise EPAutoPurchaseUpstreamError("upstream returned non-JSON response") from exc
        if not isinstance(payload, Mapping):
            raise EPAutoPurchaseUpstreamError("upstream payload is not an object")
        result = dict(payload)
        if result.get("Error") and not allow_rpc_error:
            raise EPAutoPurchaseUpstreamError(
                str(result.get("Msg") or result.get("Message") or "RPC returned Error=true")
            )
        return result

    async def list_pending(self, client: httpx.AsyncClient, auth: Mapping[str, str]) -> list[dict[str, Any]]:
        payload = await self.post_rpc(
            client,
            "Public_EP_SellRecords1",
            {
                "p": "1",
                "pageSize": "50",
                "type": "1",
                "account": "",
                "Position": "1",
                "key": str(auth.get("key") or ""),
                "UserID": str(auth.get("user_id") or ""),
                "v": make_v(),
                "lang": "cn",
            },
        )
        data = payload.get("Data") if isinstance(payload.get("Data"), Mapping) else {}
        rows = data.get("List") if isinstance(data, Mapping) else []
        return [dict(item) for item in rows if isinstance(item, Mapping)] if isinstance(rows, list) else []

    async def buy(
        self,
        client: httpx.AsyncClient,
        auth: Mapping[str, str],
        sid: str,
        sokey: str,
    ) -> dict[str, Any]:
        payload = await self.post_rpc(
            client,
            "EP_Buy",
            {
                "sId": sid,
                "Sokey": sokey,
                "key": str(auth.get("key") or ""),
                "UserID": str(auth.get("user_id") or ""),
                "v": make_v(),
                "lang": "cn",
            },
            allow_rpc_error=True,
        )
        return {
            "success": not bool(payload.get("Error")),
            "message": str(payload.get("Msg") or payload.get("Message") or ("购买成功" if not payload.get("Error") else "购买失败")),
        }
