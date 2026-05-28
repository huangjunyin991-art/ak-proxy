from typing import Any, Dict, List, Tuple

from .query_filters import PointStatsQuery


async def fetch_unresolved_category_count(conn, query: PointStatsQuery) -> int:
    value = await conn.fetchval(f'''
        SELECT COUNT(*)
        FROM point_history_records
        {query.where_clause}
          AND COALESCE(resolved_category, '') = ''
    ''', *query.args)
    return int(value or 0)


async def fetch_category_page(conn, query: PointStatsQuery, category_name: str,
                              page: int, page_size: int) -> Tuple[int, List[Dict[str, Any]]]:
    category_args = list(query.args)
    category_args.append(category_name)
    category_filters = list(query.filters)
    category_filters.append(f"resolved_category = ${len(category_args)}")
    category_where_clause = f"WHERE {' AND '.join(category_filters)}"
    total = int(await conn.fetchval(f'''
        SELECT COUNT(*)
        FROM point_history_records
        {category_where_clause}
    ''', *category_args) or 0)
    total_pages = max(1, (total + page_size - 1) // page_size)
    current = min(page, total_pages)
    offset = (current - 1) * page_size
    rows = await conn.fetch(f'''
        SELECT record_time, operation_type, amount, balance,
               type_name, type_name_cn, description, saved_at
        FROM point_history_records
        {category_where_clause}
        ORDER BY record_time DESC NULLS LAST, id ASC
        LIMIT ${len(category_args) + 1} OFFSET ${len(category_args) + 2}
    ''', *category_args, page_size, offset)
    return total, [dict(row) for row in rows]


async def fetch_detail_fallback_rows(conn, query: PointStatsQuery) -> List[Dict[str, Any]]:
    rows = await conn.fetch(f'''
        SELECT record_time, operation_type, amount, balance,
               type_name, type_name_cn, description, saved_at
        FROM point_history_records
        {query.where_clause}
        ORDER BY record_time DESC NULLS LAST, id ASC
    ''', *query.args)
    return [dict(row) for row in rows]
