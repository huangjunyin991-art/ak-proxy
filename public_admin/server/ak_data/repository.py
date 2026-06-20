from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from typing import Any, Callable

from .config import normalize_config


AK_TABLES = (
    "ak_trade_summary",
    "ak_trade_buyers",
    "ak_daily_summary",
    "ak_trade_fetch_state",
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

    async def ensure_main_runtime(self) -> None:
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_scan_runtime"):
                return
            await conn.execute(
                """
                INSERT INTO ak_scan_runtime (scan_name)
                VALUES ('main')
                ON CONFLICT (scan_name) DO NOTHING
                """
            )

    async def load_config(self) -> dict[str, Any]:
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_data_config"):
                return {}
            rows = await conn.fetch("SELECT config_key, config_value FROM ak_data_config")
        config: dict[str, Any] = {}
        for row in rows:
            key = str(row["config_key"] or "").strip()
            if not key:
                continue
            raw = str(row["config_value"] or "").strip()
            try:
                config[key] = json.loads(raw)
            except Exception:
                config[key] = raw
        return config

    async def save_config(self, config: dict[str, Any]) -> dict[str, Any]:
        pool = self._pool()
        rows = []
        for key, value in sorted((config or {}).items()):
            rows.append((str(key), json.dumps(value, ensure_ascii=False)))
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_data_config"):
                return {}
            async with conn.transaction():
                for key, value in rows:
                    await conn.execute(
                        """
                        INSERT INTO ak_data_config (config_key, config_value, updated_at)
                        VALUES ($1, $2, NOW())
                        ON CONFLICT (config_key)
                        DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()
                        """,
                        key,
                        value,
                    )
        return await self.load_config()

    async def update_runtime(self, **fields: Any) -> None:
        if not fields:
            return
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_scan_runtime"):
                return
            await conn.execute(
                """
                INSERT INTO ak_scan_runtime (scan_name)
                VALUES ('main')
                ON CONFLICT (scan_name) DO NOTHING
                """
            )
            parts = []
            values = ["main"]
            for key, value in fields.items():
                parts.append(f"{key} = ${len(values) + 1}")
                values.append(value)
            await conn.execute(
                f"""
                UPDATE ak_scan_runtime
                SET {', '.join(parts)}, updated_at = NOW()
                WHERE scan_name = $1
                """,
                *values,
            )

    async def get_runtime(self) -> dict[str, Any]:
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_scan_runtime"):
                return {}
            await conn.execute(
                """
                INSERT INTO ak_scan_runtime (scan_name)
                VALUES ('main')
                ON CONFLICT (scan_name) DO NOTHING
                """
            )
            row = await conn.fetchrow(
                """
                SELECT scan_name, running, direction, current_trade_id, target_trade_id, last_saved_trade_id,
                       last_seen_create_time, last_trigger_trade_id, current_account_username,
                       next_check_at, last_check_skipped_at, last_check_skip_reason, status, last_error,
                       started_at, finished_at, updated_at
                FROM ak_scan_runtime
                WHERE scan_name = 'main'
                """
            )
            return dict(row) if row else {}

    async def list_accounts(self, limit: int = 100) -> list[dict[str, Any]]:
        pool = self._pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT username, password, ak_userkey, ak_login_payload, ak_auth_updated_at, ak_auth_expires_at
                FROM user_stats
                WHERE COALESCE(ak_userkey, '') <> ''
                  AND (ak_auth_expires_at IS NULL OR ak_auth_expires_at > NOW())
                ORDER BY ak_auth_updated_at DESC NULLS LAST, username ASC
                LIMIT $1
                """,
                max(1, min(int(limit or 100), 500)),
            )
        result = []
        for row in rows:
            payload = row["ak_login_payload"] or "{}"
            try:
                login_payload = json.loads(payload) if isinstance(payload, str) else dict(payload or {})
            except Exception:
                login_payload = {}
            user_data = login_payload.get("UserData") if isinstance(login_payload, dict) else {}
            result.append({
                "username": str(row["username"] or "").strip().lower(),
                "password": str(row["password"] or ""),
                "userkey": str(row["ak_userkey"] or "").strip(),
                "user_id": str((user_data or {}).get("Id") or (user_data or {}).get("ID") or login_payload.get("UserID") or "").strip(),
                "expires_at": row["ak_auth_expires_at"],
                "updated_at": row["ak_auth_updated_at"],
                "login_payload": login_payload,
            })
        return result

    async def get_account_credentials(self, username: str) -> dict[str, Any] | None:
        normalized = str(username or "").strip().lower()
        if not normalized:
            return None
        pool = self._pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT username, password, ak_userkey, ak_login_payload, ak_auth_updated_at, ak_auth_expires_at
                FROM user_stats
                WHERE username = $1
                """,
                normalized,
            )
        if not row:
            return None
        try:
            login_payload = json.loads(row["ak_login_payload"] or "{}")
        except Exception:
            login_payload = {}
        user_data = login_payload.get("UserData") if isinstance(login_payload, dict) else {}
        return {
            "username": str(row["username"] or "").strip().lower(),
            "password": str(row["password"] or ""),
            "userkey": str(row["ak_userkey"] or "").strip(),
            "user_id": str((user_data or {}).get("Id") or (user_data or {}).get("ID") or login_payload.get("UserID") or "").strip(),
            "expires_at": row["ak_auth_expires_at"],
            "updated_at": row["ak_auth_updated_at"],
            "login_payload": login_payload,
        }

    async def save_account_auth(self, username: str, userkey: str, login_payload: dict[str, Any], cookies: dict[str, str] | None = None, ttl_seconds: int = 3600) -> None:
        normalized = str(username or "").strip().lower()
        if not normalized:
            return
        payload_json = json.dumps(login_payload or {}, ensure_ascii=False)
        cookies_json = json.dumps(cookies or {}, ensure_ascii=False)
        pool = self._pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO user_stats (username, ak_userkey, ak_login_cookies, ak_login_payload, ak_auth_updated_at, ak_auth_expires_at)
                VALUES ($1, $2, $3, $4, NOW(), NOW() + ($5::int * INTERVAL '1 second'))
                ON CONFLICT(username) DO UPDATE SET
                    ak_userkey = EXCLUDED.ak_userkey,
                    ak_login_cookies = EXCLUDED.ak_login_cookies,
                    ak_login_payload = EXCLUDED.ak_login_payload,
                    ak_auth_updated_at = EXCLUDED.ak_auth_updated_at,
                    ak_auth_expires_at = EXCLUDED.ak_auth_expires_at
                """,
                normalized,
                str(userkey or ""),
                cookies_json,
                payload_json,
                max(60, int(ttl_seconds or 3600)),
            )

    async def get_status(self) -> dict[str, Any]:
        pool = self._pool()
        async with pool.acquire() as conn:
            has_summary = await self._table_exists(conn, "ak_trade_summary")
            runtime = {}
            if await self._table_exists(conn, "ak_scan_runtime"):
                row = await conn.fetchrow(
                    """
                    SELECT scan_name, running, current_trade_id, target_trade_id, last_saved_trade_id,
                           current_account_username, next_check_at, status,
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
                    "local_min_trade_id": 0,
                    "pending_count": 0,
                    "order_count": 0,
                    "first_trade_time": None,
                    "last_trade_time": None,
                    "runtime": runtime,
                }
            row = await conn.fetchrow(
                """
                SELECT COALESCE(MAX(trade_id), 0) AS local_max_trade_id,
                       COALESCE(MIN(trade_id), 0) AS local_min_trade_id,
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
                "local_min_trade_id": int(row["local_min_trade_id"] or 0) if row else 0,
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

    async def get_market_value(self, days: int = 7) -> dict[str, Any]:
        days = max(1, min(int(days or 7), 90))
        end_day = date.today()
        start_day = end_day - timedelta(days=days - 1)
        config = normalize_config(await self.load_config())
        try:
            base_day = date.fromisoformat(config.base_stat_date)
        except Exception:
            base_day = date(2026, 6, 1)
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_trade_summary"):
                return {"success": True, "start_date": start_day.isoformat(), "end_date": end_day.isoformat(), "rows": []}
            rows = await conn.fetch(
                """
                WITH ordered_trades AS (
                    SELECT s.trade_id,
                           s.single_price,
                           s.readonly_stock_count,
                           s.mycancel,
                           s.success,
                           s.success_value,
                           s.create_time,
                           s.date_key,
                           LAG(s.single_price) OVER (ORDER BY s.create_time ASC, s.trade_id ASC) AS previous_price
                    FROM ak_trade_summary s
                    WHERE s.date_key >= $3
                      AND s.date_key <= ($2::date + 1)
                ),
                segmented_trades AS (
                    SELECT *,
                           SUM(
                               CASE
                                   WHEN previous_price IS NULL OR single_price <> previous_price THEN 1
                                   ELSE 0
                               END
                           ) OVER (ORDER BY create_time ASC, trade_id ASC) AS price_segment
                    FROM ordered_trades
                ),
                segment_stats AS (
                    SELECT price_segment,
                           single_price AS segment_price,
                           COUNT(*)::integer AS price_order_count,
                           COALESCE(SUM(success), 0)::bigint AS price_total_success,
                           COALESCE(SUM(success_value), 0)::numeric(14,2) AS price_total_trade_value,
                           COALESCE(SUM(mycancel), 0)::bigint AS price_total_mycancel,
                           COALESCE(SUM(GREATEST(readonly_stock_count - mycancel - success, 0)), 0)::bigint AS price_total_fee_stock,
                           MIN(create_time) AS first_trade_time,
                           MAX(create_time) AS last_trade_time
                    FROM segmented_trades
                    GROUP BY price_segment, single_price
                ),
                segment_change AS (
                    SELECT st.price_segment,
                           MIN(st.trade_id) AS price_trade_id,
                           MIN(st.create_time) AS price_change_time,
                           MIN(st.date_key) AS date_key,
                           MIN(st.single_price) AS next_price,
                           MIN(st.previous_price) AS previous_price
                    FROM segmented_trades st
                    WHERE st.previous_price IS NOT NULL
                      AND st.single_price <> st.previous_price
                    GROUP BY st.price_segment
                ),
                ranked_change AS (
                    SELECT *,
                           ROW_NUMBER() OVER (ORDER BY price_change_time ASC, price_trade_id ASC) AS change_rank
                    FROM segment_change
                ),
                daily_stats AS (
                    SELECT date_key,
                           COUNT(*)::integer AS order_count,
                           COALESCE(SUM(success), 0)::bigint AS total_success
                    FROM ak_trade_summary
                    WHERE date_key BETWEEN $1 AND $2
                    GROUP BY date_key
                ),
                visible_market AS (
                    SELECT sc.date_key,
                           sc.price_trade_id,
                           sc.price_change_time,
                           sc.previous_price,
                           COALESCE(ds.order_count, 0)::integer AS order_count,
                           COALESCE(ds.total_success, 0)::bigint AS total_success,
                           ss.price_total_trade_value::numeric(14,2) AS total_trade_value,
                           sc.next_price::numeric(4,3) AS avg_price,
                           (ss.price_total_trade_value / 0.005)::numeric(18,2) AS market_value,
                           CASE
                               WHEN sc.previous_price > 0
                               THEN ((ss.price_total_trade_value / 0.005) / sc.previous_price)::numeric(18,2)
                               ELSE 0::numeric(18,2)
                           END AS stock_count,
                           ss.price_order_count,
                           ss.price_total_success,
                           ss.first_trade_time,
                           ss.last_trade_time
                    FROM ranked_change sc
                    JOIN segment_stats ss ON ss.price_segment = sc.price_segment - 1
                    LEFT JOIN daily_stats ds ON ds.date_key = sc.date_key
                    WHERE sc.change_rank > 1
                )
                SELECT date_key,
                       price_trade_id,
                       price_change_time,
                       previous_price,
                       order_count,
                       total_success,
                       total_trade_value,
                       avg_price,
                       market_value,
                       stock_count,
                       price_order_count,
                       price_total_success,
                       CASE
                           WHEN LAG(market_value) OVER (ORDER BY price_change_time, price_trade_id) > 0
                           THEN (((market_value - LAG(market_value) OVER (ORDER BY price_change_time, price_trade_id))
                               / LAG(market_value) OVER (ORDER BY price_change_time, price_trade_id)) * 100)::numeric(10,2)
                       ELSE NULL
                       END AS market_inflation_rate,
                       first_trade_time,
                       last_trade_time
                FROM visible_market
                WHERE date_key BETWEEN $1 AND $2
                ORDER BY price_change_time ASC, price_trade_id ASC
                """,
                start_day,
                end_day,
                base_day,
            )
        return {
            "success": True,
            "start_date": start_day.isoformat(),
            "end_date": end_day.isoformat(),
            "rows": [dict(row) for row in rows],
        }

    async def get_recent_trades(self, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        limit = max(1, min(int(limit or 50), 200))
        offset = max(0, int(offset or 0))
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_trade_summary"):
                return {"success": True, "total": 0, "limit": limit, "offset": offset, "has_more": False, "rows": []}
            has_buyers = await self._table_exists(conn, "ak_trade_buyers")
            complete_filter = """
                AND NOT EXISTS (
                    SELECT 1 FROM ak_trade_fetch_state fs
                    WHERE fs.trade_id = s.trade_id AND fs.fetch_status <> 'complete'
                )
            """ if await self._table_exists(conn, "ak_trade_fetch_state") else ""
            buyer_join = """
                LEFT JOIN (
                    SELECT trade_id, COUNT(*)::bigint AS buyer_count
                    FROM ak_trade_buyers
                    GROUP BY trade_id
                ) b ON b.trade_id = s.trade_id
            """ if has_buyers else "LEFT JOIN (SELECT 0::integer AS trade_id, 0::bigint AS buyer_count) b ON false"
            total = await conn.fetchval(
                f"""
                SELECT COUNT(*)::bigint
                FROM ak_trade_summary s
                WHERE 1=1
                {complete_filter}
                """
            )
            rows = await conn.fetch(
                f"""
                SELECT s.trade_id, s.create_time, s.seller_flow_number, s.single_price,
                       s.readonly_stock_count, s.mycancel, s.success, s.success_value,
                       GREATEST(s.readonly_stock_count - s.mycancel - s.success, 0) AS platform_gap,
                       COALESCE(b.buyer_count, 0) AS buyer_count
                FROM ak_trade_summary s
                {buyer_join}
                WHERE 1=1
                {complete_filter}
                ORDER BY s.create_time DESC, s.trade_id DESC
                LIMIT $1
                OFFSET $2
                """,
                limit,
                offset,
            )
        total_int = int(total or 0)
        return {
            "success": True,
            "total": total_int,
            "limit": limit,
            "offset": offset,
            "has_more": offset + limit < total_int,
            "rows": [dict(row) for row in rows],
        }

    async def query_account_trades(self, query_type: str, account_id: str, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        role = "buyer" if str(query_type or "").lower() == "buyer" else "seller"
        account = str(account_id or "").strip()
        limit = max(1, min(int(limit or 50), 200))
        offset = max(0, int(offset or 0))
        if not account:
            return {"success": True, "query_type": role, "account_id": account, "total": 0, "limit": limit, "offset": offset, "has_more": False, "rows": []}
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_trade_summary"):
                return {"success": True, "query_type": role, "account_id": account, "total": 0, "limit": limit, "offset": offset, "has_more": False, "rows": []}
            has_buyers = await self._table_exists(conn, "ak_trade_buyers")
            if role == "buyer":
                if not has_buyers:
                    return {"success": True, "query_type": role, "account_id": account, "total": 0, "limit": limit, "offset": offset, "has_more": False, "rows": []}
                has_fetch_state = await self._table_exists(conn, "ak_trade_fetch_state")
                complete_filter = """
                      AND NOT EXISTS (
                          SELECT 1 FROM ak_trade_fetch_state fs
                          WHERE fs.trade_id = s.trade_id AND fs.fetch_status <> 'complete'
                      )
                """ if has_fetch_state else ""
                total = await conn.fetchval(
                    f"""
                    SELECT COUNT(DISTINCT b.trade_id)::bigint
                    FROM ak_trade_buyers b
                    JOIN ak_trade_summary s ON s.trade_id = b.trade_id
                    WHERE b.buyer_flow_number = $1
                    {complete_filter}
                    """,
                    account,
                )
                rows = await conn.fetch(
                    f"""
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
                    WHERE 1=1
                    {complete_filter}
                    ORDER BY s.create_time DESC, s.trade_id DESC
                    LIMIT $2
                    OFFSET $3
                    """,
                    account,
                    limit,
                    offset,
                )
            else:
                buyer_join = """
                    LEFT JOIN (
                        SELECT trade_id, COUNT(*)::bigint AS buyer_count
                        FROM ak_trade_buyers
                        GROUP BY trade_id
                    ) b ON b.trade_id = s.trade_id
                """ if has_buyers else "LEFT JOIN (SELECT 0::integer AS trade_id, 0::bigint AS buyer_count) b ON false"
                complete_filter = """
                      AND NOT EXISTS (
                          SELECT 1 FROM ak_trade_fetch_state fs
                          WHERE fs.trade_id = s.trade_id AND fs.fetch_status <> 'complete'
                      )
                """ if await self._table_exists(conn, "ak_trade_fetch_state") else ""
                total = await conn.fetchval(
                    f"""
                    SELECT COUNT(*)::bigint
                    FROM ak_trade_summary s
                    WHERE s.seller_flow_number = $1
                    {complete_filter}
                    """,
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
                    {complete_filter}
                    ORDER BY s.create_time DESC, s.trade_id DESC
                    LIMIT $2
                    OFFSET $3
                    """,
                    account,
                    limit,
                    offset,
                )
        total_int = int(total or 0)
        return {
            "success": True,
            "query_type": role,
            "account_id": account,
            "total": total_int,
            "limit": limit,
            "offset": offset,
            "has_more": offset + limit < total_int,
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

    async def upsert_trade_summary(self, trade: dict[str, Any], seller_flow_number: str, complete: bool = True) -> None:
        if not trade:
            return
        pool = self._pool()
        trade_id = int(trade.get("Id") or 0)
        if trade_id <= 0:
            return
        single_price = float(trade.get("SinglePrice") or 0)
        readonly_stock_count = int(trade.get("ReadonlyStockCount") or 0)
        mycancel = int(trade.get("mycancel") or 0)
        success = int(trade.get("success") or 0)
        success_value = round(float(trade.get("successvalue") or 0), 2)
        create_time = self._parse_datetime(trade.get("CreateTime"))
        date_key = create_time.date() if create_time else date.today()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_trade_summary"):
                return
            await conn.execute(
                """
                INSERT INTO ak_trade_summary (
                    trade_id, single_price, readonly_stock_count, mycancel, success,
                    success_value, create_time, date_key, seller_flow_number, created_at, updated_at
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
                ON CONFLICT (trade_id)
                DO UPDATE SET
                    single_price = EXCLUDED.single_price,
                    readonly_stock_count = EXCLUDED.readonly_stock_count,
                    mycancel = EXCLUDED.mycancel,
                    success = EXCLUDED.success,
                    success_value = EXCLUDED.success_value,
                    create_time = EXCLUDED.create_time,
                    date_key = EXCLUDED.date_key,
                    seller_flow_number = EXCLUDED.seller_flow_number,
                    updated_at = NOW()
                """,
                trade_id,
                single_price,
                readonly_stock_count,
                mycancel,
                success,
                success_value,
                create_time or datetime.now(),
                date_key,
                str(seller_flow_number or "").strip(),
            )
            if await self._table_exists(conn, "ak_trade_fetch_state"):
                await conn.execute(
                    """
                    INSERT INTO ak_trade_fetch_state (
                        trade_id, fetch_status, attempt_count, last_error, first_seen_at,
                        last_attempt_at, fetched_at, updated_at
                    )
                    VALUES ($1, $2, 0, $3, NOW(), NOW(), CASE WHEN $2 = 'complete' THEN NOW() ELSE NULL END, NOW())
                    ON CONFLICT (trade_id)
                    DO UPDATE SET
                        fetch_status = EXCLUDED.fetch_status,
                        last_error = EXCLUDED.last_error,
                        last_attempt_at = NOW(),
                        fetched_at = CASE WHEN EXCLUDED.fetch_status = 'complete' THEN NOW() ELSE ak_trade_fetch_state.fetched_at END,
                        updated_at = NOW()
                    """,
                    trade_id,
                    "complete" if complete else "pending",
                    "" if complete else "buyers pending",
                )

    async def mark_trade_complete(self, trade_id: int) -> None:
        tid = int(trade_id or 0)
        if tid <= 0:
            return
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_trade_fetch_state"):
                return
            await conn.execute(
                """
                INSERT INTO ak_trade_fetch_state (
                    trade_id, fetch_status, attempt_count, last_error, first_seen_at,
                    last_attempt_at, fetched_at, updated_at
                )
                VALUES ($1, 'complete', 0, '', NOW(), NOW(), NOW(), NOW())
                ON CONFLICT (trade_id)
                DO UPDATE SET
                    fetch_status = 'complete',
                    last_error = '',
                    last_attempt_at = NOW(),
                    fetched_at = NOW(),
                    updated_at = NOW()
                """,
                tid,
            )

    async def replace_trade_buyers(self, trade_id: int, rows: list[dict[str, Any]]) -> None:
        tid = int(trade_id or 0)
        if tid <= 0:
            return
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_trade_buyers"):
                return
            async with conn.transaction():
                await conn.execute("DELETE FROM ak_trade_buyers WHERE trade_id = $1", tid)
                if rows:
                    await conn.executemany(
                        """
                        INSERT INTO ak_trade_buyers (trade_id, buyer_flow_number, ak_amount, created_at)
                        VALUES ($1, $2, $3, NOW())
                        """,
                        [
                            (tid, str(row.get("buyer_flow_number") or "").strip(), int(row.get("ak_amount") or 0))
                            for row in rows
                            if str(row.get("buyer_flow_number") or "").strip()
                        ],
                    )

    async def commit_trade_day_batch(self, day: date, items: list[dict[str, Any]], save_buyers: bool = True) -> dict[str, int]:
        valid_items = [item for item in items or [] if int(item.get("trade_id") or 0) > 0 and isinstance(item.get("detail"), dict)]
        if not valid_items:
            return {"orders": 0, "buyers": 0}
        trade_ids = sorted({int(item.get("trade_id") or 0) for item in valid_items}, reverse=True)
        if len(trade_ids) != len(valid_items):
            raise ValueError(f"AK 日批次订单 ID 重复: day={day} unique={len(trade_ids)} total={len(valid_items)}")
        if len(trade_ids) != trade_ids[0] - trade_ids[-1] + 1:
            raise ValueError(f"AK 日批次订单 ID 不连续: day={day} max={trade_ids[0]} min={trade_ids[-1]} count={len(trade_ids)}")
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_trade_summary"):
                return {"orders": 0, "buyers": 0}
            has_buyers = await self._table_exists(conn, "ak_trade_buyers")
            has_state = await self._table_exists(conn, "ak_trade_fetch_state")
            has_daily = await self._table_exists(conn, "ak_daily_summary")
            summary_rows = []
            buyer_rows = []
            trade_ids = []
            for item in valid_items:
                trade = item.get("detail") or {}
                trade_id = int(trade.get("Id") or item.get("trade_id") or 0)
                if trade_id <= 0:
                    continue
                create_time = self._parse_datetime(trade.get("CreateTime")) or datetime.now()
                date_key = create_time.date()
                if date_key != day:
                    raise ValueError(f"AK 日批次日期不一致: expected={day} actual={date_key} trade_id={trade_id}")
                summary_rows.append((
                    trade_id,
                    float(trade.get("SinglePrice") or 0),
                    int(trade.get("ReadonlyStockCount") or 0),
                    int(trade.get("mycancel") or 0),
                    int(trade.get("success") or 0),
                    round(float(trade.get("successvalue") or 0), 2),
                    create_time,
                    date_key,
                    str(item.get("seller_flow") or "").strip(),
                ))
                trade_ids.append(trade_id)
                if save_buyers:
                    for buyer in item.get("buyers") or []:
                        buyer_flow = str(buyer.get("buyer_flow_number") or "").strip()
                        if buyer_flow:
                            buyer_rows.append((trade_id, buyer_flow, int(buyer.get("ak_amount") or 0)))
            if not summary_rows:
                return {"orders": 0, "buyers": 0}
            async with conn.transaction():
                await conn.executemany(
                    """
                    INSERT INTO ak_trade_summary (
                        trade_id, single_price, readonly_stock_count, mycancel, success,
                        success_value, create_time, date_key, seller_flow_number, created_at, updated_at
                    )
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
                    ON CONFLICT (trade_id)
                    DO UPDATE SET
                        single_price = EXCLUDED.single_price,
                        readonly_stock_count = EXCLUDED.readonly_stock_count,
                        mycancel = EXCLUDED.mycancel,
                        success = EXCLUDED.success,
                        success_value = EXCLUDED.success_value,
                        create_time = EXCLUDED.create_time,
                        date_key = EXCLUDED.date_key,
                        seller_flow_number = EXCLUDED.seller_flow_number,
                        updated_at = NOW()
                    """,
                    summary_rows,
                )
                if has_buyers and save_buyers:
                    await conn.execute("DELETE FROM ak_trade_buyers WHERE trade_id = ANY($1::int[])", trade_ids)
                    if buyer_rows:
                        await conn.executemany(
                            """
                            INSERT INTO ak_trade_buyers (trade_id, buyer_flow_number, ak_amount, created_at)
                            VALUES ($1, $2, $3, NOW())
                            """,
                            buyer_rows,
                        )
                if has_state:
                    await conn.executemany(
                        """
                        INSERT INTO ak_trade_fetch_state (
                            trade_id, fetch_status, attempt_count, last_error, first_seen_at,
                            last_attempt_at, fetched_at, updated_at
                        )
                        VALUES ($1, 'complete', 0, '', NOW(), NOW(), NOW(), NOW())
                        ON CONFLICT (trade_id)
                        DO UPDATE SET
                            fetch_status = 'complete',
                            last_error = '',
                            last_attempt_at = NOW(),
                            fetched_at = NOW(),
                            updated_at = NOW()
                        """,
                        [(trade_id,) for trade_id in trade_ids],
                    )
                if has_daily:
                    await self._refresh_daily_summary_on_conn(conn, day)
                latest = max(summary_rows, key=lambda row: row[6])
                await conn.execute(
                    """
                    INSERT INTO ak_scan_runtime (
                        scan_name, running, current_trade_id, last_saved_trade_id,
                        last_seen_create_time, status, updated_at
                    )
                    VALUES ('main', TRUE, $1, $2, $3, 'running', NOW())
                    ON CONFLICT (scan_name)
                    DO UPDATE SET
                        current_trade_id = EXCLUDED.current_trade_id,
                        last_saved_trade_id = EXCLUDED.last_saved_trade_id,
                        last_seen_create_time = EXCLUDED.last_seen_create_time,
                        status = EXCLUDED.status,
                        updated_at = NOW()
                    """,
                    max(min(trade_ids) - 1, 0),
                    max(trade_ids),
                    latest[6],
                )
        return {"orders": len(summary_rows), "buyers": len(buyer_rows)}

    async def get_latest_trade_id(self) -> int:
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_trade_summary"):
                return 0
            value = await conn.fetchval("SELECT COALESCE(MAX(trade_id), 0)::bigint FROM ak_trade_summary")
        return int(value or 0)

    async def delete_old_data(self, summary_days: int, buyer_days: int) -> dict[str, int]:
        pool = self._pool()
        removed_summary = 0
        removed_buyers = 0
        async with pool.acquire() as conn:
            if await self._table_exists(conn, "ak_trade_buyers"):
                removed_buyers = int(await conn.fetchval(
                    """
                    WITH deleted AS (
                        DELETE FROM ak_trade_buyers
                        WHERE created_at < NOW() - ($1 || ' days')::interval
                        RETURNING 1
                    )
                    SELECT COUNT(*)::bigint FROM deleted
                    """,
                    int(buyer_days or 30),
                ) or 0)
            if await self._table_exists(conn, "ak_trade_summary"):
                removed_summary = int(await conn.fetchval(
                    """
                    WITH deleted AS (
                        DELETE FROM ak_trade_summary
                        WHERE create_time < NOW() - ($1 || ' days')::interval
                        RETURNING 1
                    )
                    SELECT COUNT(*)::bigint FROM deleted
                    """,
                    int(summary_days or 365),
                ) or 0)
            if await self._table_exists(conn, "ak_trade_fetch_state"):
                await conn.execute(
                    """
                    DELETE FROM ak_trade_fetch_state
                    WHERE trade_id NOT IN (SELECT trade_id FROM ak_trade_summary)
                      AND first_seen_at < NOW() - ($1 || ' days')::interval
                    """,
                    int(summary_days or 365),
                )
        return {"removed_summary": removed_summary, "removed_buyers": removed_buyers}

    async def mark_trade_placeholder(self, trade_id: int, status: str = "pending", error: str = "") -> None:
        tid = int(trade_id or 0)
        if tid <= 0:
            return
        normalized = "pending" if str(status or "").strip().lower() not in {"pending", "error"} else str(status).strip().lower()
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_trade_fetch_state"):
                return
            await conn.execute(
                """
                INSERT INTO ak_trade_fetch_state (
                    trade_id, fetch_status, attempt_count, last_error, first_seen_at,
                    last_attempt_at, updated_at
                )
                VALUES ($1, $2, 1, $3, NOW(), NOW(), NOW())
                ON CONFLICT (trade_id)
                DO UPDATE SET
                    fetch_status = CASE
                        WHEN ak_trade_fetch_state.fetch_status = 'complete' THEN 'complete'
                        ELSE EXCLUDED.fetch_status
                    END,
                    attempt_count = ak_trade_fetch_state.attempt_count + 1,
                    last_error = EXCLUDED.last_error,
                    last_attempt_at = NOW(),
                    updated_at = NOW()
                """,
                tid,
                normalized,
                str(error or "")[:500],
            )

    async def list_incomplete_trade_ids(self, limit: int = 500) -> list[int]:
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_trade_fetch_state"):
                return []
            rows = await conn.fetch(
                """
                SELECT trade_id
                FROM ak_trade_fetch_state
                WHERE fetch_status <> 'complete'
                ORDER BY updated_at ASC, trade_id DESC
                LIMIT $1
                """,
                max(1, min(int(limit or 500), 5000)),
            )
        return [int(row["trade_id"]) for row in rows]

    async def refresh_daily_summary(self, day: date) -> None:
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_daily_summary"):
                return
            await self._refresh_daily_summary_on_conn(conn, day)

    async def _refresh_daily_summary_on_conn(self, conn, day: date) -> None:
        await conn.execute(
            """
            WITH buyer_daily AS (
                SELECT s.date_key,
                       COUNT(DISTINCT b.buyer_flow_number)::integer AS unique_buyer_count
                FROM ak_trade_summary s
                LEFT JOIN ak_trade_buyers b ON b.trade_id = s.trade_id
                WHERE s.date_key = $1
                GROUP BY s.date_key
            )
            INSERT INTO ak_daily_summary (
                date_key, order_count, total_stock, total_mycancel, total_success,
                total_success_value, platform_gap, unique_seller_count, unique_buyer_count,
                zero_seller_order_count, min_trade_id, max_trade_id, first_trade_time,
                last_trade_time, updated_at
            )
            SELECT s.date_key,
                   COUNT(*)::integer,
                   COALESCE(SUM(s.readonly_stock_count), 0)::bigint,
                   COALESCE(SUM(s.mycancel), 0)::bigint,
                   COALESCE(SUM(s.success), 0)::bigint,
                   COALESCE(SUM(s.success_value), 0)::numeric(14,2),
                   COALESCE(SUM(GREATEST(s.readonly_stock_count - s.mycancel - s.success, 0)), 0)::bigint,
                   COUNT(DISTINCT NULLIF(s.seller_flow_number, ''))::integer,
                   COALESCE((SELECT unique_buyer_count FROM buyer_daily WHERE buyer_daily.date_key = s.date_key), 0)::integer,
                   COUNT(*) FILTER (WHERE s.seller_flow_number = '0')::integer,
                   MIN(s.trade_id),
                   MAX(s.trade_id),
                   MIN(s.create_time),
                   MAX(s.create_time),
                   NOW()
            FROM ak_trade_summary s
            WHERE s.date_key = $1
            GROUP BY s.date_key
            ON CONFLICT (date_key)
            DO UPDATE SET
                order_count = EXCLUDED.order_count,
                total_stock = EXCLUDED.total_stock,
                total_mycancel = EXCLUDED.total_mycancel,
                total_success = EXCLUDED.total_success,
                total_success_value = EXCLUDED.total_success_value,
                platform_gap = EXCLUDED.platform_gap,
                unique_seller_count = EXCLUDED.unique_seller_count,
                unique_buyer_count = EXCLUDED.unique_buyer_count,
                zero_seller_order_count = EXCLUDED.zero_seller_order_count,
                min_trade_id = EXCLUDED.min_trade_id,
                max_trade_id = EXCLUDED.max_trade_id,
                first_trade_time = EXCLUDED.first_trade_time,
                last_trade_time = EXCLUDED.last_trade_time,
                updated_at = NOW()
            """,
            day,
        )

    async def trade_exists(self, trade_id: int) -> bool:
        pool = self._pool()
        async with pool.acquire() as conn:
            if not await self._table_exists(conn, "ak_trade_summary"):
                return False
            return bool(await conn.fetchval("SELECT EXISTS(SELECT 1 FROM ak_trade_summary WHERE trade_id = $1)", int(trade_id or 0)))

    @staticmethod
    def _parse_datetime(value: Any) -> datetime | None:
        if isinstance(value, datetime):
            return value
        text = str(value or "").strip()
        if not text:
            return None
        for pattern in ("%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
            try:
                return datetime.strptime(text[:19], pattern)
            except Exception:
                pass
        try:
            return datetime.fromisoformat(text.replace("/", "-"))
        except Exception:
            return None
