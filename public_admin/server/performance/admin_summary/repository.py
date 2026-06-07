from datetime import date
from typing import Any, Dict


async def fetch_admin_summary_row(conn, start_day: date, end_day: date) -> Dict[str, Any]:
    row: Dict[str, Any] = {}
    if await _is_login_rollup_ready(conn):
        row = await _fetch_admin_summary_rollup_row(conn, start_day)
        if row and int(row.get('total_logins') or 0) > 0:
            return row
    has_legacy_rows = await conn.fetchval('SELECT EXISTS (SELECT 1 FROM login_records LIMIT 1)')
    if has_legacy_rows:
        return await _fetch_admin_summary_legacy_row(conn, start_day, end_day)
    if not row:
        row = await _fetch_admin_summary_rollup_row(conn, start_day)
    return row or {}


async def _is_login_rollup_ready(conn) -> bool:
    try:
        state = await conn.fetchrow('''
            SELECT completed_at
            FROM login_aggregate_backfill_state
            WHERE state_key = 'login_records'
        ''')
        if not state or not state['completed_at']:
            return False
        pending = await conn.fetchval('''
            SELECT EXISTS (
                SELECT 1
                FROM login_aggregate_delta
                WHERE source = 'backfill'
                  AND processed_at IS NULL
                LIMIT 1
            )
        ''')
        return not bool(pending)
    except Exception:
        return False


async def _fetch_admin_summary_rollup_row(conn, start_day: date) -> Dict[str, Any]:
    row = await conn.fetchrow('''
        WITH user_counts AS (
            SELECT COUNT(*) AS total_users,
                   COUNT(*) FILTER (
                       WHERE is_banned = TRUE
                         AND NOT EXISTS (
                             SELECT 1
                             FROM ban_list bl
                             WHERE bl.ban_type = 'username'
                               AND bl.ban_value = user_stats.username
                         )
                   ) AS stat_user_bans
            FROM user_stats
        ),
        ip_counts AS (
            SELECT COUNT(*) AS total_ips,
                   COUNT(*) FILTER (
                       WHERE is_banned = TRUE
                         AND NOT EXISTS (
                             SELECT 1
                             FROM ban_list bl
                             WHERE bl.ban_type = 'ip'
                               AND bl.ban_value = ip_stats.ip_address
                         )
                   ) AS stat_ip_bans
            FROM ip_stats
        ),
        login_counts AS (
            SELECT COALESCE(SUM(total_count), 0) AS total_logins,
                   COALESCE(SUM(total_count) FILTER (WHERE login_day = $1), 0) AS today_logins
            FROM login_rollup_daily
        ),
        visible_bans AS (
            SELECT COUNT(*) AS count
            FROM ban_list
            WHERE (is_active = TRUE AND (banned_until IS NULL OR banned_until > NOW()))
               OR COALESCE(released_at, banned_until, banned_at) >= NOW() - INTERVAL '7 days'
        ),
        asset_totals AS (
            SELECT SUM(COALESCE(ace_count, 0) + COALESCE(total_ace, 0)) AS total_ace,
                   SUM(ep) AS total_ep,
                   SUM(sp) AS total_sp,
                   SUM(rp) AS total_rp,
                   SUM(tp) AS total_tp
            FROM user_assets
        )
        SELECT COALESCE(user_counts.total_users, 0) AS total_users,
               COALESCE(ip_counts.total_ips, 0) AS total_ips,
               COALESCE(login_counts.today_logins, 0) AS today_logins,
               COALESCE(visible_bans.count, 0) + COALESCE(user_counts.stat_user_bans, 0) + COALESCE(ip_counts.stat_ip_bans, 0) AS banned_count,
               COALESCE(login_counts.total_logins, 0) AS total_logins,
               COALESCE(asset_totals.total_ace, 0) AS total_ace,
               COALESCE(asset_totals.total_ep, 0) AS total_ep,
               COALESCE(asset_totals.total_sp, 0) AS total_sp,
               COALESCE(asset_totals.total_rp, 0) AS total_rp,
               COALESCE(asset_totals.total_tp, 0) AS total_tp
        FROM user_counts
        CROSS JOIN ip_counts
        CROSS JOIN login_counts
        CROSS JOIN visible_bans
        CROSS JOIN asset_totals
    ''', start_day)
    return dict(row) if row else {}


async def _fetch_admin_summary_legacy_row(conn, start_day: date, end_day: date) -> Dict[str, Any]:
    row = await conn.fetchrow('''
        WITH user_counts AS (
            SELECT COUNT(*) AS total_users,
                   COUNT(*) FILTER (
                       WHERE is_banned = TRUE
                         AND NOT EXISTS (
                             SELECT 1
                             FROM ban_list bl
                             WHERE bl.ban_type = 'username'
                               AND bl.ban_value = user_stats.username
                         )
                   ) AS stat_user_bans
            FROM user_stats
        ),
        ip_counts AS (
            SELECT COUNT(*) AS total_ips,
                   COUNT(*) FILTER (
                       WHERE is_banned = TRUE
                         AND NOT EXISTS (
                             SELECT 1
                             FROM ban_list bl
                             WHERE bl.ban_type = 'ip'
                               AND bl.ban_value = ip_stats.ip_address
                         )
                   ) AS stat_ip_bans
            FROM ip_stats
        ),
        login_counts AS (
            SELECT COUNT(*) AS total_logins,
                   COUNT(*) FILTER (WHERE login_time >= $1 AND login_time < $2) AS today_logins
            FROM login_records
        ),
        visible_bans AS (
            SELECT COUNT(*) AS count
            FROM ban_list
            WHERE (is_active = TRUE AND (banned_until IS NULL OR banned_until > NOW()))
               OR COALESCE(released_at, banned_until, banned_at) >= NOW() - INTERVAL '7 days'
        ),
        asset_totals AS (
            SELECT SUM(COALESCE(ace_count, 0) + COALESCE(total_ace, 0)) AS total_ace,
                   SUM(ep) AS total_ep,
                   SUM(sp) AS total_sp,
                   SUM(rp) AS total_rp,
                   SUM(tp) AS total_tp
            FROM user_assets
        )
        SELECT COALESCE(user_counts.total_users, 0) AS total_users,
               COALESCE(ip_counts.total_ips, 0) AS total_ips,
               COALESCE(login_counts.today_logins, 0) AS today_logins,
               COALESCE(visible_bans.count, 0) + COALESCE(user_counts.stat_user_bans, 0) + COALESCE(ip_counts.stat_ip_bans, 0) AS banned_count,
               COALESCE(login_counts.total_logins, 0) AS total_logins,
               COALESCE(asset_totals.total_ace, 0) AS total_ace,
               COALESCE(asset_totals.total_ep, 0) AS total_ep,
               COALESCE(asset_totals.total_sp, 0) AS total_sp,
               COALESCE(asset_totals.total_rp, 0) AS total_rp,
               COALESCE(asset_totals.total_tp, 0) AS total_tp
        FROM user_counts
        CROSS JOIN ip_counts
        CROSS JOIN login_counts
        CROSS JOIN visible_bans
        CROSS JOIN asset_totals
    ''', start_day, end_day)
    return dict(row) if row else {}
