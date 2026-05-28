from typing import Any, Dict, List


async def fetch_point_stat_user_rows(conn, keyword: str = '', limit: int = 12) -> List[Dict[str, Any]]:
    safe_limit = max(1, min(int(limit or 12), 30))
    normalized_keyword = str(keyword or '').strip()
    if normalized_keyword:
        rows = await conn.fetch('''
            WITH account_pool AS (
                SELECT username FROM point_history_user_summary
                UNION
                SELECT username FROM user_assets
                UNION
                SELECT username FROM user_stats
            )
            SELECT ap.username,
                   COALESCE(NULLIF(us.real_name, ''), '') AS real_name,
                   COALESCE(NULLIF(ua.honor_name, ''), 'M0') AS honor_name,
                   ua.updated_at,
                   COALESCE(phs.record_count, 0) AS point_record_count
            FROM account_pool ap
            LEFT JOIN user_assets ua ON ua.username = ap.username
            LEFT JOIN user_stats us ON us.username = ap.username
            LEFT JOIN point_history_user_summary phs ON phs.username = ap.username
            WHERE ap.username ILIKE $1 OR COALESCE(NULLIF(us.real_name, ''), '') ILIKE $1
            ORDER BY point_record_count DESC, phs.latest_saved_at DESC NULLS LAST, ua.updated_at DESC NULLS LAST
            LIMIT $2
        ''', f'%{normalized_keyword}%', safe_limit)
        if len(rows) < safe_limit:
            usernames = [str(row['username']) for row in rows if row['username']]
            remaining = safe_limit - len(rows)
            fallback_rows = await conn.fetch('''
                WITH history_matches AS (
                    SELECT username
                    FROM point_history_records
                    WHERE username ILIKE $1
                      AND NOT (username = ANY($2::text[]))
                    GROUP BY username
                    ORDER BY MAX(saved_at) DESC
                    LIMIT $3
                )
                SELECT hm.username,
                       COALESCE(NULLIF(us.real_name, ''), '') AS real_name,
                       COALESCE(NULLIF(ua.honor_name, ''), 'M0') AS honor_name,
                       ua.updated_at,
                       COALESCE(phs.record_count, 0) AS point_record_count
                FROM history_matches hm
                LEFT JOIN user_assets ua ON ua.username = hm.username
                LEFT JOIN user_stats us ON us.username = hm.username
                LEFT JOIN point_history_user_summary phs ON phs.username = hm.username
                ORDER BY point_record_count DESC, phs.latest_saved_at DESC NULLS LAST, ua.updated_at DESC NULLS LAST
            ''', f'%{normalized_keyword}%', usernames, remaining)
            rows = list(rows) + list(fallback_rows)
    else:
        rows = await conn.fetch('''
            WITH account_pool AS (
                SELECT username FROM point_history_user_summary
                UNION
                SELECT username FROM user_assets
                UNION
                SELECT username FROM user_stats
            )
            SELECT ap.username,
                   COALESCE(NULLIF(us.real_name, ''), '') AS real_name,
                   COALESCE(NULLIF(ua.honor_name, ''), 'M0') AS honor_name,
                   ua.updated_at,
                   COALESCE(phs.record_count, 0) AS point_record_count
            FROM account_pool ap
            LEFT JOIN user_assets ua ON ua.username = ap.username
            LEFT JOIN user_stats us ON us.username = ap.username
            LEFT JOIN point_history_user_summary phs ON phs.username = ap.username
            ORDER BY point_record_count DESC, phs.latest_saved_at DESC NULLS LAST, ua.updated_at DESC NULLS LAST
            LIMIT $1
        ''', safe_limit)
    return [dict(row) for row in rows]
