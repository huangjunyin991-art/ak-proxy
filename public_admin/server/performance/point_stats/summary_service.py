from typing import Callable, Dict

from .backfill import is_record_date_backfill_complete
from .detail_pagination import build_point_categories
from .query_filters import build_point_stats_query
from .summary_repository import (
    fetch_point_stats_active_stats_row,
    fetch_point_stats_category_fallback_rows,
    fetch_point_stats_category_rows,
    fetch_point_stats_current_balance,
    fetch_point_stats_leaderboard_rows,
    fetch_point_stats_range_row,
    fetch_point_stats_recent_rows,
    fetch_point_stats_summary_rows,
    fetch_point_stats_unresolved_category_count,
)


async def build_point_stats(pool, username: str = None, point_type: str = None,
                            limit: int = 50, start_date: str = None, end_date: str = None,
                            resolve_category: Callable = None,
                            format_description: Callable = None) -> Dict:
    safe_limit = max(1, min(int(limit or 50), 200))
    query = build_point_stats_query(
        username=username,
        point_type=point_type,
        start_date=start_date,
        end_date=end_date,
        date_fallback_enabled=not is_record_date_backfill_complete(),
    )
    if resolve_category is None or format_description is None:
        raise ValueError('缺少点数分类处理器')
    async with pool.acquire() as conn:
        range_row = await fetch_point_stats_range_row(conn, query)
        summary_rows = await fetch_point_stats_summary_rows(conn, query)
        recent_rows = await fetch_point_stats_recent_rows(conn, query, safe_limit)
        leaderboard_rows = await fetch_point_stats_leaderboard_rows(conn, query, safe_limit)
        active_stats = None
        categories = []
        if query.username and query.point_type:
            active_stats = await fetch_point_stats_active_stats_row(conn, query)
            if active_stats is not None:
                active_stats['current_balance'] = await fetch_point_stats_current_balance(conn, query)
            unresolved_count = await fetch_point_stats_unresolved_category_count(conn, query)
            if unresolved_count == 0:
                category_rows = await fetch_point_stats_category_rows(conn, query)
                categories = [_category_from_row(row) for row in category_rows]
            else:
                raw_rows = await fetch_point_stats_category_fallback_rows(conn, query)
                categories = build_point_categories(
                    raw_rows,
                    query.point_type or '',
                    resolve_category,
                    format_description,
                    include_records=False,
                )
    return {
        'summary': summary_rows,
        'recent_records': recent_rows,
        'leaderboard': leaderboard_rows,
        'active_stats': active_stats,
        'categories': categories,
        'username': query.username,
        'point_type': query.point_type,
        'date_range': {
            'start': range_row.get('start_date') if range_row else None,
            'end': range_row.get('end_date') if range_row else None,
        },
        'selected_range': {
            'start': query.start_date,
            'end': query.end_date,
        },
    }


def _category_from_row(row: Dict) -> Dict:
    item = dict(row or {})
    return {
        'name': str(item.get('name') or '未分类'),
        'count': int(item.get('count') or 0),
        'income': round(float(item.get('income') or 0), 2),
        'expense': round(float(item.get('expense') or 0), 2),
        'net': round(float(item.get('net') or 0), 2),
        'detail_paged': True,
        'records': [],
    }
