import asyncio
from datetime import datetime, timezone


def _safe_int(value) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


async def _fetch_with_timeout(awaitable, timeout_seconds: float):
    return await asyncio.wait_for(awaitable, timeout=timeout_seconds)


async def collect_database_snapshot(pool, timeout_seconds: float = 4.0) -> dict:
    data = {
        "available": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "database_size_bytes": 0,
        "active_connections": 0,
        "table_sizes": [],
    }
    async with pool.acquire() as conn:
        row = await _fetch_with_timeout(conn.fetchrow('''
            SELECT pg_database_size(current_database()) AS database_size_bytes,
                   (SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database()) AS active_connections
        '''), timeout_seconds)
        if row:
            row_data = dict(row)
            data["database_size_bytes"] = _safe_int(row_data.get("database_size_bytes"))
            data["active_connections"] = _safe_int(row_data.get("active_connections"))
        # 动态扫描 public schema 全部业务 BASE TABLE，避免新增表遗漏。
        # 只保留 relkind='r'（普通表）+ relpersistence='p'（持久化，排除临时/unlogged 表）。
        # 行数取自 pg_stat_user_tables.n_live_tup（PostgreSQL 维护的活跃行数估算，零查询开销）。
        rows = await _fetch_with_timeout(conn.fetch('''
            SELECT c.relname AS table_name,
                   pg_total_relation_size(c.oid) AS total_bytes,
                   pg_relation_size(c.oid) AS data_bytes,
                   COALESCE(s.n_live_tup, 0) AS row_count
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
            WHERE n.nspname = 'public'
              AND c.relkind = 'r'
              AND c.relpersistence = 'p'
              AND c.relname NOT LIKE 'pg\\_%' ESCAPE '\\'
              AND c.relname NOT LIKE 'sql\\_%' ESCAPE '\\'
            ORDER BY pg_total_relation_size(c.oid) DESC
            LIMIT 100
        '''), timeout_seconds)
        data["table_sizes"] = [
            {
                "table_name": str(dict(row).get("table_name") or ""),
                "total_bytes": _safe_int(dict(row).get("total_bytes")),
                "data_bytes": _safe_int(dict(row).get("data_bytes")),
                "row_count": _safe_int(dict(row).get("row_count")),
            }
            for row in rows
        ]
    return data
