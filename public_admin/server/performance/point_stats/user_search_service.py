from typing import Dict

from .user_search_repository import fetch_point_stat_user_rows


async def search_point_stat_users(pool, search: str = None, limit: int = 12) -> Dict:
    safe_limit = max(1, min(int(limit or 12), 30))
    keyword = str(search or '').strip()
    async with pool.acquire() as conn:
        rows = await fetch_point_stat_user_rows(conn, keyword, safe_limit)
    return {'rows': rows}
