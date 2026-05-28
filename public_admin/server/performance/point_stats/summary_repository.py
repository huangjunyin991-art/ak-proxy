from typing import Any, Dict, List

from .query_filters import PointStatsQuery, point_record_date_text_expr


async def fetch_point_stats_range_row(conn, query: PointStatsQuery) -> Dict[str, Any]:
    date_expr = point_record_date_text_expr()
    row = await conn.fetchrow(f'''
        SELECT MIN({date_expr}) AS start_date,
               MAX({date_expr}) AS end_date
        FROM point_history_records
        {query.base_where_clause}
    ''', *query.base_args)
    return dict(row) if row else {}


async def fetch_point_stats_summary_rows(conn, query: PointStatsQuery) -> List[Dict[str, Any]]:
    rows = await conn.fetch(f'''
        SELECT point_type,
               COUNT(*) AS total_records,
               SUM(CASE WHEN operation_type = 1 THEN ABS(amount) ELSE 0 END) AS total_income,
               SUM(CASE WHEN operation_type <> 1 THEN ABS(amount) ELSE 0 END) AS total_expense,
               SUM(CASE WHEN operation_type = 1 THEN ABS(amount) ELSE -ABS(amount) END) AS net_change,
               COUNT(DISTINCT username) AS account_count,
               MAX(saved_at) AS latest_saved_at
        FROM point_history_records
        {query.where_clause}
        GROUP BY point_type
        ORDER BY point_type
    ''', *query.args)
    return [dict(row) for row in rows]


async def fetch_point_stats_recent_rows(conn, query: PointStatsQuery, limit: int) -> List[Dict[str, Any]]:
    rows = await conn.fetch(f'''
        SELECT username, point_type, record_time, operation_type, amount, balance,
               type_name, type_name_cn, description, saved_at
        FROM point_history_records
        {query.where_clause}
        ORDER BY record_time DESC NULLS LAST, id ASC
        LIMIT ${len(query.args) + 1}
    ''', *query.args, limit)
    return [dict(row) for row in rows]


async def fetch_point_stats_leaderboard_rows(conn, query: PointStatsQuery, limit: int) -> List[Dict[str, Any]]:
    rows = await conn.fetch(f'''
        SELECT username, point_type, COUNT(*) AS total_records,
               SUM(CASE WHEN operation_type = 1 THEN ABS(amount) ELSE 0 END) AS total_income,
               SUM(CASE WHEN operation_type <> 1 THEN ABS(amount) ELSE 0 END) AS total_expense,
               SUM(CASE WHEN operation_type = 1 THEN ABS(amount) ELSE -ABS(amount) END) AS net_change,
               MAX(saved_at) AS latest_saved_at
        FROM point_history_records
        {query.where_clause}
        GROUP BY username, point_type
        ORDER BY net_change DESC NULLS LAST
        LIMIT ${len(query.args) + 1}
    ''', *query.args, limit)
    return [dict(row) for row in rows]


async def fetch_point_stats_active_stats_row(conn, query: PointStatsQuery) -> Dict[str, Any] | None:
    row = await conn.fetchrow(f'''
        SELECT COUNT(*) AS total_records,
               SUM(CASE WHEN operation_type = 1 THEN ABS(amount) ELSE 0 END) AS total_income,
               SUM(CASE WHEN operation_type <> 1 THEN ABS(amount) ELSE 0 END) AS total_expense,
               SUM(CASE WHEN operation_type = 1 THEN ABS(amount) ELSE -ABS(amount) END) AS net_change,
               MAX(saved_at) AS latest_saved_at
        FROM point_history_records
        {query.where_clause}
    ''', *query.args)
    return dict(row) if row else None


async def fetch_point_stats_current_balance(conn, query: PointStatsQuery):
    balance_filters = list(query.filters)
    balance_args = list(query.args)
    balance_filters.append('balance IS NOT NULL')
    balance_where_clause = f"WHERE {' AND '.join(balance_filters)}"
    row = await conn.fetchrow(f'''
        SELECT balance
        FROM point_history_records
        {balance_where_clause}
        ORDER BY record_time DESC NULLS LAST, id ASC
        LIMIT 1
    ''', *balance_args)
    return row['balance'] if row else None


async def fetch_point_stats_unresolved_category_count(conn, query: PointStatsQuery) -> int:
    value = await conn.fetchval(f'''
        SELECT COUNT(*)
        FROM point_history_records
        {query.where_clause}
          AND COALESCE(resolved_category, '') = ''
    ''', *query.args)
    return int(value or 0)


async def fetch_point_stats_category_rows(conn, query: PointStatsQuery) -> List[Dict[str, Any]]:
    rows = await conn.fetch(f'''
        SELECT COALESCE(NULLIF(resolved_category, ''), '未分类') AS name,
               COUNT(*) AS count,
               SUM(CASE WHEN operation_type = 1 THEN ABS(amount) ELSE 0 END) AS income,
               SUM(CASE WHEN operation_type = 1 THEN 0 ELSE ABS(amount) END) AS expense,
               SUM(CASE WHEN operation_type = 1 THEN ABS(amount) ELSE -ABS(amount) END) AS net
        FROM point_history_records
        {query.where_clause}
        GROUP BY COALESCE(NULLIF(resolved_category, ''), '未分类')
        ORDER BY COUNT(*) DESC, MAX(record_time) DESC NULLS LAST
    ''', *query.args)
    return [dict(row) for row in rows]


async def fetch_point_stats_category_fallback_rows(conn, query: PointStatsQuery) -> List[Dict[str, Any]]:
    rows = await conn.fetch(f'''
        SELECT record_time, operation_type, amount, balance,
               type_name, type_name_cn, description, saved_at
        FROM point_history_records
        {query.where_clause}
        ORDER BY record_time DESC NULLS LAST, id ASC
    ''', *query.args)
    return [dict(row) for row in rows]
