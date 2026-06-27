from typing import Any, Callable

from .schema import normalize_username
from ..recommend_tree.repository import RecommendTreeRepository
from ..recommend_tree.service import RecommendTreeService


class RiskIsolationUmbrellaResolver:
    """Resolve an account's recommend-tree members for umbrella isolation."""

    def __init__(self, pool_supplier: Callable[[], object], logger=None):
        self.pool_supplier = pool_supplier
        self.repository = RecommendTreeRepository(pool_supplier=pool_supplier)
        self.service = RecommendTreeService(repository=self.repository)
        self.logger = logger

    async def resolve(self, account: str) -> dict[str, Any]:
        normalized = normalize_username(account)
        if not normalized:
            raise ValueError("请输入账号")

        cached = await self._cached_usernames(normalized)
        if cached.get("exists") and cached.get("usernames"):
            return {
                "account": normalized,
                "usernames": self._dedupe([normalized] + cached["usernames"]),
                "cached": True,
                "refreshed": False,
                "node_count": int(cached.get("node_count") or 0),
                "fetched_at": cached.get("fetched_at") or "",
            }

        if self.logger is not None:
            self.logger.info(f"[RiskIsolationUmbrella] 组织架构无缓存，开始获取 account={normalized}")
        refreshed = await self.service.refresh(
            account=normalized,
            page_size=100,
            max_pages=0,
            max_depth=0,
            max_nodes=0,
        )
        if not refreshed.get("success"):
            raise RuntimeError(str(refreshed.get("message") or "获取组织架构失败"))
        payload = refreshed.get("payload") or {}
        usernames = self._payload_usernames(payload, normalized)
        return {
            "account": normalized,
            "usernames": usernames,
            "cached": False,
            "refreshed": True,
            "node_count": int(payload.get("totalNodes") or len(payload.get("nodes") or [])),
            "fetched_at": (refreshed.get("meta") or {}).get("fetchedAt") or "",
        }

    async def _cached_usernames(self, account: str) -> dict[str, Any]:
        await self.repository.ensure_ready()
        pool = self.pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT rtc.node_count,
                       rtc.fetched_at,
                       COALESCE(
                           ARRAY_AGG(DISTINCT LOWER(BTRIM(node_item.node ->> 'account')))
                               FILTER (WHERE COALESCE(BTRIM(node_item.node ->> 'account'), '') <> ''),
                           ARRAY[]::text[]
                       ) AS usernames
                FROM admin_recommend_tree_cache rtc
                LEFT JOIN LATERAL jsonb_array_elements(
                    CASE
                        WHEN jsonb_typeof((rtc.payload_json::jsonb) -> 'nodes') = 'array'
                        THEN (rtc.payload_json::jsonb) -> 'nodes'
                        ELSE '[]'::jsonb
                    END
                ) AS node_item(node) ON TRUE
                WHERE rtc.account = $1
                GROUP BY rtc.account, rtc.node_count, rtc.fetched_at
                """,
                account,
            )
        if not row:
            return {"exists": False, "usernames": []}
        return {
            "exists": True,
            "usernames": self._dedupe(row["usernames"] or []),
            "node_count": int(row["node_count"] or 0),
            "fetched_at": self._iso(row["fetched_at"]),
        }

    def _payload_usernames(self, payload: dict[str, Any], account: str) -> list[str]:
        values = [account]
        for node in payload.get("nodes") or []:
            if isinstance(node, dict):
                values.append(node.get("account") or "")
        return self._dedupe(values)

    @staticmethod
    def _dedupe(values: list[Any]) -> list[str]:
        result: list[str] = []
        seen: set[str] = set()
        for value in values or []:
            username = normalize_username(value)
            if not username or username in seen:
                continue
            seen.add(username)
            result.append(username)
        return result

    @staticmethod
    def _iso(value: Any) -> str:
        if not value:
            return ""
        if hasattr(value, "isoformat"):
            return value.isoformat(sep=" ", timespec="seconds")
        return str(value)
