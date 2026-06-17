from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Callable


AK_TABLES = (
    "ak_trade_summary",
    "ak_trade_buyers",
    "ak_daily_summary",
    "ak_scan_runtime",
    "ak_data_config",
)


class AkDataRepository:
    def __init__(self, pool_supplier: Callable[[], object]):
        self._pool_supplier = pool_supplier

    def _pool(self):
        return self._pool_supplier()

    async def _table_exists(self, conn, table_name: str) -> bool:
        return bool(await conn.fetchval("SELECT to_regclass($1) IS NOT NULL", f"public.{table_name}"))

    async def get_status(self) -> dict[str, Any]:
        pool = self._pool()
        async with pool.acquire() as conn:
            has_summary = await self._table_exists(conn, "ak_trade_summary")
            runtime = {}
            if await self._table_exists(conn, "ak_scan_runtime"):
                row = await conn.fetchrow(
                    """
                    SELECT scan_name, running, current_trade_id, target_trade_id, last_saved_trade_id,
                           current_account_username, account_switch_count, next_check_at, status,
                           last_error, started_at, finished_at, updated_at
                    FROM ak_scan_runtime
                    WHERE scan_name = 'main'
                    """
                )
                runtime = dict(row) if row else {}
            if not has_summary:
                return {
                    "ready": False,
                    "latest_trade_id": 0,
                    "local_max_trade_id": 0,
                    "pending_count": 0,
                    "order_count": 0,
                    "first_trade_time": None,
                    "last_trade_time": None,
                    "runtime": runtime,
                }
            row = await conn.fetchrow(
                """
                SELECT COALESCE(MAX(trade_id), 0) AS local_max_trade_id,
                       COUNT(*)::bigint AS order_count,
                       MIN(create_time) AS first_trade_time,
                       MAX(create_time) AS last_trade_time
                FROM ak_trade_summary
                """
            )
            local_max = int(row["local_max_trade_id"] or 0) if row else 0
            target = int(runtime.get("target_trade_id") or 0)
            latest = max(local_max, target)
            return {
                "ready": True,
                "latest_trade_id": latest,
                "local_max_trade_id": local_max,
                "pending_count": max(0, latest - local_max),
                "order_count": int(row["order_count"] or 0) if row else 0,
                "first_trade_time": row["first_trade_time"] if row else None,
                "last_trade_time": row["last_trade_time"] if row else None,
                "runtime": runtime,
            }

    async def get_storage(self) -> dict[str, Any]:
        pool = self._pool()
        rows = []
        async with pool.acquire() as conn:
            for table_name in AK_TABLES:
                size_row = await conn.fetchrow(
                    """
                    SELECT COALESCE(pg_total_relation_size(to_regclass($1)), 0)::bigint AS total_bytes,
                           COALESCE(pg_relation_size(to_regclass($1)), 0)::bigint AS table_bytes,
                           GREATEST(
                               COALESCE(pg_total_relation_size(to_regclass($1)), 0)
                               - COALESCE(pg_relation_size(to_regclass($1)), 0),
                               0
                           )::bigint AS index_bytes
                    """,
                    f"public.{table_name}",
                )
                count_value = None
                if await self._table_exists(conn, table_name):
                    count_value = await conn.fetchval(f"SELECT COUNT(*)::bigint FROM {table_name}")
                rows.append({
                    "table_name": table_name,
                    "rows": int(count_value or 0) if count_value is not None else 0,
                    "exists": count_value is not None,
                    "total_bytes": int(size_row["total_bytes"] or 0),
                    "table_bytes": int(size_row["table_bytes"] or 0),
                    "index_bytes": int(size_row["index_bytes"] or 0),
                })
        return {"success": True, "rows": rows}

    async def get_dashboard(self, days: int = 7) -> dict[str, Any]:
        days = max(1, min(int(days or 7), 90))
        end_day = date.today()
        start_day = end_day - timedelta(days=days - 1)
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_daily_summary"):
                return {"success": True, "start_date": start_day.isoformat(), "end_date": end_day.isoformat(), "rows": []}
            rows = await conn.fetch(
                """
                SELECT date_key, order_count, total_stock, total_mycancel, total_success,
                       total_success_value, platform_gap, unique_seller_count, unique_buyer_count,
                       zero_seller_order_count, min_trade_id, max_trade_id, first_trade_time, last_trade_time
                FROM ak_daily_summary
                WHERE date_key BETWEEN $1 AND $2
                ORDER BY date_key ASC
                """,
                start_day,
                end_day,
            )
        return {
            "success": True,
            "start_date": start_day.isoformat(),
            "end_date": end_day.isoformat(),
            "rows": [dict(row) for row in rows],
        }

    async def get_recent_trades(self, limit: int = 50) -> dict[str, Any]:
        limit = max(1, min(int(limit or 50), 200))
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_trade_summary"):
                return {"success": True, "rows": []}
            has_buyers = await self._table_exists(conn, "ak_trade_buyers")
            buyer_join = """
                LEFT JOIN (
                    SELECT trade_id, COUNT(*)::bigint AS buyer_count
                    FROM ak_trade_buyers
                    GROUP BY trade_id
                ) b ON b.trade_id = s.trade_id
            """ if has_buyers else "LEFT JOIN (SELECT 0::integer AS trade_id, 0::bigint AS buyer_count) b ON false"
            rows = await conn.fetch(
                f"""
                SELECT s.trade_id, s.create_time, s.seller_flow_number, s.single_price,
                       s.readonly_stock_count, s.mycancel, s.success, s.success_value,
                       GREATEST(s.readonly_stock_count - s.mycancel - s.success, 0) AS platform_gap,
                       COALESCE(b.buyer_count, 0) AS buyer_count
                FROM ak_trade_summary s
                {buyer_join}
                ORDER BY s.create_time DESC, s.trade_id DESC
                LIMIT $1
                """,
                limit,
            )
        return {"success": True, "rows": [dict(row) for row in rows]}

    async def query_account_trades(self, query_type: str, account_id: str, limit: int = 500) -> dict[str, Any]:
        role = "buyer" if str(query_type or "").lower() == "buyer" else "seller"
        account = str(account_id or "").strip()
        limit = max(1, min(int(limit or 500), 1000))
        if not account:
            return {"success": True, "query_type": role, "account_id": account, "total": 0, "rows": []}
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_trade_summary"):
                return {"success": True, "query_type": role, "account_id": account, "total": 0, "rows": []}
            has_buyers = await self._table_exists(conn, "ak_trade_buyers")
            if role == "buyer":
                if not has_buyers:
                    return {"success": True, "query_type": role, "account_id": account, "total": 0, "rows": []}
                total = await conn.fetchval(
                    """
                    SELECT COUNT(DISTINCT b.trade_id)::bigint
                    FROM ak_trade_buyers b
                    WHERE b.buyer_flow_number = $1
                    """,
                    account,
                )
                rows = await conn.fetch(
                    """
                    SELECT s.trade_id, s.create_time, s.seller_flow_number, s.single_price,
                           s.readonly_stock_count, s.mycancel, s.success, s.success_value,
                           GREATEST(s.readonly_stock_count - s.mycancel - s.success, 0) AS platform_gap,
                           COALESCE(b_all.buyer_count, 0) AS buyer_count,
                           COALESCE(b_match.matched_amount, 0) AS matched_amount
                    FROM ak_trade_summary s
                    JOIN (
                        SELECT trade_id, SUM(ak_amount)::bigint AS matched_amount
                        FROM ak_trade_buyers
                        WHERE buyer_flow_number = $1
                        GROUP BY trade_id
                    ) b_match ON b_match.trade_id = s.trade_id
                    LEFT JOIN (
                        SELECT trade_id, COUNT(*)::bigint AS buyer_count
                        FROM ak_trade_buyers
                        GROUP BY trade_id
                    ) b_all ON b_all.trade_id = s.trade_id
                    ORDER BY s.create_time DESC, s.trade_id DESC
                    LIMIT $2
                    """,
                    account,
                    limit,
                )
            else:
                buyer_join = """
                    LEFT JOIN (
                        SELECT trade_id, COUNT(*)::bigint AS buyer_count
                        FROM ak_trade_buyers
                        GROUP BY trade_id
                    ) b ON b.trade_id = s.trade_id
                """ if has_buyers else "LEFT JOIN (SELECT 0::integer AS trade_id, 0::bigint AS buyer_count) b ON false"
                total = await conn.fetchval(
                    "SELECT COUNT(*)::bigint FROM ak_trade_summary WHERE seller_flow_number = $1",
                    account,
                )
                rows = await conn.fetch(
                    f"""
                    SELECT s.trade_id, s.create_time, s.seller_flow_number, s.single_price,
                           s.readonly_stock_count, s.mycancel, s.success, s.success_value,
                           GREATEST(s.readonly_stock_count - s.mycancel - s.success, 0) AS platform_gap,
                           COALESCE(b.buyer_count, 0) AS buyer_count,
                           NULL::bigint AS matched_amount
                    FROM ak_trade_summary s
                    {buyer_join}
                    WHERE s.seller_flow_number = $1
                    ORDER BY s.create_time DESC, s.trade_id DESC
                    LIMIT $2
                    """,
                    account,
                    limit,
                )
        return {
            "success": True,
            "query_type": role,
            "account_id": account,
            "total": int(total or 0),
            "rows": [dict(row) for row in rows],
        }

    async def get_trade_buyers(self, trade_id: int) -> dict[str, Any]:
        tid = int(trade_id or 0)
        if tid <= 0:
            return {"success": True, "trade_id": tid, "rows": []}
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_trade_buyers"):
                return {"success": True, "trade_id": tid, "rows": []}
            rows = await conn.fetch(
                """
                SELECT trade_id, buyer_flow_number, ak_amount
                FROM ak_trade_buyers
                WHERE trade_id = $1
                ORDER BY ak_amount DESC, buyer_flow_number ASC
                """,
                tid,
            )
        return {"success": True, "trade_id": tid, "rows": [dict(row) for row in rows]}
