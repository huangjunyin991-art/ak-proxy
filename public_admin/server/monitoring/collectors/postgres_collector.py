import asyncio
from datetime import datetime, timezone


def _safe_int(value) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


async def _fetch_with_timeout(awaitable, timeout_seconds: float):
    return await asyncio.wait_for(awaitable, timeout=timeout_seconds)


async def collect_database_snapshot(pool, timeout_seconds: float = 4.0) -> dict:
    data = {
        "available": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "database_size_bytes": 0,
        "active_connections": 0,
        "table_sizes": [],
    }
    async with pool.acquire() as conn:
        row = await _fetch_with_timeout(conn.fetchrow('''
            SELECT pg_database_size(current_database()) AS database_size_bytes,
                   (SELECT COUNT(*) FROM pg_stat_activity WHERE datname = current_database()) AS active_connections
        '''), timeout_seconds)
        if row:
            row_data = dict(row)
            data["database_size_bytes"] = _safe_int(row_data.get("database_size_bytes"))
            data["active_connections"] = _safe_int(row_data.get("active_connections"))
        rows = await _fetch_with_timeout(conn.fetch('''
            SELECT relname AS table_name,
                   pg_total_relation_size(c.oid) AS total_bytes,
                   pg_relation_size(c.oid) AS data_bytes
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind = 'r'
              AND relname IN (
                  -- IM 消息与会话
                  'im_message', 'im_message_mention', 'im_conversation',
                  'im_conversation_member', 'im_conversation_admin',
                  'im_conversation_member_override', 'im_direct_message_gate',
                  -- IM 用户档案与社交
                  'im_user_profile', 'im_user_avatar_history',
                  'im_user_contact', 'im_user_blacklist',
                  -- IM 资产与表情
                  'im_file_asset', 'im_emoji_asset', 'im_media_preview_task',
                  -- IM 会议
                  'im_meetings', 'im_meeting_reads', 'meeting_publish_permissions',
                  -- IM 系统配置
                  'im_system_config',
                  -- 用户与登录
                  'authorized_accounts', 'login_records', 'user_stats',
                  'user_assets', 'ip_stats', 'ban_list',
                  -- 积分与点数
                  'point_history_records', 'credit_config', 'credit_transactions',
                  'admin_point_stats_quota',
                  -- 管理员与权限
                  'admin_tokens', 'admin_totp_secrets', 'admin_operation_leases',
                  'sub_admins', 'sub_admin_account_bindings',
                  'admin_recommend_tree_cache',
                  -- 业务运营
                  'license_logs', 'subscription_groups', 'exit_events',
                  'notification_campaigns', 'notification_deliveries',
                  'system_config'
              )
            ORDER BY pg_total_relation_size(c.oid) DESC
            LIMIT 100
        '''), timeout_seconds)
        data["table_sizes"] = [
            {
                "table_name": str(dict(row).get("table_name") or ""),
                "total_bytes": _safe_int(dict(row).get("total_bytes")),
                "data_bytes": _safe_int(dict(row).get("data_bytes")),
            }
            for row in rows
        ]
    return data
