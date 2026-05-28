from typing import Callable, Dict

from .detail_pagination import build_point_record_item, normalize_point_detail_page, paginate_point_category_records
from .detail_repository import fetch_category_page, fetch_detail_fallback_rows, fetch_unresolved_category_count
from .query_filters import build_point_stats_query


async def build_point_stats_detail(pool, username: str, point_type: str, category: str,
                                   page: int = 1, page_size: int = 50,
                                   start_date: str = None, end_date: str = None,
                                   resolve_category: Callable = None,
                                   format_description: Callable = None) -> Dict:
    query = build_point_stats_query(
        username=username,
        point_type=point_type,
        start_date=start_date,
        end_date=end_date,
        require_username=True,
        require_point_type=True,
    )
    category_name = str(category or '').strip()
    if not category_name:
        raise ValueError('缺少分类')
    if resolve_category is None or format_description is None:
        raise ValueError('缺少点数分类处理器')
    async with pool.acquire() as conn:
        unresolved_count = await fetch_unresolved_category_count(conn, query)
        if unresolved_count == 0:
            current, size = normalize_point_detail_page(page, page_size)
            total, rows = await fetch_category_page(conn, query, category_name, current, size)
            total_pages = max(1, (total + size - 1) // size)
            if current > total_pages:
                current = total_pages
            records = [
                build_point_record_item(row, query.point_type or '', resolve_category, format_description)[1]
                for row in rows
            ]
            return {
                'category': category_name,
                'page': current,
                'page_size': size,
                'total': total,
                'total_pages': total_pages,
                'records': records,
                'username': query.username,
                'point_type': query.point_type,
                'selected_range': {'start': query.start_date, 'end': query.end_date},
            }
        fallback_rows = await fetch_detail_fallback_rows(conn, query)
    result = paginate_point_category_records(
        fallback_rows,
        query.point_type or '',
        category_name,
        page,
        page_size,
        resolve_category,
        format_description,
    )
    result['username'] = query.username
    result['point_type'] = query.point_type
    result['selected_range'] = {'start': query.start_date, 'end': query.end_date}
    return result
