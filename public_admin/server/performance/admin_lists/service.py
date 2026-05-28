from typing import Any, Dict

from .repository import fetch_admin_asset_list, fetch_admin_user_list


_ADMIN_ASSET_SORT_FIELDS = frozenset({
    'login_count', 'ace_count', 'total_ace', 'ep', 'sp', 'rp', 'tp',
    'weekly_money', 'left_area', 'right_area', 'direct_push', 'sub_account',
    'honor_name', 'updated_at'
})


async def build_admin_user_list(pool, limit: int = 100, offset: int = 0, search: str = None) -> Dict[str, Any]:
    normalized_limit = _normalize_limit(limit)
    normalized_offset = _normalize_offset(offset)
    normalized_search = str(search or '').strip()
    async with pool.acquire() as conn:
        return await fetch_admin_user_list(conn, normalized_limit, normalized_offset, normalized_search)


async def build_admin_asset_list(pool, limit: int = 100, offset: int = 0, search: str = None,
                                 sort_field: str = 'updated_at', sort_dir: str = 'desc') -> Dict[str, Any]:
    normalized_limit = _normalize_limit(limit)
    normalized_offset = _normalize_offset(offset)
    normalized_search = str(search or '').strip()
    normalized_sort_field = sort_field if sort_field in _ADMIN_ASSET_SORT_FIELDS else 'updated_at'
    normalized_sort_dir = 'asc' if str(sort_dir or '').lower() == 'asc' else 'desc'
    async with pool.acquire() as conn:
        return await fetch_admin_asset_list(
            conn,
            normalized_limit,
            normalized_offset,
            normalized_search,
            normalized_sort_field,
            normalized_sort_dir,
        )


def _normalize_limit(value: int, default: int = 100, maximum: int = 500) -> int:
    try:
        return max(1, min(int(value or default), maximum))
    except (TypeError, ValueError):
        return default


def _normalize_offset(value: int) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0
