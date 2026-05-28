from typing import Any, Dict, List


async def fetch_admin_user_list(conn, limit: int, offset: int, search: str = '') -> Dict[str, Any]:
    params: list[Any] = []
    where_clause = ''
    if search:
        params.append(f'%{search}%')
        where_clause = f'''
            WHERE us.username ILIKE $1
               OR COALESCE(NULLIF(us.real_name, ''), NULLIF(aa.nickname, ''), '') ILIKE $1
        '''
    limit_index = len(params) + 1
    offset_index = len(params) + 2
    params.extend([limit, offset])
    rows = await conn.fetch(f'''
        WITH filtered AS (
            SELECT us.username, us.password, us.login_count, us.first_login, us.last_login, us.is_banned,
                   COALESCE(NULLIF(us.real_name, ''), NULLIF(aa.nickname, ''), '') AS real_name,
                   CASE
                       WHEN us.is_banned THEN 'banned'
                       WHEN aa.status = 'active' AND (aa.expire_time IS NULL OR aa.expire_time > NOW()) THEN 'authorized'
                       ELSE 'unauthorized'
                   END AS auth_status
            FROM user_stats us
            LEFT JOIN authorized_accounts aa ON us.username = aa.username AND aa.status = 'active'
            {where_clause}
        ),
        total AS (
            SELECT COUNT(*) AS total_count FROM filtered
        ),
        page_rows AS (
            SELECT *
            FROM filtered
            ORDER BY last_login DESC NULLS LAST
            LIMIT ${limit_index} OFFSET ${offset_index}
        )
        SELECT total.total_count, page_rows.*
        FROM total
        LEFT JOIN page_rows ON TRUE
        ORDER BY page_rows.last_login DESC NULLS LAST
    ''', *params)
    return _list_result_from_rows(rows)


async def fetch_admin_asset_list(conn, limit: int, offset: int, search: str = '',
                                 sort_field: str = 'updated_at', sort_dir: str = 'desc') -> Dict[str, Any]:
    params: list[Any] = []
    where_clause = ''
    if search:
        params.append(f'%{search}%')
        where_clause = f'''
            WHERE ua.username ILIKE $1
               OR COALESCE(NULLIF(us.real_name, ''), '') ILIKE $1
        '''
    limit_index = len(params) + 1
    offset_index = len(params) + 2
    params.extend([limit, offset])
    order = 'ASC' if sort_dir == 'asc' else 'DESC'
    rows = await conn.fetch(f'''
        WITH filtered AS (
            SELECT ua.*,
                   CASE WHEN bl.id IS NOT NULL THEN TRUE ELSE FALSE END AS is_banned,
                   COALESCE(us.login_count, 0) AS login_count,
                   COALESCE(NULLIF(us.real_name, ''), '') AS real_name
            FROM user_assets ua
            LEFT JOIN ban_list bl ON bl.ban_type = 'username' AND bl.ban_value = ua.username AND bl.is_active = TRUE
            LEFT JOIN user_stats us ON us.username = ua.username
            {where_clause}
        ),
        total AS (
            SELECT COUNT(*) AS total_count FROM filtered
        ),
        page_rows AS (
            SELECT *
            FROM filtered
            ORDER BY {sort_field} {order} NULLS LAST
            LIMIT ${limit_index} OFFSET ${offset_index}
        )
        SELECT total.total_count, page_rows.*
        FROM total
        LEFT JOIN page_rows ON TRUE
        ORDER BY page_rows.{sort_field} {order} NULLS LAST
    ''', *params)
    return _list_result_from_rows(rows)


def _list_result_from_rows(rows) -> Dict[str, Any]:
    if not rows:
        return {'total': 0, 'rows': []}
    first = dict(rows[0])
    total = int(first.get('total_count') or 0)
    items: List[Dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item.pop('total_count', None)
        if any(value is not None for value in item.values()):
            items.append(item)
    return {'total': total, 'rows': items}
