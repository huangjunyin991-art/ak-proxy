from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Callable, Dict, Optional

from ..db.sql_policy import strip_leading_sql_comments


@dataclass
class QueryDecision:
    allowed: bool = True
    limit: Optional[int] = None
    limit_capped: bool = False
    count_allowed: bool = True
    table_info: Optional[Dict] = None


class GuardError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def as_dict(self) -> Dict:
        return {"code": self.code, "message": self.message}


class BigTableGuard:
    def __init__(
        self,
        pool_supplier: Callable[[], object],
        row_threshold: int = 200_000,
        size_threshold_bytes: int = 2 * 1024 * 1024 * 1024,
        limit_max: int = 200,
        offset_max: int = 10_000,
        cache_ttl_seconds: int = 60,
    ):
        self.pool_supplier = pool_supplier
        self.row_threshold = row_threshold
        self.size_threshold_bytes = size_threshold_bytes
        self.limit_max = limit_max
        self.offset_max = offset_max
        self.cache_ttl_seconds = cache_ttl_seconds
        self._cache: Dict[str, Dict] = {}

    def _pool(self):
        return self.pool_supplier()

    def _now(self) -> float:
        return time.time()

    async def _fetch_table_info(self, table_name: str) -> Optional[Dict]:
        pool = self._pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                '''
                SELECT relname AS table_name,
                       n_live_tup AS row_estimate,
                       pg_total_relation_size(relid) AS size_bytes
                FROM pg_stat_user_tables
                WHERE relname = $1
                LIMIT 1
                ''',
                table_name,
            )
            if not row:
                return None
            info = dict(row)
            info["is_big"] = bool(
                (info.get("row_estimate") or 0) >= self.row_threshold
                or (info.get("size_bytes") or 0) >= self.size_threshold_bytes
            )
            return info

    async def table_info(self, table_name: str) -> Optional[Dict]:
        key = str(table_name)
        cached = self._cache.get(key)
        if cached and self._now() - cached.get("ts", 0) < self.cache_ttl_seconds:
            return cached.get("info")
        info = await self._fetch_table_info(table_name)
        self._cache[key] = {"ts": self._now(), "info": info}
        return info

    async def validate_table_query(
        self,
        table_name: str,
        limit: int,
        offset: int,
        has_filter: bool,
    ) -> QueryDecision:
        info = await self.table_info(table_name)
        decision = QueryDecision(allowed=True, limit=limit, table_info=info)
        if not info or not info.get("is_big"):
            return decision

        if offset > self.offset_max:
            raise GuardError("deep_offset_blocked", "大表不支持深分页，请增加筛选条件后再试")

        capped_limit = min(int(limit or self.limit_max), self.limit_max)
        decision.limit = capped_limit
        decision.limit_capped = capped_limit != limit

        # 无筛选时，避免运行全表 COUNT
        if not has_filter:
            decision.count_allowed = False

        return decision

    async def validate_sql(self, sql: str) -> None:
        normalized = strip_leading_sql_comments(sql).strip()
        if not normalized:
            return
        upper_sql = normalized.upper()
        op = upper_sql.split()[0] if upper_sql.split() else ""
        # 仅在可能扫描大表的语句上做防护
        if op not in {"SELECT", "UPDATE", "DELETE"}:
            return

        table = self._extract_table_name(upper_sql)
        if not table:
            return

        info = await self.table_info(table)
        if not info or not info.get("is_big"):
            return

        has_where = " WHERE " in f" {upper_sql} "
        has_limit = " LIMIT " in f" {upper_sql} "
        if not has_where:
            raise GuardError("require_where_on_big_table", f"大表 {table} 需要 WHERE 条件以避免全表扫描")
        if op == "SELECT" and not has_limit:
            raise GuardError("require_limit_on_big_table", f"大表 {table} 的查询需要 LIMIT 以限制返回行数")

    @staticmethod
    def _extract_table_name(upper_sql: str) -> Optional[str]:
        # 简单提取第一个表名（用于保护场景，非严格 SQL 解析）
        # SELECT ... FROM <table>
        m = re.search(r"FROM\s+([A-Z0-9_\.]+)", upper_sql)
        if m:
            return m.group(1).split(".")[-1]
        # UPDATE <table>
        m = re.search(r"UPDATE\s+([A-Z0-9_\.]+)\s+SET", upper_sql)
        if m:
            return m.group(1).split(".")[-1]
        # DELETE FROM <table>
        m = re.search(r"DELETE\s+FROM\s+([A-Z0-9_\.]+)", upper_sql)
        if m:
            return m.group(1).split(".")[-1]
        return None
