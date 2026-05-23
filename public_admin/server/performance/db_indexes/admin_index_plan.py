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
        name="idx_user_stats_last_login",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_stats_last_login ON user_stats(last_login DESC NULLS LAST);",
        purpose="admin user list ordering by recent activity",
    ),
    AdminIndexDefinition(
        name="idx_ip_stats_priority",
        sql="CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ip_stats_priority ON ip_stats(is_banned, request_count DESC, last_seen DESC);",
        purpose="admin IP list filtering and ordering",
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
