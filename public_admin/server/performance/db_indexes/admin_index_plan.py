from dataclasses import dataclass


@dataclass(frozen=True)
class AdminIndexDefinition:
    name: str
    sql: str
    purpose: str
    risk: str = "large_table_build_may_take_time"


ADMIN_INDEX_PLAN = [
    AdminIndexDefinition(
        name="idx_login_records_login_time",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_login_records_login_time ON login_records(login_time DESC);",
        purpose="dashboard today totals, hourly trend, recent login ordering",
    ),
    AdminIndexDefinition(
        name="idx_login_records_time_username",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_login_records_time_username ON login_records(login_time DESC, username);",
        purpose="dashboard top users and active user aggregation within time ranges",
    ),
    AdminIndexDefinition(
        name="idx_login_records_time_ip",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_login_records_time_ip ON login_records(login_time DESC, ip_address);",
        purpose="dashboard top IP aggregation within time ranges",
    ),
    AdminIndexDefinition(
        name="idx_login_records_auth_failures",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_login_records_auth_failures ON login_records(username, ip_address, request_path, status_code, login_time DESC);",
        purpose="authentication failure and ban-related lookups",
    ),
    AdminIndexDefinition(
        name="idx_login_password_failure_events_lookup",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_login_password_failure_events_lookup ON login_password_failure_events(username, ip_address, occurred_at DESC);",
        purpose="structured password failure counting without scanning login_records extra_data",
    ),
    AdminIndexDefinition(
        name="idx_login_password_failure_events_occurred_at",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_login_password_failure_events_occurred_at ON login_password_failure_events(occurred_at DESC);",
        purpose="structured password failure event retention cleanup",
    ),
    AdminIndexDefinition(
        name="idx_login_password_failure_events_record_id",
        sql="CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_login_password_failure_events_record_id ON login_password_failure_events(login_record_id) WHERE login_record_id IS NOT NULL;",
        purpose="deduplicate structured password failure events backfilled from login_records",
    ),
    AdminIndexDefinition(
        name="idx_login_delta_pending",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_login_delta_pending ON login_aggregate_delta(processed_at, id);",
        purpose="login aggregate worker claims unprocessed deltas without scanning login_records",
    ),
    AdminIndexDefinition(
        name="idx_login_delta_pending_source",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_login_delta_pending_source ON login_aggregate_delta(processed_at, source, id);",
        purpose="login aggregate worker prioritizes live events over historical backfill",
    ),
    AdminIndexDefinition(
        name="idx_login_rollup_minutely_day",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_login_rollup_minutely_day ON login_rollup_minutely(login_day, total_count DESC);",
        purpose="dashboard peak RPM from minute rollup",
    ),
    AdminIndexDefinition(
        name="idx_user_login_rollup_day_count",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_login_rollup_day_count ON user_login_rollup_daily(login_day, total_count DESC, last_login DESC);",
        purpose="dashboard top users from daily rollup",
    ),
    AdminIndexDefinition(
        name="idx_ip_login_rollup_day_count",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ip_login_rollup_day_count ON ip_login_rollup_daily(login_day, total_count DESC, last_seen DESC);",
        purpose="dashboard top IPs from daily rollup",
    ),
    AdminIndexDefinition(
        name="idx_notification_campaigns_created_by_id",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_campaigns_created_by_id ON notification_campaigns(created_by, id DESC);",
        purpose="notification history page selection for scoped sub-admin queries",
    ),
    AdminIndexDefinition(
        name="idx_notification_deliveries_campaign_read",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_deliveries_campaign_read ON notification_deliveries(campaign_id, read_at);",
        purpose="notification history read/unread aggregation for current page campaigns",
    ),
    AdminIndexDefinition(
        name="idx_notification_deliveries_campaign_read_username",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notification_deliveries_campaign_read_username ON notification_deliveries(campaign_id, read_at, username);",
        purpose="notification detail recipient pagination by read status and username ordering",
    ),
    AdminIndexDefinition(
        name="idx_user_stats_last_login",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_stats_last_login ON user_stats(last_login DESC NULLS LAST);",
        purpose="admin user list ordering by recent activity",
    ),
    AdminIndexDefinition(
        name="idx_user_assets_updated_at",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_assets_updated_at ON user_assets(updated_at DESC NULLS LAST);",
        purpose="admin asset list default ordering by latest asset update",
    ),
    AdminIndexDefinition(
        name="idx_authorized_accounts_status_username",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_authorized_accounts_status_username ON authorized_accounts(status, username);",
        purpose="admin user list authorization status join",
    ),
    AdminIndexDefinition(
        name="ext_pg_trgm",
        sql="CREATE EXTENSION IF NOT EXISTS pg_trgm;",
        purpose="enable trigram indexes for admin fuzzy search",
        risk="requires_extension_privilege",
    ),
    AdminIndexDefinition(
        name="idx_authorized_accounts_username_trgm",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_authorized_accounts_username_trgm ON authorized_accounts USING GIN (username gin_trgm_ops);",
        purpose="authorized account fuzzy username search",
    ),
    AdminIndexDefinition(
        name="idx_authorized_accounts_nickname_trgm",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_authorized_accounts_nickname_trgm ON authorized_accounts USING GIN (nickname gin_trgm_ops);",
        purpose="authorized account fuzzy nickname search",
    ),
    AdminIndexDefinition(
        name="idx_user_stats_username_trgm",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_stats_username_trgm ON user_stats USING GIN (username gin_trgm_ops);",
        purpose="admin user fuzzy username search",
    ),
    AdminIndexDefinition(
        name="idx_user_stats_real_name_trgm",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_stats_real_name_trgm ON user_stats USING GIN (real_name gin_trgm_ops);",
        purpose="admin user fuzzy real-name search",
    ),
    AdminIndexDefinition(
        name="idx_user_assets_username_trgm",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_assets_username_trgm ON user_assets USING GIN (username gin_trgm_ops);",
        purpose="admin asset fuzzy username search",
    ),
    AdminIndexDefinition(
        name="idx_authorized_accounts_status_added_by_created",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_authorized_accounts_status_added_by_created ON authorized_accounts(status, added_by, created_at DESC);",
        purpose="risk isolation account list filtering by scope and ordering by account creation time",
    ),
    AdminIndexDefinition(
        name="idx_ban_list_active_username_value",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ban_list_active_username_value ON ban_list(ban_value) WHERE ban_type = 'username' AND is_active = TRUE;",
        purpose="admin asset list active username ban lookup",
    ),
    AdminIndexDefinition(
        name="idx_ban_list_visibility_timestamps",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ban_list_visibility_timestamps ON ban_list(is_active, banned_until, (COALESCE(released_at, banned_until, banned_at)) DESC);",
        purpose="admin stats and ban list active or recently changed visibility checks",
    ),
    AdminIndexDefinition(
        name="idx_user_stats_banned_username",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_stats_banned_username ON user_stats(username) WHERE is_banned = TRUE;",
        purpose="admin stats fallback banned user count from user_stats",
    ),
    AdminIndexDefinition(
        name="idx_ip_stats_banned_ip",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ip_stats_banned_ip ON ip_stats(ip_address) WHERE is_banned = TRUE;",
        purpose="admin stats fallback banned IP count from ip_stats",
    ),
    AdminIndexDefinition(
        name="idx_risk_isolations_active_username",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_risk_isolations_active_username ON risk_isolations(is_active, username);",
        purpose="risk isolation account list active isolation join",
    ),
    AdminIndexDefinition(
        name="idx_user_stats_first_login",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_stats_first_login ON user_stats(first_login DESC NULLS LAST);",
        purpose="dashboard user growth trend by first login time",
    ),
    AdminIndexDefinition(
        name="idx_ip_stats_priority",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ip_stats_priority ON ip_stats(is_banned, request_count DESC, last_seen DESC);",
        purpose="admin IP list filtering and ordering",
    ),
    AdminIndexDefinition(
        name="idx_point_history_user_type_date",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_point_history_user_type_date ON point_history_records(username, point_type, record_date DESC, id ASC);",
        purpose="point statistics account/type date range filtering and ordering",
    ),
    AdminIndexDefinition(
        name="idx_point_history_type_date",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_point_history_type_date ON point_history_records(point_type, record_date DESC, id ASC);",
        purpose="point statistics type-level date range aggregation",
    ),
    AdminIndexDefinition(
        name="idx_point_history_user_type_category_date",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_point_history_user_type_category_date ON point_history_records(username, point_type, resolved_category, record_date DESC, id ASC);",
        purpose="point statistics category detail pagination",
    ),
    AdminIndexDefinition(
        name="idx_point_history_summary_count",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_point_history_summary_count ON point_history_user_summary(record_count DESC, latest_saved_at DESC);",
        purpose="point statistics user search ordering without scanning history records",
    ),
    AdminIndexDefinition(
        name="idx_point_history_user_type_record_time",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_point_history_user_type_record_time ON point_history_records(username, point_type, record_time DESC NULLS LAST, id ASC);",
        purpose="point statistics recent records and current balance ordering for selected account/type",
    ),
    AdminIndexDefinition(
        name="idx_point_history_user_type_category_record_time",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_point_history_user_type_category_record_time ON point_history_records(username, point_type, resolved_category, record_time DESC NULLS LAST, id ASC);",
        purpose="point statistics category detail pagination ordered by record time",
    ),
]


def get_admin_index_plan() -> list[dict[str, str]]:
    return [
        {
            "name": item.name,
            "sql": item.sql,
            "purpose": item.purpose,
            "risk": item.risk,
        }
        for item in ADMIN_INDEX_PLAN
    ]
