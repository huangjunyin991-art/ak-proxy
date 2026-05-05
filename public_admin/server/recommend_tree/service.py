from typing import Any

import httpx

from .provider import RecommendTreeProvider, make_headers
from .repository import RecommendTreeRepository
from .tree_builder import build_payload


class RecommendTreeService:
    def __init__(self, repository: RecommendTreeRepository, provider: RecommendTreeProvider | None = None):
        self.repository = repository
        self.provider = provider or RecommendTreeProvider()

    async def get_cache(self, account: str) -> dict[str, Any]:
        normalized = self.repository.normalize_account(account)
        if not normalized:
            return {"success": False, "message": "请输入账号"}
        cached = await self.repository.get_cache(normalized)
        if not cached:
            return {"success": True, "cached": False, "account": normalized, "message": "暂无缓存"}
        return {
            "success": True,
            "cached": True,
            "account": normalized,
            "meta": cached.get("meta") or {},
            "payload": cached.get("payload") or {},
        }

    async def refresh(self, account: str, root_rid: str = "", page_size: int = 15, max_pages: int = 0, max_depth: int = 0, max_nodes: int = 0) -> dict[str, Any]:
        normalized = self.repository.normalize_account(account)
        if not normalized:
            return {"success": False, "message": "请输入账号"}
        auth = await self._resolve_auth(normalized)
        tree_data = await self.provider.build_tree(
            auth=auth,
            root_rid=root_rid,
            page_size=self._clamp(page_size, 1, 100, 15),
            max_pages=self._non_negative_int(max_pages, 0),
            max_depth=self._clamp(max_depth, 0, 100, 0),
            max_nodes=self._clamp(max_nodes, 0, 200000, 0),
        )
        payload = build_payload(normalized, tree_data)
        meta = await self.repository.save_cache(normalized, payload, source_status="success", source_error="")
        return {"success": True, "cached": True, "account": normalized, "meta": meta, "payload": payload}

    async def _resolve_auth(self, account: str) -> dict[str, Any]:
        auth = await self.repository.get_ak_auth_state(account)
        if auth:
            return auth
        password = await self.repository.get_user_password(account)
        if not password:
            raise RuntimeError("该账号没有可用登录态或已保存密码，请先让该账号登录一次，或在账号管理中补齐密码")
        async with httpx.AsyncClient(headers=make_headers(), verify=False, follow_redirects=True, trust_env=False, timeout=25.0) as client:
            return await self.provider.login(client, self.repository.normalize_account(account), password)

    @staticmethod
    def _clamp(value: Any, min_value: int, max_value: int, default: int) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = default
        return max(min_value, min(max_value, parsed))

    @staticmethod
    def _non_negative_int(value: Any, default: int) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = default
        return max(0, parsed)
