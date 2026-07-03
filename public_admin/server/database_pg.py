# -*- coding: utf-8 -*-
"""
PostgreSQL 数据库模块 (asyncpg)
参考 monitor/database.py 结构，使用 asyncpg 实现高并发异步读写
连接池采用固定预算；运行期自动扩容默认关闭，避免压力下放大 PostgreSQL 连接数。
"""

import asyncpg
import asyncio
import contextlib
import hashlib
import json
import time
import logging
import os
import re
from functools import lru_cache
import ipaddress
from datetime import datetime, timedelta, date
from typing import Dict, List, Optional, Any

from .db_guard import BigTableGuard, GuardError

from .performance.point_stats import (
    build_point_stats as build_point_stats_result,
    build_point_stats_detail as build_point_stats_detail_result,
    get_point_stats_backfill_status as get_point_stats_backfill_status_result,
    search_point_stat_users as search_point_stat_users_result,
    start_point_stats_backfill as start_point_stats_backfill_result,
)
from .performance.ban_maintenance import ensure_ban_normalized, run_ban_normalization
from .performance.login_guard import (
    PasswordFailureEvent,
    count_recent_password_failures as count_structured_password_failures,
    ensure_login_guard_tables,
    record_login_guard_event,
)
from .performance.login_events import (
    LoginAuditEvent,
    LoginAuditQueue,
    LoginAuditWrite,
    ensure_login_event_tables,
    insert_login_delta,
)
from .performance.notification_history import build_notification_campaign_page
from .performance.admin_summary import build_admin_summary
from .performance.admin_lists import build_admin_asset_list, build_admin_user_list
from .performance.dashboard_stats import build_traffic_dashboard, build_user_growth_periods
from .runtime_performance import DbAcquireMetrics, InstrumentedPool
from .db.bulk_writer import execute_bulk_unnest, rows_to_columns
from .db.sql_policy import classify_admin_sql
from .login_account_hint import find_best_account_match, normalize_login_account
from .security.credentials import has_credential, is_credential_key, mask_credential

logger = logging.getLogger("TransparentProxy.DB")

_POINT_HISTORY_BULK_UPSERT_SQL = '''
    INSERT INTO point_history_records (
        username, point_type, record_key, record_time, record_date, resolved_category, operation_type,
        amount, balance, type_name, type_name_cn, description, raw_data, saved_at
    )
    SELECT username, point_type, record_key, record_time, record_date, resolved_category, operation_type,
           amount, balance, type_name, type_name_cn, description, raw_data::jsonb, saved_at
    FROM UNNEST(
        $1::text[], $2::text[], $3::text[], $4::text[], $5::date[], $6::text[], $7::integer[],
        $8::double precision[], $9::double precision[], $10::text[], $11::text[], $12::text[],
        $13::text[], $14::timestamp[]
    ) AS rows(
        username, point_type, record_key, record_time, record_date, resolved_category, operation_type,
        amount, balance, type_name, type_name_cn, description, raw_data, saved_at
    )
    ON CONFLICT(username, point_type, record_key) DO UPDATE SET
        record_time = EXCLUDED.record_time,
        record_date = EXCLUDED.record_date,
        resolved_category = EXCLUDED.resolved_category,
        operation_type = EXCLUDED.operation_type,
        amount = EXCLUDED.amount,
        balance = EXCLUDED.balance,
        type_name = EXCLUDED.type_name,
        type_name_cn = EXCLUDED.type_name_cn,
        description = EXCLUDED.description,
        raw_data = EXCLUDED.raw_data,
        saved_at = EXCLUDED.saved_at
'''

_NOTIFICATION_DELIVERY_BULK_INSERT_SQL = '''
    INSERT INTO notification_deliveries
        (campaign_id, username, delivery_status, delivered_at, last_push_at, created_at)
    SELECT campaign_id, username, 'sent', sent_at, sent_at, sent_at
    FROM UNNEST($1::bigint[], $2::text[], $3::timestamp[]) AS rows(campaign_id, username, sent_at)
'''

SENSITIVE_OUTPUT_FIELDS = {
    'password',
    'token',
    'ak_userkey',
    'ak_login_cookies',
    'ak_login_payload',
}


def _get_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)) or default)
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(value, maximum))


ADMIN_SQL_MAX_ROWS = _get_int_env('ADMIN_SQL_MAX_ROWS', 1000, 1, 10000)
ADMIN_SQL_TIMEOUT_MS = _get_int_env('ADMIN_SQL_TIMEOUT_MS', 5000, 500, 60000)


def _admin_token_hash(token: str) -> str:
    return hashlib.sha256(str(token or '').encode('utf-8')).hexdigest()


def _mask_sensitive_value(value: Any) -> str:
    return mask_credential(value)


def _sanitize_output_row(row: Dict[str, Any]) -> Dict[str, Any]:
    sanitized = dict(row)
    for key in list(sanitized.keys()):
        normalized = str(key or '').lower()
        if normalized in SENSITIVE_OUTPUT_FIELDS or 'payload' in normalized or is_credential_key(normalized):
            sanitized[f'has_{normalized}'] = has_credential(sanitized.get(key))
            sanitized[key] = _mask_sensitive_value(sanitized.get(key))
    return sanitized


def _is_trackable_ip_address(ip_address: str) -> bool:
    candidate = str(ip_address or '').strip()
    if not candidate or candidate == 'unknown' or candidate.lower() == 'localhost':
        return False
    try:
        return not ipaddress.ip_address(candidate).is_loopback
    except ValueError:
        return False


def _sanitize_output_rows(rows) -> List[Dict[str, Any]]:
    return [_sanitize_output_row(dict(row)) for row in rows]


_SQL_IDENTIFIER_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')


def _quote_identifier(value: str, kind: str = 'identifier') -> str:
    name = str(value or '').strip()
    if not _SQL_IDENTIFIER_RE.fullmatch(name):
        raise GuardError("invalid_identifier", f"Invalid {kind}")
    return f'"{name}"'


def _quote_existing_column(column_name: str, columns: List[str], kind: str = 'column') -> str:
    if column_name not in columns:
        raise GuardError("invalid_identifier", f"Invalid {kind}")
    return _quote_identifier(column_name, kind)


# 全局连接池
_pool: Optional[asyncpg.Pool] = None
_pool_config: Dict = {}  # 保存连接参数，用于重建池
_expand_lock = asyncio.Lock()  # 扩容锁，防止并发扩容
_POOL_STATE_FILE = os.path.join(os.path.dirname(__file__), ".pool_size")  # 持久化文件
_TABLE_COLUMNS_CACHE: Dict[str, List[str]] = {}
_pool_monitor_task: Optional[asyncio.Task] = None
_pool_metrics = DbAcquireMetrics()
_login_audit_queue: Optional[LoginAuditQueue] = None


def _env_flag(name: str, default: bool = False) -> bool:
    value = str(os.environ.get(name, '')).strip().lower()
    if not value:
        return default
    return value in {'1', 'true', 'yes', 'on'}


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, default))
    except Exception:
        value = int(default)
    return max(int(minimum), min(int(maximum), value))


_DB_POOL_AUTO_EXPAND_ENABLED = _env_flag('AK_DB_POOL_AUTO_EXPAND', False)
_DB_POOL_USE_PERSISTED_MAX = _env_flag('AK_DB_POOL_USE_PERSISTED_MAX', False)
_LOGIN_AUDIT_QUEUE_ENABLED = _env_flag('AK_LOGIN_AUDIT_QUEUE_ENABLED', True)
_LOGIN_AUDIT_QUEUE_MAX_PENDING = _env_int('AK_LOGIN_AUDIT_QUEUE_MAX_PENDING', 5000, 100, 100000)


def _load_persisted_max_size(default: int) -> int:
    """从持久化文件加载上次扩容后的max_size"""
    if not _DB_POOL_USE_PERSISTED_MAX:
        if os.path.exists(_POOL_STATE_FILE):
            logger.warning(
                "检测到历史连接池扩容状态文件，但默认固定连接预算，已忽略；"
                "如确需兼容旧行为可设置 AK_DB_POOL_USE_PERSISTED_MAX=1"
            )
        return default
    try:
        if os.path.exists(_POOL_STATE_FILE):
            with open(_POOL_STATE_FILE, 'r') as f:
                saved = int(f.read().strip())
                if saved > default:
                    logger.info(f"加载持久化连接池上限: {saved}（原始配置: {default}）")
                    return saved
    except Exception:
        pass
    return default


def _persist_max_size(max_size: int):
    """持久化扩容后的max_size"""
    try:
        with open(_POOL_STATE_FILE, 'w') as f:
            f.write(str(max_size))
        logger.info(f"连接池上限已持久化: {max_size}")
    except Exception as e:
        logger.warning(f"持久化连接池上限失败: {e}")


async def _auto_expand_pool():
    """连接池击穿时自动扩容（扩大50%，上限100）"""
    global _pool
    if not _DB_POOL_AUTO_EXPAND_ENABLED:
        logger.warning(
            "连接池已达固定预算且自动扩容已禁用；请查看 pool.acquire 指标、慢 SQL 和请求风暴来源"
        )
        return
    async with _expand_lock:
        if _pool is None:
            return
        current_max = _pool.get_max_size()
        # 再次检查是否真的需要扩容（可能其他协程已经扩了）
        if _pool.get_idle_size() > 0:
            return

        new_max = min(int(current_max * 1.5), 100)  # 扩50%，不超过PG的100
        if new_max <= current_max:
            logger.warning(f"连接池已达上限 {current_max}，无法继续扩容")
            return

        logger.warning(f"连接池击穿！自动扩容: {current_max} → {new_max}")

        # 关闭旧池，创建新池
        old_pool = _pool
        cfg = _pool_config.copy()
        cfg['max_size'] = new_max
        try:
            _pool = InstrumentedPool(await asyncpg.create_pool(**cfg), _pool_metrics)
            await old_pool.close()
            _pool_config['max_size'] = new_max
            _persist_max_size(new_max)
        except Exception as e:
            logger.error(f"扩容失败: {e}，保留旧池")
            _pool = old_pool


async def safe_acquire(timeout: float = 5.0):
    """按固定连接预算获取连接；超时只记录并抛出，不再自动扩容。"""
    pool = _get_pool()
    try:
        return await pool.acquire(timeout=timeout)
    except asyncio.TimeoutError:
        logger.warning("连接池获取超时: timeout=%.1fs auto_expand=%s", timeout, _DB_POOL_AUTO_EXPAND_ENABLED)
        raise


_high_load_count = 0  # 连续高负载计数

async def _pool_monitor():
    """后台监控连接池利用率，连续高负载时自动扩容"""
    global _high_load_count
    while True:
        await asyncio.sleep(30)
        try:
            if _pool is None:
                continue
            total = _pool.get_size()
            idle = _pool.get_idle_size()
            max_sz = _pool.get_max_size()
            usage = (total - idle) / max_sz if max_sz > 0 else 0

            if idle == 0 and total >= max_sz:
                _high_load_count += 1
                logger.warning(f"连接池高负载 [{_high_load_count}/3]: active={total-idle}/{max_sz}, idle={idle}")
                if _high_load_count >= 3:  # 连续3次（90秒）高负载
                    if _DB_POOL_AUTO_EXPAND_ENABLED:
                        await _auto_expand_pool()
                    else:
                        logger.warning("连接池持续饱和但自动扩容关闭，保持固定预算 max_size=%s", max_sz)
                    _high_load_count = 0
            else:
                _high_load_count = 0
        except Exception as e:
            logger.debug(f"连接池监控异常: {e}")


def get_pool_info() -> Dict:
    """获取连接池当前状态"""
    if _pool is None:
        return {"status": "未初始化"}
    return {
        "min_size": _pool.get_min_size(),
        "max_size": _pool.get_max_size(),
        "current_size": _pool.get_size(),
        "idle": _pool.get_idle_size(),
        "active": _pool.get_size() - _pool.get_idle_size(),
        "usage_pct": round(((_pool.get_size() - _pool.get_idle_size()) / _pool.get_max_size()) * 100, 1) if _pool.get_max_size() > 0 else 0,
        "policy": {
            "auto_expand_enabled": _DB_POOL_AUTO_EXPAND_ENABLED,
            "persisted_max_enabled": _DB_POOL_USE_PERSISTED_MAX,
            "fixed_budget": not _DB_POOL_AUTO_EXPAND_ENABLED,
        },
        "acquire_metrics": _pool_metrics.snapshot(),
    }


async def start_login_audit_queue() -> None:
    global _login_audit_queue
    if not _LOGIN_AUDIT_QUEUE_ENABLED:
        logger.info("[LoginAuditQueue] 异步登录审计队列已通过配置关闭")
        return
    if _login_audit_queue is None:
        _login_audit_queue = LoginAuditQueue(
            _write_login_audit_event,
            logger=logger,
            max_pending=_LOGIN_AUDIT_QUEUE_MAX_PENDING,
        )
    await _login_audit_queue.start()


async def stop_login_audit_queue() -> None:
    if _login_audit_queue is not None:
        await _login_audit_queue.stop()


def get_login_audit_queue_snapshot() -> Dict:
    if _login_audit_queue is None:
        return {
            "enabled": _LOGIN_AUDIT_QUEUE_ENABLED,
            "started": False,
            "pending": 0,
            "max_pending": _LOGIN_AUDIT_QUEUE_MAX_PENDING,
            "accepted": 0,
            "written": 0,
            "failed": 0,
            "sync_fallback": 0,
            "last_error": "",
            "last_error_at": 0,
        }
    result = _login_audit_queue.snapshot()
    result["enabled"] = _LOGIN_AUDIT_QUEUE_ENABLED
    return result


async def init_db(host: str = "127.0.0.1", port: int = 5432,
                  database: str = "ak_proxy", user: str = "ak_proxy",
                  password: str = "",
                  min_size: int = 5, max_size: int = 20):
    """初始化数据库连接池并创建表"""
    global _pool, _pool_config, _pool_monitor_task

    # 如果之前扩容过，使用持久化的更大值
    max_size = _load_persisted_max_size(max_size)

    _pool_config = dict(
        host=host, port=port, database=database,
        user=user, password=password,
        min_size=min_size, max_size=max_size,
        command_timeout=30
    )
    _pool = InstrumentedPool(await asyncpg.create_pool(**_pool_config), _pool_metrics)
    logger.info(
        "PostgreSQL 连接池已创建 (pool=%s-%s fixed_budget=%s auto_expand=%s)",
        min_size, max_size, not _DB_POOL_AUTO_EXPAND_ENABLED, _DB_POOL_AUTO_EXPAND_ENABLED
    )

    # 启动连接池监控（每30秒检查，持续高负载时告警；自动扩容默认关闭）
    if _pool_monitor_task is None or _pool_monitor_task.done():
        _pool_monitor_task = asyncio.create_task(_pool_monitor(), name='ak-db-pool-monitor')

    async with _pool.acquire() as conn:
        # 用户登录记录表
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS login_records (
                id BIGSERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                ip_address TEXT NOT NULL,
                user_agent TEXT DEFAULT '',
                login_time TIMESTAMP DEFAULT NOW(),
                request_path TEXT DEFAULT '',
                status_code INTEGER DEFAULT 200,
                login_success BOOLEAN,
                extra_data TEXT DEFAULT ''
            )
        ''')
        await ensure_login_guard_tables(conn)
        await ensure_login_event_tables(conn)

        # 用户统计表
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS user_stats (
                username TEXT PRIMARY KEY,
                password TEXT DEFAULT '',
                login_count INTEGER DEFAULT 0,
                first_login TIMESTAMP,
                last_login TIMESTAMP,
                last_ip TEXT DEFAULT '',
                is_banned BOOLEAN DEFAULT FALSE,
                banned_at TIMESTAMP,
                banned_reason TEXT DEFAULT '',
                real_name TEXT DEFAULT '',
                ak_userkey TEXT DEFAULT '',
                ak_login_cookies TEXT DEFAULT '',
                ak_login_payload TEXT DEFAULT '',
                ak_auth_updated_at TIMESTAMP,
                ak_auth_expires_at TIMESTAMP
            )
        ''')

        # IP统计表
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS ip_stats (
                ip_address TEXT PRIMARY KEY,
                request_count INTEGER DEFAULT 0,
                first_seen TIMESTAMP,
                last_seen TIMESTAMP,
                is_banned BOOLEAN DEFAULT FALSE,
                banned_at TIMESTAMP,
                banned_reason TEXT DEFAULT ''
            )
        ''')

        # 封禁列表
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS ban_list (
                id BIGSERIAL PRIMARY KEY,
                ban_type TEXT NOT NULL,
                ban_value TEXT NOT NULL,
                banned_at TIMESTAMP DEFAULT NOW(),
                banned_reason TEXT DEFAULT '',
                banned_until TIMESTAMP,
                released_at TIMESTAMP,
                is_active BOOLEAN DEFAULT TRUE,
                UNIQUE(ban_type, ban_value)
            )
        ''')

        # 用户资产信息表
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS user_assets (
                id BIGSERIAL PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                ace_count DOUBLE PRECISION DEFAULT 0,
                total_ace DOUBLE PRECISION DEFAULT 0,
                weekly_money DOUBLE PRECISION DEFAULT 0,
                sp DOUBLE PRECISION DEFAULT 0,
                tp DOUBLE PRECISION DEFAULT 0,
                ep DOUBLE PRECISION DEFAULT 0,
                rp DOUBLE PRECISION DEFAULT 0,
                ap DOUBLE PRECISION DEFAULT 0,
                rate DOUBLE PRECISION DEFAULT 0,
                honor_name TEXT DEFAULT '',
                left_area INTEGER DEFAULT 0,
                right_area INTEGER DEFAULT 0,
                direct_push INTEGER DEFAULT 0,
                sub_account INTEGER DEFAULT 0,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        ''')
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS point_history_records (
                id BIGSERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                point_type TEXT NOT NULL,
                record_key TEXT NOT NULL,
                record_time TEXT DEFAULT '',
                record_date DATE,
                resolved_category TEXT DEFAULT '',
                operation_type INTEGER DEFAULT 0,
                amount DOUBLE PRECISION DEFAULT 0,
                balance DOUBLE PRECISION,
                type_name TEXT DEFAULT '',
                type_name_cn TEXT DEFAULT '',
                description TEXT DEFAULT '',
                raw_data JSONB DEFAULT '{}'::jsonb,
                saved_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(username, point_type, record_key)
            )
        ''')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_point_history_records_user_type_time ON point_history_records(username, point_type, saved_at DESC)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_point_history_records_type_time ON point_history_records(point_type, saved_at DESC)')
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS ak_trade_summary (
                trade_id INTEGER PRIMARY KEY,
                single_price NUMERIC(4, 3) NOT NULL CHECK (single_price >= 0 AND single_price <= 0.400),
                readonly_stock_count INTEGER NOT NULL CHECK (readonly_stock_count >= 0 AND readonly_stock_count <= 99999),
                mycancel INTEGER NOT NULL CHECK (mycancel >= 0 AND mycancel <= readonly_stock_count),
                success INTEGER NOT NULL CHECK (success >= 0 AND success <= readonly_stock_count),
                success_value NUMERIC(10, 3) NOT NULL CHECK (success_value >= 0),
                create_time TIMESTAMP NOT NULL,
                date_key DATE NOT NULL,
                seller_flow_number VARCHAR(12) NOT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        ''')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ak_trade_summary_date ON ak_trade_summary(date_key)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ak_trade_summary_date_price ON ak_trade_summary(date_key, single_price)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ak_trade_summary_time ON ak_trade_summary(create_time DESC, trade_id DESC)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ak_trade_summary_seller_time ON ak_trade_summary(seller_flow_number, create_time DESC, trade_id DESC)')
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS ak_trade_buyers (
                trade_id INTEGER NOT NULL REFERENCES ak_trade_summary(trade_id) ON DELETE CASCADE,
                buyer_flow_number VARCHAR(12) NOT NULL,
                ak_amount INTEGER NOT NULL CHECK (ak_amount >= 0 AND ak_amount <= 99999),
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        ''')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ak_trade_buyers_trade ON ak_trade_buyers(trade_id)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ak_trade_buyers_flow_trade ON ak_trade_buyers(buyer_flow_number, trade_id)')
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS ak_trade_fetch_state (
                trade_id INTEGER PRIMARY KEY,
                fetch_status VARCHAR(16) NOT NULL DEFAULT 'pending',
                attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
                last_error VARCHAR(500),
                first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
                last_attempt_at TIMESTAMP,
                fetched_at TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        ''')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ak_trade_fetch_state_status ON ak_trade_fetch_state(fetch_status, updated_at DESC)')
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS ak_daily_summary (
                date_key DATE PRIMARY KEY,
                order_count INTEGER NOT NULL DEFAULT 0 CHECK (order_count >= 0),
                total_stock BIGINT NOT NULL DEFAULT 0 CHECK (total_stock >= 0),
                total_mycancel BIGINT NOT NULL DEFAULT 0 CHECK (total_mycancel >= 0),
                total_success BIGINT NOT NULL DEFAULT 0 CHECK (total_success >= 0),
                total_success_value NUMERIC(14, 3) NOT NULL DEFAULT 0 CHECK (total_success_value >= 0),
                platform_gap BIGINT NOT NULL DEFAULT 0 CHECK (platform_gap >= 0),
                unique_seller_count INTEGER NOT NULL DEFAULT 0 CHECK (unique_seller_count >= 0),
                unique_buyer_count INTEGER NOT NULL DEFAULT 0 CHECK (unique_buyer_count >= 0),
                zero_seller_order_count INTEGER NOT NULL DEFAULT 0 CHECK (zero_seller_order_count >= 0),
                min_trade_id INTEGER,
                max_trade_id INTEGER,
                first_trade_time TIMESTAMP,
                last_trade_time TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        ''')
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS ak_scan_runtime (
                scan_name VARCHAR(64) PRIMARY KEY,
                running BOOLEAN NOT NULL DEFAULT FALSE,
                direction VARCHAR(16) NOT NULL DEFAULT 'forward',
                current_trade_id INTEGER,
                target_trade_id INTEGER,
                last_saved_trade_id INTEGER,
                last_seen_create_time TIMESTAMP,
                last_trigger_trade_id INTEGER,
                current_account_username VARCHAR(64),
                account_switch_count INTEGER NOT NULL DEFAULT 0,
                next_check_at TIMESTAMP,
                last_check_skipped_at TIMESTAMP,
                last_check_skip_reason VARCHAR(100),
                status VARCHAR(24) NOT NULL DEFAULT 'idle',
                last_error VARCHAR(500),
                started_at TIMESTAMP,
                finished_at TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        ''')
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS ak_data_config (
                config_key VARCHAR(64) PRIMARY KEY,
                config_value TEXT NOT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        ''')
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS point_history_user_summary (
                username TEXT PRIMARY KEY,
                record_count BIGINT NOT NULL DEFAULT 0,
                latest_saved_at TIMESTAMP
            )
        ''')

        # 管理员Token持久化表
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS admin_tokens (
                token TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                expire DOUBLE PRECISION NOT NULL,
                sub_name TEXT DEFAULT ''
            )
        ''')

        await conn.execute('''
            CREATE TABLE IF NOT EXISTS admin_token_invalidations (
                token_hash TEXT PRIMARY KEY,
                reason TEXT NOT NULL,
                role TEXT DEFAULT '',
                sub_name TEXT DEFAULT '',
                invalidated_at TIMESTAMP DEFAULT NOW()
            )
        ''')

        await conn.execute('''
            CREATE TABLE IF NOT EXISTS im_switch_tokens (
                token_hash TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                conversation_id BIGINT NOT NULL DEFAULT 0,
                nonce TEXT NOT NULL,
                issued_at TIMESTAMP NOT NULL,
                used_at TIMESTAMP NOT NULL DEFAULT NOW(),
                expires_at TIMESTAMP NOT NULL,
                client_ip TEXT DEFAULT '',
                user_agent TEXT DEFAULT ''
            )
        ''')

        await conn.execute('''
            CREATE TABLE IF NOT EXISTS ws_tickets (
                token_hash TEXT PRIMARY KEY,
                audience TEXT NOT NULL,
                subject TEXT NOT NULL,
                role TEXT DEFAULT '',
                resource_type TEXT DEFAULT '',
                resource_id TEXT DEFAULT '',
                site TEXT DEFAULT '',
                readonly BOOLEAN DEFAULT FALSE,
                claims JSONB DEFAULT '{}'::jsonb,
                issued_at TIMESTAMP NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                consumed_at TIMESTAMP,
                client_ip TEXT DEFAULT '',
                user_agent TEXT DEFAULT '',
                consume_ip TEXT DEFAULT '',
                consume_user_agent TEXT DEFAULT ''
            )
        ''')

        await conn.execute('''
            CREATE TABLE IF NOT EXISTS ws_ticket_events (
                id BIGSERIAL PRIMARY KEY,
                event_type TEXT NOT NULL,
                code TEXT DEFAULT '',
                audience TEXT DEFAULT '',
                subject TEXT DEFAULT '',
                role TEXT DEFAULT '',
                resource_type TEXT DEFAULT '',
                resource_id TEXT DEFAULT '',
                site TEXT DEFAULT '',
                client_ip TEXT DEFAULT '',
                user_agent TEXT DEFAULT '',
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        ''')

        await conn.execute('''
            CREATE TABLE IF NOT EXISTS admin_login_ban_levels (
                ip_address TEXT PRIMARY KEY,
                level INTEGER NOT NULL DEFAULT 0,
                updated_at TIMESTAMP DEFAULT NOW(),
                last_banned_until TIMESTAMP
            )
        ''')

        await conn.execute('''
            CREATE TABLE IF NOT EXISTS admin_totp_secrets (
                identity TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                sub_name TEXT DEFAULT '',
                secret TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        ''')

        await conn.execute('''
            CREATE TABLE IF NOT EXISTS admin_operation_leases (
                lease_token TEXT PRIMARY KEY,
                admin_token TEXT NOT NULL,
                role TEXT NOT NULL,
                sub_name TEXT DEFAULT '',
                scope TEXT NOT NULL,
                expire DOUBLE PRECISION NOT NULL,
                client_ip TEXT DEFAULT '',
                user_agent TEXT DEFAULT '',
                issued_at TIMESTAMP DEFAULT NOW(),
                last_used_at TIMESTAMP
            )
        ''')

        # 子管理员表
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS sub_admins (
                name TEXT PRIMARY KEY,
                password TEXT NOT NULL,
                permissions TEXT DEFAULT '{}',
                created_at TIMESTAMP DEFAULT NOW()
            )
        ''')

        # 激活码操作日志表
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS license_logs (
                id BIGSERIAL PRIMARY KEY,
                action TEXT NOT NULL,
                license_key TEXT,
                product_id TEXT,
                billing_mode TEXT,
                detail TEXT,
                operator TEXT DEFAULT 'admin',
                created_at TIMESTAMP DEFAULT NOW()
            )
        ''')

        # 授权账号白名单表
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS authorized_accounts (
                id BIGSERIAL PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password TEXT DEFAULT '',
                added_by TEXT NOT NULL,
                plan_type TEXT NOT NULL DEFAULT 'monthly',
                credits_cost INTEGER NOT NULL DEFAULT 0,
                start_time TIMESTAMP NOT NULL DEFAULT NOW(),
                expire_time TIMESTAMP NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                nickname TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        ''')

        await conn.execute('''
            CREATE TABLE IF NOT EXISTS sub_admin_account_bindings (
                sub_name TEXT PRIMARY KEY REFERENCES sub_admins(name) ON DELETE CASCADE,
                account_username TEXT NOT NULL,
                bound_by TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(account_username)
            )
        ''')
        # 方案 B：允许绑定尚未加入 authorized_accounts 的用户名，
        # 对存量部署幂等清理旧外键（若存在）
        await conn.execute('''
            ALTER TABLE sub_admin_account_bindings
            DROP CONSTRAINT IF EXISTS sub_admin_account_bindings_account_username_fkey
        ''')

        # 积分定价配置表
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS credit_config (
                id SERIAL PRIMARY KEY,
                plan_type TEXT NOT NULL UNIQUE,
                plan_name TEXT NOT NULL,
                credits_cost INTEGER NOT NULL,
                duration_days INTEGER NOT NULL,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        ''')

        # 积分流水表
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS credit_transactions (
                id BIGSERIAL PRIMARY KEY,
                admin_name TEXT NOT NULL,
                type TEXT NOT NULL,
                amount INTEGER NOT NULL,
                balance_after INTEGER NOT NULL DEFAULT 0,
                description TEXT DEFAULT '',
                related_username TEXT DEFAULT '',
                operator TEXT NOT NULL DEFAULT 'system',
                created_at TIMESTAMP DEFAULT NOW()
            )
        ''')

        # sub_admins 表添加 credits 字段（兼容旧表）
        try:
            await conn.execute("ALTER TABLE sub_admins ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 0")
        except Exception:
            pass
        try:
            await conn.execute("ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS ak_userkey TEXT DEFAULT ''")
            await conn.execute("ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS ak_login_cookies TEXT DEFAULT ''")
            await conn.execute("ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS ak_login_payload TEXT DEFAULT ''")
            await conn.execute("ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS ak_auth_updated_at TIMESTAMP")
            await conn.execute("ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS ak_auth_expires_at TIMESTAMP")
            await conn.execute("ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS active_login_device_id TEXT DEFAULT ''")
            await conn.execute("ALTER TABLE user_stats ADD COLUMN IF NOT EXISTS real_name TEXT DEFAULT ''")
            await conn.execute("ALTER TABLE ip_stats ADD COLUMN IF NOT EXISTS preban_count INTEGER DEFAULT 0")
            await conn.execute("ALTER TABLE ip_stats ADD COLUMN IF NOT EXISTS preban_first_seen TIMESTAMP")
            await conn.execute("ALTER TABLE ip_stats ADD COLUMN IF NOT EXISTS preban_last_seen TIMESTAMP")
            await conn.execute("ALTER TABLE ip_stats ADD COLUMN IF NOT EXISTS preban_reason TEXT DEFAULT ''")
            await conn.execute("ALTER TABLE login_records ADD COLUMN IF NOT EXISTS login_success BOOLEAN")
            await conn.execute("ALTER TABLE point_history_records ADD COLUMN IF NOT EXISTS record_date DATE")
            await conn.execute("ALTER TABLE point_history_records ADD COLUMN IF NOT EXISTS resolved_category TEXT DEFAULT ''")
            await conn.execute("ALTER TABLE ban_list ADD COLUMN IF NOT EXISTS released_at TIMESTAMP")
            await conn.execute("ALTER TABLE ak_trade_fetch_state ADD COLUMN IF NOT EXISTS fetch_status VARCHAR(16) DEFAULT 'pending'")
            await conn.execute("ALTER TABLE ak_trade_fetch_state ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 0")
            await conn.execute("ALTER TABLE ak_trade_fetch_state ADD COLUMN IF NOT EXISTS last_error VARCHAR(500)")
            await conn.execute("ALTER TABLE ak_trade_fetch_state ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMP DEFAULT NOW()")
            await conn.execute("ALTER TABLE ak_trade_fetch_state ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMP")
            await conn.execute("ALTER TABLE ak_trade_fetch_state ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMP")
            await conn.execute("ALTER TABLE ak_trade_fetch_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()")
            await conn.execute("ALTER TABLE authorized_accounts DROP COLUMN IF EXISTS persistent_login")
            await conn.execute("ALTER TABLE authorized_accounts DROP COLUMN IF EXISTS remark")
        except Exception:
            pass

        try:
            await conn.execute('''
                UPDATE user_stats us
                SET real_name = aa.nickname
                FROM authorized_accounts aa
                WHERE us.username = aa.username
                  AND COALESCE(us.real_name, '') = ''
                  AND COALESCE(aa.nickname, '') <> ''
            ''')
        except Exception:
            pass

        try:
            await conn.execute('''
                INSERT INTO user_stats (username)
                SELECT aa.username
                FROM authorized_accounts aa
                LEFT JOIN user_stats us ON us.username = aa.username
                WHERE aa.status = 'active'
                  AND us.username IS NULL
            ''')
        except Exception:
            pass

        # 初始化默认积分定价（如果表为空）
        existing = await conn.fetchval("SELECT COUNT(*) FROM credit_config")
        if existing == 0:
            await conn.execute('''
                INSERT INTO credit_config (plan_type, plan_name, credits_cost, duration_days) VALUES
                ('monthly', '月付', 100, 30),
                ('quarterly', '季付', 270, 90),
                ('yearly', '年付', 1000, 365)
            ''')

        await conn.execute('''
            CREATE TABLE IF NOT EXISTS subscription_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                source_type TEXT DEFAULT 'url',
                source_url TEXT DEFAULT '',
                import_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                total_servers INTEGER DEFAULT 0,
                active_servers INTEGER DEFAULT 0,
                created_by TEXT DEFAULT 'admin',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                notes TEXT DEFAULT ''
            )
        ''')
        try:
            await conn.execute("ALTER TABLE subscription_groups ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT ''")
        except Exception:
            pass

        # 出口风控事件表（403/429 持久化）
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS exit_events (
                id BIGSERIAL PRIMARY KEY,
                exit_name TEXT NOT NULL,
                exit_ip   TEXT DEFAULT '',
                client_ip TEXT DEFAULT '',
                account TEXT DEFAULT '',
                status_code INTEGER NOT NULL,
                api_path TEXT DEFAULT '',
                ts TIMESTAMP DEFAULT NOW()
            )
        ''')
        await conn.execute("ALTER TABLE exit_events ADD COLUMN IF NOT EXISTS client_ip TEXT DEFAULT ''")
        await conn.execute("ALTER TABLE exit_events ADD COLUMN IF NOT EXISTS account TEXT DEFAULT ''")
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_exit_events_name ON exit_events(exit_name)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_exit_events_client_ip ON exit_events(client_ip)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_exit_events_account ON exit_events(account)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_exit_events_ts ON exit_events(ts)')

        # 通知系统表
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS notification_campaigns (
                id BIGSERIAL PRIMARY KEY,
                notification_type TEXT NOT NULL,
                title TEXT DEFAULT '',
                content TEXT DEFAULT '',
                payload_json TEXT DEFAULT '{}',
                audience_mode TEXT NOT NULL DEFAULT 'manual',
                audience_snapshot_json TEXT DEFAULT '{}',
                created_by TEXT NOT NULL DEFAULT 'system',
                target_count INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT NOW(),
                published_at TIMESTAMP DEFAULT NOW()
            )
        ''')
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS notification_deliveries (
                id BIGSERIAL PRIMARY KEY,
                campaign_id BIGINT NOT NULL REFERENCES notification_campaigns(id) ON DELETE CASCADE,
                username TEXT NOT NULL,
                delivery_status TEXT NOT NULL DEFAULT 'sent',
                delivered_at TIMESTAMP DEFAULT NOW(),
                read_at TIMESTAMP,
                last_push_at TIMESTAMP DEFAULT NOW(),
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(campaign_id, username)
            )
        ''')
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS meeting_publish_permissions (
                username TEXT PRIMARY KEY,
                can_publish_owned BOOLEAN NOT NULL DEFAULT FALSE,
                can_publish_all BOOLEAN NOT NULL DEFAULT FALSE,
                granted_by TEXT NOT NULL DEFAULT '',
                scope_owner TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        ''')

        await conn.execute('''
            CREATE TABLE IF NOT EXISTS admin_recommend_tree_cache (
                account TEXT PRIMARY KEY,
                root_rid TEXT DEFAULT '',
                payload_json TEXT NOT NULL DEFAULT '{}',
                node_count INTEGER NOT NULL DEFAULT 0,
                max_depth INTEGER NOT NULL DEFAULT 0,
                branch_count INTEGER NOT NULL DEFAULT 0,
                leaf_count INTEGER NOT NULL DEFAULT 0,
                source_status TEXT NOT NULL DEFAULT 'success',
                source_error TEXT DEFAULT '',
                fetched_at TIMESTAMP DEFAULT NOW(),
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        ''')

        # 点数统计配额表：每个管理员每天最多操作 3 个不同账号；同 (admin, 账号, 类型) 5 分钟冷却
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS admin_point_stats_quota (
                admin_id TEXT NOT NULL,
                target_account TEXT NOT NULL,
                point_type TEXT NOT NULL,
                used_at TIMESTAMP NOT NULL DEFAULT NOW(),
                PRIMARY KEY (admin_id, target_account, point_type)
            )
        ''')

        # 创建索引
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_sub_groups_created_by ON subscription_groups(created_by)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_username ON login_records(username)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_ip ON login_records(ip_address)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_time ON login_records(login_time)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ban_active ON ban_list(is_active)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_auth_accounts_username ON authorized_accounts(username)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_auth_accounts_added_by ON authorized_accounts(added_by)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_auth_accounts_status ON authorized_accounts(status)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_auth_accounts_expire ON authorized_accounts(expire_time)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_credit_tx_admin ON credit_transactions(admin_name)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_credit_tx_time ON credit_transactions(created_at)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_notification_campaigns_created_at ON notification_campaigns(created_at DESC)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_notification_campaigns_created_by ON notification_campaigns(created_by)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_notification_deliveries_username ON notification_deliveries(username)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_notification_deliveries_campaign_id ON notification_deliveries(campaign_id)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_notification_campaigns_created_by_id ON notification_campaigns(created_by, id DESC)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_notification_deliveries_campaign_read ON notification_deliveries(campaign_id, read_at)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_notification_deliveries_campaign_read_username ON notification_deliveries(campaign_id, read_at, username)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_meeting_publish_permissions_scope_owner ON meeting_publish_permissions(scope_owner)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_meeting_publish_permissions_granted_by ON meeting_publish_permissions(granted_by)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_notification_deliveries_unread ON notification_deliveries(username, read_at)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_recommend_tree_cache_fetched_at ON admin_recommend_tree_cache(fetched_at DESC)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_admin_operation_leases_admin_token ON admin_operation_leases(admin_token)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_admin_operation_leases_scope_expire ON admin_operation_leases(scope, expire)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_admin_operation_leases_expire ON admin_operation_leases(expire)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_admin_point_stats_quota_admin_used ON admin_point_stats_quota(admin_id, used_at)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_im_switch_tokens_expires_at ON im_switch_tokens(expires_at)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_im_switch_tokens_username_used ON im_switch_tokens(username, used_at DESC)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ws_tickets_expires_at ON ws_tickets(expires_at)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ws_tickets_subject_audience ON ws_tickets(subject, audience)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ws_tickets_resource ON ws_tickets(audience, resource_type, resource_id)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ws_ticket_events_created_at ON ws_ticket_events(created_at DESC)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ws_ticket_events_type_audience_created_at ON ws_ticket_events(event_type, audience, created_at DESC)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ws_ticket_events_code_created_at ON ws_ticket_events(code, created_at DESC)')

    logger.info("PostgreSQL 数据库表和索引已就绪")


async def close_db():
    """关闭连接池"""
    global _pool, _pool_monitor_task
    if _pool_monitor_task:
        _pool_monitor_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _pool_monitor_task
        _pool_monitor_task = None
    if _pool:
        await _pool.close()
        _pool = None
        logger.info("PostgreSQL 连接池已关闭")


def _get_pool():
    if _pool is None:
        raise RuntimeError("数据库未初始化，请先调用 init_db()")
    return _pool


@lru_cache(maxsize=1)
def get_big_table_guard():
    return BigTableGuard(pool_supplier=_get_pool)


async def _get_table_columns(table_name: str, conn=None) -> List[str]:
    cached = _TABLE_COLUMNS_CACHE.get(table_name)
    if cached:
        return cached

    async def _fetch_columns(active_conn):
        rows = await active_conn.fetch(
            '''
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1
            ORDER BY ordinal_position
            ''',
            table_name,
        )
        return [r['column_name'] for r in rows]

    if conn is None:
        pool = _get_pool()
        async with pool.acquire() as active:
            columns = await _fetch_columns(active)
    else:
        columns = await _fetch_columns(conn)

    _TABLE_COLUMNS_CACHE[table_name] = columns
    return columns


# ===== 登录记录 =====

async def record_login(username: str, ip_address: str, user_agent: str = "",
                       request_path: str = "", status_code: int = 200,
                       is_success: bool = True, password: str = "",
                       extra_data: str = "", password_failure: bool = False):
    """
    Record minimal login audit data and enqueue aggregate deltas.

    Expensive counters and rollups are handled by the login event worker so
    /RPC/Login does not wait on statistics writes.
    """
    pool = _get_pool()
    now = datetime.now().replace(microsecond=0)
    username = username.lower() if username else username
    record_username = username or ''

    event = LoginAuditWrite(
        username=record_username,
        ip_address=ip_address or '',
        user_agent=user_agent or '',
        request_path=request_path or '',
        status_code=int(status_code or 200),
        is_success=bool(is_success),
        password=password or '',
        extra_data=extra_data or '',
        password_failure=bool(password_failure),
        login_time=now,
    )

    if not password_failure and _login_audit_queue is not None and _login_audit_queue.enqueue(event):
        return {"queued": True, "sync": False, "fallback": False}

    await _write_login_audit_event(event, pool=pool)
    return {"queued": False, "sync": True, "fallback": bool(not password_failure and _login_audit_queue is not None)}


async def _write_login_audit_event(event: LoginAuditWrite, pool=None) -> None:
    pool = pool or _get_pool()
    record_username = str(event.username or '').strip().lower()
    login_record_id = None

    async with pool.acquire() as conn:
        async with conn.transaction():
            login_record_id = await conn.fetchval('''
                INSERT INTO login_records (username, ip_address, user_agent, login_time, request_path, status_code, login_success, extra_data)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING id
            ''',
                record_username,
                event.ip_address,
                event.user_agent,
                event.login_time,
                event.request_path,
                event.status_code,
                event.is_success,
                event.extra_data,
            )
            audit_event = LoginAuditEvent(
                username=record_username,
                ip_address=event.ip_address,
                user_agent=event.user_agent,
                request_path=event.request_path,
                status_code=event.status_code,
                is_success=event.is_success,
                extra_data=event.extra_data,
                login_time=event.login_time,
                login_record_id=int(login_record_id or 0) or None,
                password_present=bool(event.password),
            )
            await insert_login_delta(conn, audit_event)
            if event.is_success and event.password and record_username and record_username != 'unknown':
                await conn.execute('''
                    INSERT INTO user_stats (username, password)
                    VALUES ($1, $2)
                    ON CONFLICT(username) DO UPDATE SET
                        password = $2
                ''', record_username, event.password)
    if event.password_failure:
        await record_login_guard_event(
            pool,
            PasswordFailureEvent(
                username=record_username,
                ip_address=event.ip_address,
                occurred_at=event.login_time,
                login_record_id=login_record_id,
                is_success=event.is_success,
                is_password_failure=True,
            ),
        )


async def get_recent_logins(limit: int = 50) -> List[Dict]:
    """获取最近登录记录"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT id, username, ip_address, user_agent, login_time, request_path, status_code, login_success, extra_data
            FROM login_records ORDER BY login_time DESC LIMIT $1
        ''', limit)
        return [dict(r) for r in rows]


# ===== 用户统计 =====

async def get_all_users(limit: int = 100, offset: int = 0,
                        search: str = None) -> Dict:
    """获取所有用户统计，返回 {total, rows}"""
    pool = _get_pool()
    result = await build_admin_user_list(pool, limit, offset, search)
    return {'total': result.get('total') or 0, 'rows': _sanitize_output_rows(result.get('rows') or [])}


async def get_user_password(username: str) -> Optional[str]:
    """获取用户最近一次成功登录的密码（用于顶号）"""
    pool = _get_pool()
    username = username.lower() if username else username
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            '''
            SELECT us.password
            FROM user_stats us
            WHERE us.username = $1
              AND COALESCE(us.password, '') <> ''
              AND (
                    COALESCE(us.login_count, 0) > 0
                    OR EXISTS (
                        SELECT 1
                        FROM login_records lr
                        WHERE lr.username = us.username
                          AND lr.request_path = '/RPC/Login'
                          AND lr.login_success IS TRUE
                        LIMIT 1
                    )
              )
            ''', username)
        if row and row['password']:
            return row['password']
        return None


async def find_login_account_hint(username: str, threshold: float = 0.90) -> Optional[Dict]:
    """Find one high-confidence account suggestion for a possible login typo."""
    normalized = normalize_login_account(username)
    if len(normalized) < 4 or len(normalized) > 64:
        return None

    digits = ''.join(ch for ch in normalized if ch.isdigit())
    digit_suffix = digits[-4:] if len(digits) >= 4 else ''
    suffix = normalized[-4:] if len(normalized) >= 4 else normalized
    prefix = normalized[:4] if len(normalized) >= 4 else normalized
    min_len = max(1, len(normalized) - 2)
    max_len = len(normalized) + 2
    pool = _get_pool()
    async with pool.acquire() as conn:
        exact_exists = await conn.fetchval(
            '''
            SELECT EXISTS (
                SELECT 1
                FROM user_stats us
                WHERE us.username = $1
            )
            ''',
            normalized,
        )
        if exact_exists:
            return None
        rows = await conn.fetch(
            '''
            WITH account_pool AS (
                SELECT us.username
                FROM user_stats us
                WHERE COALESCE(us.username, '') <> ''
                  AND us.username <> $1
                  AND COALESCE(length(us.username), 0) BETWEEN $2 AND $3
            )
            SELECT username
            FROM account_pool
            WHERE username ILIKE $4
               OR username ILIKE $5
               OR ($6 <> '' AND username ILIKE $7)
            ORDER BY
                abs(length(username) - length($1)),
                CASE
                    WHEN username ILIKE $4 THEN 0
                    WHEN username ILIKE $5 THEN 1
                    ELSE 2
                END,
                username
            LIMIT 200
            ''',
            normalized,
            min_len,
            max_len,
            f'%{suffix}',
            f'{prefix}%',
            digit_suffix,
            f'%{digit_suffix}' if digit_suffix else '',
        )
    match = find_best_account_match(normalized, [row['username'] for row in rows], threshold=threshold)
    if match is None:
        return None
    return {
        'account': match.account,
        'score': round(float(match.score), 4),
    }


async def _count_recent_login_password_failures_from_logs(username: str, ip_address: str, hours: int = 24) -> int:
    pool = _get_pool()
    username = username.lower() if username else username
    cutoff = datetime.now() - timedelta(hours=hours)
    async with pool.acquire() as conn:
        count = await conn.fetchval('''
            WITH last_success AS (
                SELECT MAX(login_time) AS login_time
                FROM login_records
                WHERE username = $1
                  AND ip_address = $2
                  AND request_path = '/RPC/Login'
                  AND login_success IS TRUE
            )
            SELECT COUNT(*)
            FROM login_records
            WHERE username = $1
              AND ip_address = $2
              AND request_path = '/RPC/Login'
              AND status_code = 401
              AND login_time > COALESCE((SELECT login_time FROM last_success), $3)
              AND login_time >= $3
              AND (
                    extra_data ILIKE '%賬戶或密碼不正確%'
                 OR extra_data ILIKE '%账户或密码错误%'
                 OR extra_data ILIKE '%local_password_mismatch": true%'
                 OR extra_data ILIKE '%local_password_mismatch":true%'
              )
        ''', username or '', ip_address or '', cutoff)
        return int(count or 0)


async def count_recent_login_password_failures(username: str, ip_address: str, hours: int = 24) -> int:
    pool = _get_pool()
    return await count_structured_password_failures(
        pool,
        username,
        ip_address,
        hours,
        fallback_counter=_count_recent_login_password_failures_from_logs,
    )


def _extract_ak_payload_username(login_payload: Dict = None) -> str:
    if not isinstance(login_payload, dict):
        return ''
    containers = []
    user_data = login_payload.get('UserData')
    if isinstance(user_data, dict):
        containers.append(user_data)
    containers.append(login_payload)
    for item in containers:
        if not isinstance(item, dict):
            continue
        for key in ('UserName', 'username', 'Account', 'account', 'Name', 'name'):
            value = item.get(key)
            if value not in (None, ''):
                normalized = str(value).strip().lower()
                if normalized:
                    return normalized
    return ''


async def save_ak_auth_state(username: str, userkey: str = '', cookies: Dict = None,
                             login_payload: Dict = None, ttl_seconds: int = 3600):
    pool = _get_pool()
    username = username.lower() if username else username
    payload_username = _extract_ak_payload_username(login_payload)
    if username and payload_username and username != payload_username:
        logger.warning(
            f"[AKAuthPersistGuard] skip_mismatched_payload layer=database "
            f"target={username} payload_username={payload_username}"
        )
        return
    now = datetime.now().replace(microsecond=0)
    expires_at = now + timedelta(seconds=ttl_seconds)
    cookies_json = json.dumps(cookies or {}, ensure_ascii=False)
    payload_json = json.dumps(login_payload or {}, ensure_ascii=False)
    async with pool.acquire() as conn:
        await conn.execute('''
            INSERT INTO user_stats (username, ak_userkey, ak_login_cookies, ak_login_payload, ak_auth_updated_at, ak_auth_expires_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT(username) DO UPDATE SET
                ak_userkey = $2,
                ak_login_cookies = $3,
                ak_login_payload = $4,
                ak_auth_updated_at = $5,
                ak_auth_expires_at = $6
        ''', username, userkey or '', cookies_json, payload_json, now, expires_at)


async def get_ak_auth_state(username: str) -> Optional[Dict]:
    return await load_ak_auth_state(username, check_expiry=True)


async def load_ak_auth_state(username: str, check_expiry: bool = True) -> Optional[Dict]:
    pool = _get_pool()
    username = username.lower() if username else username
    async with pool.acquire() as conn:
        row = await conn.fetchrow('''
            SELECT ak_userkey, ak_login_cookies, ak_login_payload, ak_auth_updated_at, ak_auth_expires_at
            FROM user_stats WHERE username = $1
        ''', username)
        if not row:
            return None
        expires_at = row['ak_auth_expires_at']
        if check_expiry and (not expires_at or expires_at <= datetime.now()):
            return None
        try:
            cookies = json.loads(row['ak_login_cookies'] or '{}')
        except Exception:
            cookies = {}
        try:
            payload = json.loads(row['ak_login_payload'] or '{}')
        except Exception:
            payload = {}
        return {
            'userkey': row['ak_userkey'] or '',
            'cookies': cookies,
            'login_result': payload,
            'updated_at': row['ak_auth_updated_at'],
            'expires_at': expires_at,
        }


async def clear_ak_auth_state(username: str) -> bool:
    pool = _get_pool()
    username = username.lower() if username else username
    async with pool.acquire() as conn:
        result = await conn.execute('''
            UPDATE user_stats SET
                ak_userkey = '',
                ak_login_cookies = '',
                ak_login_payload = '',
                ak_auth_updated_at = NULL,
                ak_auth_expires_at = NULL
            WHERE username = $1
        ''', username)
        return int(result.split()[-1]) > 0


async def consume_im_switch_token(token_hash: str, username: str, conversation_id: int,
                                  nonce: str, issued_at: datetime, expires_at: datetime,
                                  client_ip: str = '', user_agent: str = '') -> Dict[str, Any]:
    pool = _get_pool()
    normalized_hash = str(token_hash or '').strip()
    normalized_username = str(username or '').strip().lower()
    normalized_nonce = str(nonce or '').strip()
    if not normalized_hash or not normalized_username or not normalized_nonce:
        return {'consumed': False, 'reason': 'missing_token_fields'}
    now = datetime.now().replace(microsecond=0)
    async with pool.acquire() as conn:
        try:
            await conn.execute(
                'DELETE FROM im_switch_tokens WHERE expires_at < $1',
                now - timedelta(days=1),
            )
        except Exception:
            pass
        row = await conn.fetchrow('''
            INSERT INTO im_switch_tokens
                (token_hash, username, conversation_id, nonce, issued_at, used_at, expires_at, client_ip, user_agent)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT(token_hash) DO NOTHING
            RETURNING token_hash
        ''', normalized_hash, normalized_username, int(conversation_id or 0), normalized_nonce,
            issued_at.replace(microsecond=0), now, expires_at.replace(microsecond=0),
            str(client_ip or '')[:120], str(user_agent or '')[:300])
        if row:
            return {'consumed': True, 'reason': 'ok'}
        existing = await conn.fetchrow('''
            SELECT username, conversation_id, used_at, expires_at
            FROM im_switch_tokens
            WHERE token_hash = $1
        ''', normalized_hash)
        if existing:
            return {
                'consumed': False,
                'reason': 'already_used',
                'username': existing['username'],
                'conversation_id': int(existing['conversation_id'] or 0),
                'used_at': existing['used_at'],
                'expires_at': existing['expires_at'],
            }
        return {'consumed': False, 'reason': 'unknown'}


async def clear_user_saved_password(username: str) -> bool:
    pool = _get_pool()
    username = username.lower().strip() if username else ''
    if not username:
        return False
    async with pool.acquire() as conn:
        result = await conn.execute('''
            UPDATE user_stats
            SET password = ''
            WHERE username = $1
        ''', username)
        return int(result.split()[-1]) > 0


async def set_active_login_device_id(username: str, device_id: str) -> bool:
    pool = _get_pool()
    normalized_username = str(username or '').strip().lower()
    normalized_device_id = str(device_id or '').strip()
    if not normalized_username or not normalized_device_id:
        return False
    async with pool.acquire() as conn:
        result = await conn.execute('''
            INSERT INTO user_stats (username, active_login_device_id)
            VALUES ($1, $2)
            ON CONFLICT(username) DO UPDATE SET
                active_login_device_id = $2
        ''', normalized_username, normalized_device_id)
        return int(result.split()[-1]) > 0


async def get_active_login_device_id(username: str) -> str:
    pool = _get_pool()
    normalized_username = str(username or '').strip().lower()
    if not normalized_username:
        return ''
    async with pool.acquire() as conn:
        value = await conn.fetchval(
            'SELECT COALESCE(active_login_device_id, \'\') FROM user_stats WHERE username = $1',
            normalized_username,
        )
        return str(value or '').strip()


async def update_user_saved_password(username: str, password: str) -> bool:
    pool = _get_pool()
    username = username.lower().strip() if username else ''
    normalized_password = str(password or '')
    if not username or not normalized_password:
        return False
    async with pool.acquire() as conn:
        result = await conn.execute('''
            INSERT INTO user_stats (username, password)
            VALUES ($1, $2)
            ON CONFLICT(username) DO UPDATE SET
                password = $2
        ''', username, normalized_password)
        return int(result.split()[-1]) > 0


async def get_user_detail(username: str) -> Optional[Dict]:
    """获取用户详细信息"""
    pool = _get_pool()
    username = username.lower() if username else username
    async with pool.acquire() as conn:
        row = await conn.fetchrow('''
            SELECT us.username, us.password, us.login_count, us.first_login, us.last_login,
                   us.last_ip, us.is_banned,
                   COALESCE(NULLIF(us.real_name, ''), '') as real_name,
                   COALESCE(ua.ace_count, 0) as ace_count,
                   COALESCE(ua.total_ace, 0) as total_ace,
                   COALESCE(ua.weekly_money, 0) as weekly_money,
                   COALESCE(ua.sp, 0) as sp, COALESCE(ua.tp, 0) as tp,
                   COALESCE(ua.ep, 0) as ep, COALESCE(ua.rp, 0) as rp,
                   COALESCE(ua.ap, 0) as ap, COALESCE(ua.lp, 0) as lp,
                   COALESCE(ua.rate, 0) as rate, COALESCE(ua.credit, 0) as credit,
                   COALESCE(ua.honor_name, '') as honor_name,
                   COALESCE(ua.level_number, 0) as level_number,
                   COALESCE(ua.convert_balance, 0) as convert_balance
            FROM user_stats us LEFT JOIN user_assets ua ON us.username = ua.username
            WHERE us.username = $1
        ''', username)
        if not row:
            return None
        user_dict = _sanitize_output_row(dict(row))
        logins = await conn.fetch('''
            SELECT * FROM login_records WHERE username = $1 ORDER BY login_time DESC LIMIT 20
        ''', username)
        user_dict['recent_logins'] = [dict(r) for r in logins]
        return user_dict


async def _upsert_user_stats_identity(conn: asyncpg.Connection, username: str,
                                      password: str = '', real_name: str = '') -> None:
    normalized_username = str(username or '').strip().lower()
    normalized_password = str(password or '')
    normalized_real_name = str(real_name or '').strip()
    if not normalized_username:
        return
    await conn.execute('''
        INSERT INTO user_stats (username, password, real_name)
        VALUES ($1, $2, $3)
        ON CONFLICT(username) DO UPDATE SET
            password = CASE WHEN $2 <> '' THEN $2 ELSE user_stats.password END,
            real_name = CASE WHEN $3 <> '' THEN $3 ELSE user_stats.real_name END
    ''', normalized_username, normalized_password, normalized_real_name)


async def sync_authorized_account_profile(username: str, password: str = '',
                                          real_name: str = ''):
    """同步授权账号中的基础资料到已存在的用户统计记录。"""
    pool = _get_pool()
    username = username.lower() if username else username
    if not username:
        return
    async with pool.acquire() as conn:
        await _upsert_user_stats_identity(conn, username, password, real_name)


async def upsert_user_real_name(username: str, real_name: str) -> bool:
    """写入账号姓名；账号不存在时自动补建 user_stats 记录。"""
    pool = _get_pool()
    username = username.lower().strip() if username else ''
    real_name = real_name.strip() if real_name else ''
    if not username or not real_name:
        return False
    async with pool.acquire() as conn:
        await conn.execute('''
            INSERT INTO user_stats (username, real_name)
            VALUES ($1, $2)
            ON CONFLICT(username) DO UPDATE SET real_name = $2
        ''', username, real_name)
        return True


# ===== 用户资产 =====

async def update_user_assets(username: str, data: Dict):
    """更新用户资产信息"""
    pool = _get_pool()
    username = username.lower() if username else username
    now = datetime.now().replace(microsecond=0)

    has_ace_count = "ACECount" in data
    has_total_ace = "TotalACE" in data
    has_weekly_money = "WeeklyMoney" in data
    has_sp = "SP" in data
    has_tp = "TP" in data
    has_ep = "EP" in data
    has_rp = "RP" in data
    has_ap = "AP" in data
    has_rate = "Rate" in data
    has_honor_name = "HonorName" in data
    has_left_area = "L" in data
    has_right_area = "R" in data
    has_direct_push = "F" in data
    has_sub_account = "S" in data

    ace_count = float(data.get("ACECount", 0) or 0)
    total_ace = float(data.get("TotalACE", 0) or 0)
    weekly_money = float(data.get("WeeklyMoney", 0) or 0)
    sp = float(data.get("SP", 0) or 0)
    tp = float(data.get("TP", 0) or 0)
    ep = float(data.get("EP", 0) or 0)
    rp = float(data.get("RP", 0) or 0)
    ap = float(data.get("AP", 0) or 0)
    rate = float(data.get("Rate", 0) or 0)
    honor_name = str(data.get("HonorName", "") or "")
    left_area = int(data.get("L", 0) or 0)
    right_area = int(data.get("R", 0) or 0)
    direct_push = int(data.get("F", 0) or 0)
    sub_account = int(data.get("S", 0) or 0)

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute('''
                INSERT INTO user_assets (username, ace_count, total_ace, weekly_money,
                    sp, tp, ep, rp, ap, rate, honor_name,
                    left_area, right_area, direct_push, sub_account, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
                ON CONFLICT(username) DO UPDATE SET
                    ace_count=CASE WHEN $17 THEN $2 ELSE user_assets.ace_count END,
                    total_ace=CASE WHEN $18 THEN $3 ELSE user_assets.total_ace END,
                    weekly_money=CASE WHEN $19 THEN $4 ELSE user_assets.weekly_money END,
                    sp=CASE WHEN $20 THEN $5 ELSE user_assets.sp END,
                    tp=CASE WHEN $21 THEN $6 ELSE user_assets.tp END,
                    ep=CASE WHEN $22 THEN $7 ELSE user_assets.ep END,
                    rp=CASE WHEN $23 THEN $8 ELSE user_assets.rp END,
                    ap=CASE WHEN $24 THEN $9 ELSE user_assets.ap END,
                    rate=CASE WHEN $25 THEN $10 ELSE user_assets.rate END,
                    honor_name=CASE WHEN $26 THEN $11 ELSE user_assets.honor_name END,
                    left_area=CASE WHEN $27 THEN $12 ELSE user_assets.left_area END,
                    right_area=CASE WHEN $28 THEN $13 ELSE user_assets.right_area END,
                    direct_push=CASE WHEN $29 THEN $14 ELSE user_assets.direct_push END,
                    sub_account=CASE WHEN $30 THEN $15 ELSE user_assets.sub_account END,
                    updated_at=$16
            ''', username, ace_count, total_ace, weekly_money,
                 sp, tp, ep, rp, ap, rate, honor_name,
                 left_area, right_area, direct_push, sub_account, now,
                 has_ace_count, has_total_ace, has_weekly_money,
                 has_sp, has_tp, has_ep, has_rp, has_ap, has_rate,
                 has_honor_name, has_left_area, has_right_area,
                 has_direct_push, has_sub_account)



async def get_user_assets(username: str) -> Optional[Dict]:
    """获取指定用户资产"""
    pool = _get_pool()
    username = username.lower() if username else username
    async with pool.acquire() as conn:
        row = await conn.fetchrow('SELECT * FROM user_assets WHERE username = $1', username)
        return dict(row) if row else None


async def get_all_user_assets(limit: int = 100, offset: int = 0,
                              search: str = None,
                              sort_field: str = 'updated_at',
                              sort_dir: str = 'desc') -> Dict:
    """获取所有用户资产（含封禁状态）"""
    pool = _get_pool()
    return await build_admin_asset_list(pool, limit, offset, search, sort_field, sort_dir)


_POINT_HISTORY_TYPES = frozenset({'EP', 'SP', 'TP', 'RP'})

def _point_history_type(point_type: str) -> str:
    code = str(point_type or '').strip().upper()
    if code not in _POINT_HISTORY_TYPES:
        raise ValueError(f'不支持的点数类型: {point_type}')
    return code

def _point_float(value, default=None):
    if value is None or value == '':
        return default
    return float(value)

def _point_int(value, default=0):
    if value is None or value == '':
        return default
    return int(value)

def _point_text(value) -> str:
    return str(value or '').strip()


def _normalize_point_date(value) -> Optional[str]:
    text = str(value or '').strip()
    candidate = text[:10]
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', candidate):
        return None
    try:
        return date.fromisoformat(candidate).isoformat()
    except ValueError:
        return None


def _point_record_date(value) -> Optional[date]:
    normalized = _normalize_point_date(value)
    return date.fromisoformat(normalized) if normalized else None


def _point_record_date_text_expr() -> str:
    return "COALESCE(record_date::text, NULLIF(substring(record_time FROM '^\\d{4}-\\d{2}-\\d{2}'), ''))"


def _append_point_date_filters(filters: List[str], args: List[Any], start: Optional[str], end: Optional[str]):
    text_date_expr = "NULLIF(substring(record_time FROM '^\\d{4}-\\d{2}-\\d{2}'), '')"
    if start:
        args.extend([date.fromisoformat(start), start])
        date_index = len(args) - 1
        text_index = len(args)
        filters.append(f"(record_date >= ${date_index} OR (record_date IS NULL AND {text_date_expr} >= ${text_index}))")
    if end:
        args.extend([date.fromisoformat(end), end])
        date_index = len(args) - 1
        text_index = len(args)
        filters.append(f"(record_date <= ${date_index} OR (record_date IS NULL AND {text_date_expr} <= ${text_index}))")


_POINT_TYPE_NAME_MAPS = {
    'EP': {
        'Sumup': '子账户归集',
        'Reward': '奖励',
        'EP -> RP': 'EP转RP',
        'EP -> SP': 'EP转SP',
        'Sell': '挂卖EP',
        'Buy': '购买EP',
        'Service charge': 'EP服务费',
        'Acquisition': 'EP获取',
        'Monthly Fee': '月费',
        'MonthlyFee': '月费',
        'Monthly Fee ': '月费',
        'Freed': 'ULP补偿',
        'Stocksaleincome': '出售AK收入',
        'Transfer out': 'EP转出',
        'Rollback': '系统回滚',
        'Arbitration return': '平台仲裁回款',
        '--': '其他',
    },
    'SP': {
        'EP -> SP': 'EP转SP',
        'EP to SP': 'EP转SP',
        'RP -> SP': 'RP转SP',
        'RP to SP': 'RP转SP',
        'Sumup': '子账户归集',
        'Add sub account': '子账号复投消耗',
        ' Add sub account': '子账号复投消耗',
        'Stocksaleincome-Register': '子账号复投消耗',
        'Stocksaleincome': '股票挂卖收益',
        'Transfer in': 'SP转入',
        'Transfer out': 'SP转出',
        '--': '其他',
    },
    'TP': {
        'Register-Sub': '注册子账号消耗',
        'Register': '注册主账号消耗',
        'Transfer': 'TP转账',
        'Transfer in': 'TP转入',
        'Transfer out': 'TP转出',
        '--': '其他',
    },
    'RP': {
        'EP -> RP': 'EP转RP',
        'EP to RP': 'EP转RP',
        'Register': '注册消耗',
        'Transfer in': 'RP转入',
        'Transfer out': 'RP转出',
        '--': '其他',
    },
}


_RP_UPLIFT_RE = re.compile(r'^T(\d+)\s+Uplift$')


def resolve_point_category(point_type: str, raw_type_name: str, description: str) -> str:
    code = str(point_type or '').strip().upper()
    raw = str(raw_type_name or '').strip()
    desc = str(description or '').strip()
    type_map = _POINT_TYPE_NAME_MAPS.get(code, {})
    if raw == 'Stocksaleincome-Register':
        if '报单减少' in desc:
            return '子账号复投消耗'
        if '总挂卖' in desc or '出售' in desc or '获得EP' in desc:
            return '股票挂卖收益'
        return type_map.get(raw) or raw or '未分类'
    if raw in ('Add sub account', ' Add sub account'):
        return '子账号复投消耗'
    if code == 'TP' and raw == 'Transfer':
        if desc.startswith('From '):
            return 'TP转入'
        if desc.startswith('To '):
            return 'TP转出'
        return 'TP转账'
    if code == 'SP' and desc:
        if 'RP -> SP' in desc or 'RP to SP' in desc:
            return 'RP转SP'
        if 'EP -> SP' in desc or 'EP to SP' in desc:
            return 'EP转SP'
    if code == 'RP' and desc:
        match = _RP_UPLIFT_RE.match(desc)
        if match:
            return f'晋级M{match.group(1)}奖励'
    return type_map.get(raw) or type_map.get(raw.strip()) or raw or '未分类'


_POINT_USER_PAREN_RE = re.compile(r'User\s*[:：]\s*([^,，)）]+?)\s*[（(]\s*([^)）]+)\s*[)）]')
_POINT_INVESTOR_PAREN_RE = re.compile(r'投资人\s*[:：]\s*([^,，)）]+?)\s*[（(]\s*([^)）]+)\s*[)）]')


def _format_point_record_description(category: str, description: str) -> str:
    if not description:
        return description
    if category == '注册子账号消耗':
        m = _POINT_USER_PAREN_RE.search(description)
        if m:
            return f'{m.group(1).strip()}（{m.group(2).strip()}）注册子账号'
    if category == '注册主账号消耗':
        m = _POINT_USER_PAREN_RE.search(description)
        if m:
            return f'{m.group(1).strip()}（{m.group(2).strip()}）注册主账号'
    if category == '子账号复投消耗':
        m = _POINT_INVESTOR_PAREN_RE.search(description)
        if m:
            return f'{m.group(1).strip()}（{m.group(2).strip()}）复投子账号'
    return description


def _point_record_key(record: Dict, index: int) -> str:
    key = _point_text(record.get('id') or record.get('Id') or record.get('FlowNumber') or record.get('flow_number'))
    if key:
        return key
    time_value = _point_text(record.get('time') or record.get('CreateTime') or record.get('Time') or record.get('RecordTime'))
    amount = _point_text(record.get('amount') or record.get('Amount'))
    operation_type = _point_text(record.get('operation_type') or record.get('OperationType'))
    description = _point_text(record.get('description') or record.get('Des'))
    balance = _point_text(record.get('balance') or record.get('SurplusTotalAmount'))
    type_name = _point_text(record.get('type_name') or record.get('TypeName'))
    return f'{time_value}|{operation_type}|{amount}|{balance}|{type_name}|{description}'

def build_point_history_record_key(record: Dict, index: int) -> str:
    return _point_record_key(record, index)


def _normalize_point_history_record(username: str, code: str, record: Dict, index: int, saved_at: datetime):
    if not isinstance(record, dict):
        return None
    record_time = _point_text(record.get('time') or record.get('CreateTime') or record.get('Time') or record.get('RecordTime'))
    type_name = _point_text(record.get('type_name') or record.get('TypeName'))
    description = _point_text(record.get('description') or record.get('Des'))
    return (
        username,
        code,
        _point_record_key(record, index),
        record_time,
        _point_record_date(record_time),
        resolve_point_category(code, type_name, description),
        _point_int(record.get('operation_type') if 'operation_type' in record else record.get('OperationType')),
        _point_float(record.get('amount') if 'amount' in record else record.get('Amount'), 0),
        _point_float(record.get('balance') if 'balance' in record else record.get('SurplusTotalAmount'), None),
        type_name,
        _point_text(record.get('type_name_cn') or record.get('category')),
        description,
        json.dumps(record, ensure_ascii=False),
        saved_at,
    )


async def _refresh_point_history_user_summary(conn, username: str):
    normalized_username = str(username or '').strip().lower()
    if not normalized_username:
        return
    row = await conn.fetchrow('''
        SELECT COUNT(*) AS record_count, MAX(saved_at) AS latest_saved_at
        FROM point_history_records
        WHERE username = $1
    ''', normalized_username)
    record_count = int(row['record_count'] or 0) if row else 0
    if record_count <= 0:
        await conn.execute('DELETE FROM point_history_user_summary WHERE username = $1', normalized_username)
        return
    await conn.execute('''
        INSERT INTO point_history_user_summary (username, record_count, latest_saved_at)
        VALUES ($1, $2, $3)
        ON CONFLICT(username) DO UPDATE SET
            record_count = EXCLUDED.record_count,
            latest_saved_at = EXCLUDED.latest_saved_at
    ''', normalized_username, record_count, row['latest_saved_at'])


async def _upsert_point_history_records_bulk(conn, normalized: List[tuple], operation: str) -> None:
    if not normalized:
        return
    columns = rows_to_columns(normalized, 14)
    await execute_bulk_unnest(
        conn,
        _POINT_HISTORY_BULK_UPSERT_SQL,
        columns,
        operation=operation,
        row_count=len(normalized),
    )


async def get_point_history_record_keys(username: str, point_type: str) -> set:
    pool = _get_pool()
    username = username.lower() if username else username
    code = _point_history_type(point_type)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            'SELECT record_key FROM point_history_records WHERE username = $1 AND point_type = $2',
            username, code
        )
    return {str(row['record_key']) for row in rows}

async def clear_point_history_records(username: str = None, point_type: str = None) -> int:
    pool = _get_pool()
    username = username.lower() if username else None
    code = _point_history_type(point_type) if point_type else None
    filters = []
    args = []
    if username:
        args.append(username)
        filters.append(f'username = ${len(args)}')
    if code:
        args.append(code)
        filters.append(f'point_type = ${len(args)}')
    where_clause = f"WHERE {' AND '.join(filters)}" if filters else ''
    async with pool.acquire() as conn:
        async with conn.transaction():
            affected_users = []
            if username:
                affected_users = [username]
            elif where_clause:
                affected_users = [
                    str(row['username'])
                    for row in await conn.fetch(f'SELECT DISTINCT username FROM point_history_records {where_clause}', *args)
                    if row['username']
                ]
            result = await conn.execute(f'DELETE FROM point_history_records {where_clause}', *args)
            if not where_clause:
                await conn.execute('DELETE FROM point_history_user_summary')
            else:
                for affected_username in affected_users:
                    await _refresh_point_history_user_summary(conn, affected_username)
    return int(result.split()[-1])

async def replace_point_history_records(username: str, point_type: str, records: List[Dict]) -> int:
    pool = _get_pool()
    username = username.lower() if username else username
    code = _point_history_type(point_type)
    saved_at = datetime.now().replace(microsecond=0)
    normalized = []
    for index, record in enumerate(records or []):
        item = _normalize_point_history_record(username, code, record, index, saved_at)
        if item is not None:
            normalized.append(item)
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                'DELETE FROM point_history_records WHERE username = $1 AND point_type = $2',
                username, code
            )
            if not normalized:
                await _refresh_point_history_user_summary(conn, username)
                return 0
            await _upsert_point_history_records_bulk(conn, normalized, "point_history.replace")
            await _refresh_point_history_user_summary(conn, username)
            return len(normalized)

async def save_point_history_records(username: str, point_type: str, records: List[Dict]) -> int:
    pool = _get_pool()
    username = username.lower() if username else username
    code = _point_history_type(point_type)
    saved_at = datetime.now().replace(microsecond=0)
    normalized = []
    for index, record in enumerate(records or []):
        item = _normalize_point_history_record(username, code, record, index, saved_at)
        if item is not None:
            normalized.append(item)
    if not normalized:
        return 0
    async with pool.acquire() as conn:
        async with conn.transaction():
            await _upsert_point_history_records_bulk(conn, normalized, "point_history.save")
            await _refresh_point_history_user_summary(conn, username)
    return len(normalized)

async def get_point_stats(username: str = None, point_type: str = None, limit: int = 50, start_date: str = None, end_date: str = None) -> Dict:
    pool = _get_pool()
    return await build_point_stats_result(
        pool,
        username=username,
        point_type=point_type,
        limit=limit,
        start_date=start_date,
        end_date=end_date,
        resolve_category=resolve_point_category,
        format_description=_format_point_record_description,
    )

async def get_point_stats_detail(username: str, point_type: str, category: str, page: int = 1, page_size: int = 50, start_date: str = None, end_date: str = None) -> Dict:
    pool = _get_pool()
    return await build_point_stats_detail_result(
        pool,
        username=username,
        point_type=point_type,
        category=category,
        page=page,
        page_size=page_size,
        start_date=start_date,
        end_date=end_date,
        resolve_category=resolve_point_category,
        format_description=_format_point_record_description,
    )

async def search_point_stat_users(search: str = None, limit: int = 12) -> Dict:
    pool = _get_pool()
    return await search_point_stat_users_result(pool, search=search, limit=limit)


# ===== 点数统计维护 =====

async def get_point_stats_backfill_status(include_counts: bool = False) -> Dict:
    pool = _get_pool()
    return await get_point_stats_backfill_status_result(pool, include_counts=include_counts)


async def start_point_stats_backfill(batch_size: int = 1000, max_batches: int = 0) -> Dict:
    pool = _get_pool()
    return await start_point_stats_backfill_result(
        pool,
        resolve_category=resolve_point_category,
        batch_size=batch_size,
        max_batches=max_batches,
    )


# ===== 封禁管理 =====

async def ban_user(username: str, reason: str = "", duration_days: int = None):
    """封禁用户"""
    pool = _get_pool()
    now = datetime.now().replace(microsecond=0)
    username = username.lower() if username else username
    banned_until = (now + timedelta(days=duration_days)) if duration_days else None

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute('''
                UPDATE user_stats SET is_banned = TRUE, banned_at = $1, banned_reason = $2
                WHERE username = $3
            ''', now, reason, username)

            await conn.execute('''
                INSERT INTO ban_list (ban_type, ban_value, banned_at, banned_reason, banned_until, is_active)
                VALUES ('username', $1, $2, $3, $4, TRUE)
                ON CONFLICT(ban_type, ban_value) DO UPDATE SET
                    banned_at = $2, banned_reason = $3, banned_until = $4, released_at = NULL, is_active = TRUE
            ''', username, now, reason, banned_until)


async def unban_user(username: str):
    """解封用户"""
    pool = _get_pool()
    username = username.lower() if username else username
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute('''
                UPDATE user_stats SET is_banned = FALSE, banned_at = NULL, banned_reason = ''
                WHERE username = $1
            ''', username)
            await conn.execute('''
                UPDATE ban_list SET is_active = FALSE, released_at = NOW()
                WHERE ban_type = 'username' AND ban_value = $1
            ''', username)


async def ban_ip(ip_address: str, reason: str = "", duration_days: int = None):
    """封禁IP"""
    pool = _get_pool()
    now = datetime.now().replace(microsecond=0)
    banned_until = (now + timedelta(days=duration_days)) if duration_days else None
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute('''
                UPDATE ip_stats
                SET is_banned = TRUE, banned_at = $1, banned_reason = $2,
                    preban_count = 0, preban_first_seen = NULL, preban_last_seen = NULL, preban_reason = ''
                WHERE ip_address = $3
            ''', now, reason, ip_address)
            await conn.execute('''
                INSERT INTO ban_list (ban_type, ban_value, banned_at, banned_reason, banned_until, is_active)
                VALUES ('ip', $1, $2, $3, $4, TRUE)
                ON CONFLICT(ban_type, ban_value) DO UPDATE SET
                    banned_at = $2, banned_reason = $3, banned_until = $4, released_at = NULL, is_active = TRUE
            ''', ip_address, now, reason, banned_until)


async def increment_admin_login_ban_level(ip_address: str, banned_until=None) -> int:
    pool = _get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow('''
            INSERT INTO admin_login_ban_levels (ip_address, level, updated_at, last_banned_until)
            VALUES ($1, 1, NOW(), $2)
            ON CONFLICT(ip_address) DO UPDATE SET
                level = admin_login_ban_levels.level + 1,
                updated_at = NOW(),
                last_banned_until = $2
            RETURNING level
        ''', ip_address, banned_until)
        return int(row['level'] or 1)


async def unban_ip(ip_address: str):
    """解封IP"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute('''
                UPDATE ip_stats
                SET is_banned = FALSE, banned_at = NULL, banned_reason = '',
                    preban_count = 0, preban_first_seen = NULL, preban_last_seen = NULL, preban_reason = ''
                WHERE ip_address = $1
            ''', ip_address)
            await conn.execute('''
                UPDATE ban_list SET is_active = FALSE, released_at = NOW()
                WHERE ban_type = 'ip' AND ban_value = $1
            ''', ip_address)


async def record_ip_preban_event(ip_address: str, reason: str, window_seconds: int = 60) -> Dict:
    pool = _get_pool()
    now = datetime.now().replace(microsecond=0)
    window_start = now - timedelta(seconds=window_seconds)
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                '''
                SELECT preban_count, preban_first_seen, preban_last_seen, is_banned
                FROM ip_stats
                WHERE ip_address = $1
                FOR UPDATE
                ''',
                ip_address
            )
            if row and row['is_banned']:
                return {'count': int(row['preban_count'] or 0), 'is_banned': True}
            if row and row['preban_first_seen'] and row['preban_first_seen'] >= window_start:
                count = int(row['preban_count'] or 0) + 1
                first_seen = row['preban_first_seen']
            else:
                count = 1
                first_seen = now
            await conn.execute(
                '''
                INSERT INTO ip_stats (ip_address, request_count, first_seen, last_seen, preban_count, preban_first_seen, preban_last_seen, preban_reason)
                VALUES ($1, 0, $2, $2, $3, $4, $2, $5)
                ON CONFLICT(ip_address) DO UPDATE SET
                    preban_count = $3,
                    preban_first_seen = $4,
                    preban_last_seen = $2,
                    preban_reason = $5
                ''',
                ip_address, now, count, first_seen, reason
            )
            return {'count': count, 'is_banned': False, 'window_seconds': window_seconds}


async def load_banned_sets() -> tuple[set, set, Dict[str, float]]:
    """启动时一次性加载所有活跃封禁记录"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT ban_type, ban_value, banned_until FROM ban_list WHERE is_active = TRUE AND (banned_until IS NULL OR banned_until > NOW())"
        )
    usernames, ips, ip_expiries = set(), set(), {}
    for r in rows:
        if r['ban_type'] == 'username':
            usernames.add(r['ban_value'].lower())
        elif r['ban_type'] == 'ip':
            ips.add(r['ban_value'])
            if r['banned_until']:
                ip_expiries[r['ban_value']] = r['banned_until'].timestamp()
    return usernames, ips, ip_expiries


async def is_banned(username: str = None, ip_address: str = None) -> bool:
    """检查是否被封禁"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        if username:
            row = await conn.fetchrow(
                '''
                SELECT bl.id
                FROM ban_list bl
                WHERE bl.ban_type = 'username' AND bl.ban_value = $1
                  AND bl.is_active = TRUE AND (bl.banned_until IS NULL OR bl.banned_until > NOW())
                ''',
                username.lower()
            )
            if row:
                return True
        if ip_address:
            row = await conn.fetchrow(
                '''
                SELECT bl.id
                FROM ban_list bl
                WHERE bl.ban_type = 'ip' AND bl.ban_value = $1
                  AND bl.is_active = TRUE AND (bl.banned_until IS NULL OR bl.banned_until > NOW())
                ''',
                ip_address
            )
            if row:
                return True
    return False


async def get_ip_ban_state(ip_address: str) -> Dict:
    """Return sanitized active IP ban timing for user-facing responses."""
    normalized_ip = str(ip_address or "").strip()
    if not normalized_ip:
        return {"banned": False}
    pool = _get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            '''
            SELECT banned_until,
                   CASE
                       WHEN banned_until IS NULL THEN NULL
                       ELSE GREATEST(0, EXTRACT(EPOCH FROM (banned_until - NOW())))::INT
                   END AS remaining_seconds
            FROM ban_list
            WHERE ban_type = 'ip' AND ban_value = $1
              AND is_active = TRUE AND (banned_until IS NULL OR banned_until > NOW())
            ORDER BY banned_until NULLS LAST, banned_at DESC
            LIMIT 1
            ''',
            normalized_ip,
        )
    if not row:
        return {"banned": False}
    banned_until = row["banned_until"]
    return {
        "banned": True,
        "banned_until": banned_until.isoformat() if banned_until else "",
        "remaining_seconds": int(row["remaining_seconds"] or 0),
        "permanent": banned_until is None,
    }


async def _normalize_ban_records(conn):
    await run_ban_normalization(conn)


async def get_ban_list() -> List[Dict]:
    """获取封禁列表"""
    pool = _get_pool()
    await ensure_ban_normalized(pool)
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            WITH visible_bans AS (
                SELECT id, ban_type, ban_value, banned_at, banned_reason, banned_until, is_active,
                       CASE
                           WHEN is_active = TRUE AND (banned_until IS NULL OR banned_until > NOW()) THEN 'active'
                           WHEN is_active = TRUE AND banned_until IS NOT NULL AND banned_until <= NOW() THEN 'expired'
                           ELSE 'released'
                       END AS ban_status
                FROM ban_list
                WHERE (is_active = TRUE AND (banned_until IS NULL OR banned_until > NOW()))
                   OR COALESCE(released_at, banned_until, banned_at) >= NOW() - INTERVAL '7 days'
            ),
            stat_user_bans AS (
                SELECT NULL::bigint AS id, 'username'::text AS ban_type, username AS ban_value,
                       banned_at, banned_reason, NULL::timestamp AS banned_until, TRUE AS is_active,
                       'active'::text AS ban_status
                FROM user_stats us
                WHERE us.is_banned = TRUE
                  AND NOT EXISTS (
                      SELECT 1 FROM ban_list bl
                      WHERE bl.ban_type = 'username' AND bl.ban_value = us.username
                  )
            ),
            stat_ip_bans AS (
                SELECT NULL::bigint AS id, 'ip'::text AS ban_type, ip_address AS ban_value,
                       banned_at, banned_reason, NULL::timestamp AS banned_until, TRUE AS is_active,
                       'active'::text AS ban_status
                FROM ip_stats ips
                WHERE ips.is_banned = TRUE
                  AND NOT EXISTS (
                      SELECT 1 FROM ban_list bl
                      WHERE bl.ban_type = 'ip' AND bl.ban_value = ips.ip_address
                  )
            )
            SELECT * FROM visible_bans
            UNION ALL
            SELECT * FROM stat_user_bans
            UNION ALL
            SELECT * FROM stat_ip_bans
            ORDER BY banned_at DESC NULLS LAST
        ''')
        return [dict(r) for r in rows]


# ===== 统计摘要 =====

async def get_stats_summary() -> Dict:
    """获取统计摘要"""
    pool = _get_pool()
    await ensure_ban_normalized(pool)
    summary = await build_admin_summary(pool)
    try:
        user_growth_periods = await build_user_growth_periods(pool)
    except Exception as exc:
        logger.warning(f"[DashboardStats] 用户增长数据加载失败: {exc}")
        user_growth_periods = {'day': [], 'week': [], 'month': []}
    summary['user_growth_periods'] = user_growth_periods
    summary['user_growth'] = user_growth_periods.get('day') or []
    return summary


# ===== IP 统计 =====

async def get_all_ips(limit: int = 100, offset: int = 0,
                      sort_field: str = None, sort_dir: str = 'desc') -> List[Dict]:
    """获取所有IP统计"""
    sort_columns = {
        'request_count': 'COALESCE(request_count, 0)',
        'first_seen': 'first_seen',
        'last_seen': 'last_seen',
    }
    sort_column = sort_columns.get(str(sort_field or '').strip())
    direction = 'ASC' if str(sort_dir or '').lower() == 'asc' else 'DESC'
    if sort_column:
        order_by = f'{sort_column} {direction} NULLS LAST, ip_address ASC'
    else:
        order_by = '''
                CASE
                    WHEN is_banned THEN 2
                    WHEN preban_last_seen IS NOT NULL AND preban_last_seen >= NOW() - INTERVAL '60 seconds' THEN 3
                    ELSE 1
                END DESC,
                COALESCE(request_count, 0) DESC,
                last_seen DESC
        '''
    pool = _get_pool()
    await ensure_ban_normalized(pool)
    async with pool.acquire() as conn:
        rows = await conn.fetch(f'''
            SELECT ip_address, request_count, first_seen, last_seen, is_banned,
                   CASE
                       WHEN is_banned THEN FALSE
                       WHEN preban_last_seen IS NULL THEN FALSE
                       WHEN preban_last_seen < NOW() - INTERVAL '60 seconds' THEN FALSE
                       ELSE TRUE
                   END AS is_prebanned,
                   CASE
                       WHEN preban_last_seen IS NULL OR preban_last_seen < NOW() - INTERVAL '60 seconds' THEN 0
                       ELSE COALESCE(preban_count, 0)
                   END AS preban_count,
                   CASE
                       WHEN preban_last_seen IS NULL OR preban_last_seen < NOW() - INTERVAL '60 seconds' THEN NULL
                       ELSE preban_first_seen
                   END AS preban_first_seen,
                   CASE
                       WHEN preban_last_seen IS NULL OR preban_last_seen < NOW() - INTERVAL '60 seconds' THEN NULL
                       ELSE preban_last_seen
                   END AS preban_last_seen,
                   CASE
                       WHEN preban_last_seen IS NULL OR preban_last_seen < NOW() - INTERVAL '60 seconds' THEN ''
                       ELSE COALESCE(preban_reason, '')
                   END AS preban_reason
            FROM ip_stats
            ORDER BY {order_by}
            LIMIT $1 OFFSET $2
        ''', limit, offset)
        return [dict(r) for r in rows]


# ===== 数据清理 =====

async def cleanup_old_records(login_days: int = 90, max_login_rows: int = 500000):
    """
    清理旧数据：login_records 保留N天，超过max_rows时强制清理最旧的
    """
    pool = _get_pool()
    cutoff_login = datetime.now() - timedelta(days=login_days)

    async with pool.acquire() as conn:
        r1 = await conn.execute(
            'DELETE FROM login_records WHERE login_time < $1', cutoff_login
        )

        login_count = await conn.fetchval('SELECT COUNT(*) FROM login_records')
        if login_count > max_login_rows:
            excess = login_count - max_login_rows
            await conn.execute('''
                DELETE FROM login_records WHERE id IN (
                    SELECT id FROM login_records ORDER BY login_time ASC LIMIT $1
                )
            ''', excess)
            logger.info(f"登录记录超限，额外删除 {excess} 条")

        logger.info(f"数据清理完成: 登录{r1}, 当前行数: login={login_count}")


async def get_db_size() -> Dict:
    """获取数据库各表大小（用于监控存储占用）"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT relname AS table_name,
                   pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
                   pg_total_relation_size(relid) AS size_bytes,
                   n_live_tup AS row_count
            FROM pg_stat_user_tables
            ORDER BY pg_total_relation_size(relid) DESC
        ''')
        tables = [dict(r) for r in rows]
        total = sum(t['size_bytes'] for t in tables)
        return {
            'tables': tables,
            'total_size': _format_size(total),
            'total_bytes': total
        }


async def delete_by_date(table: str, before_date: str = None,
                        after_date: str = None, exact_date: str = None) -> int:
    """
    按日期删除指定表的数据
    - before_date: 删除此日期之前的数据 (YYYY-MM-DD)
    - after_date: 删除此日期之后的数据 (YYYY-MM-DD)
    - exact_date: 删除指定日期的数据 (YYYY-MM-DD)
    返回删除的行数
    """
    pool = _get_pool()

    # 安全检查：只允许操作这些表
    allowed_tables = {
        'login_records': 'login_time',
        'user_stats': 'last_login',
        'ip_stats': 'last_seen',
    }
    if table not in allowed_tables:
        raise ValueError(f"不允许操作表: {table}，可选: {list(allowed_tables.keys())}")

    time_col = allowed_tables[table]

    async with pool.acquire() as conn:
        if exact_date:
            dt = datetime.strptime(exact_date, "%Y-%m-%d")
            dt_end = dt + timedelta(days=1)
            result = await conn.execute(
                f'DELETE FROM {table} WHERE {time_col} >= $1 AND {time_col} < $2',
                dt, dt_end
            )
        elif before_date and after_date:
            dt_before = datetime.strptime(before_date, "%Y-%m-%d")
            dt_after = datetime.strptime(after_date, "%Y-%m-%d")
            result = await conn.execute(
                f'DELETE FROM {table} WHERE {time_col} >= $1 AND {time_col} < $2',
                dt_after, dt_before + timedelta(days=1)
            )
        elif before_date:
            dt = datetime.strptime(before_date, "%Y-%m-%d") + timedelta(days=1)
            result = await conn.execute(
                f'DELETE FROM {table} WHERE {time_col} < $1', dt
            )
        elif after_date:
            dt = datetime.strptime(after_date, "%Y-%m-%d")
            result = await conn.execute(
                f'DELETE FROM {table} WHERE {time_col} >= $1', dt
            )
        else:
            raise ValueError("必须指定 before_date、after_date 或 exact_date")

        # 提取删除行数
        deleted = int(result.split()[-1]) if result else 0
        logger.info(f"按日期删除: table={table}, before={before_date}, after={after_date}, exact={exact_date}, deleted={deleted}")
        return deleted


async def get_table_row_counts() -> Dict:
    """获取所有表的行数"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        tables = ['login_records', 'user_stats', 'ip_stats', 'ban_list',
                  'user_assets']
        counts = {}
        for t in tables:
            count = await conn.fetchval(f'SELECT COUNT(*) FROM {t}')
            counts[t] = count or 0
        return counts


def _format_size(size_bytes: int) -> str:
    if size_bytes > 1024**3:
        return f"{size_bytes/1024**3:.1f} GB"
    elif size_bytes > 1024**2:
        return f"{size_bytes/1024**2:.1f} MB"
    elif size_bytes > 1024:
        return f"{size_bytes/1024:.1f} KB"
    return f"{size_bytes} B"


# ===== 用户+资产联合查询 =====

async def get_all_users_with_assets(limit: int = 100, offset: int = 0) -> List[Dict]:
    """获取所有用户统计（包含资产信息）"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT us.username, us.password, us.login_count, us.first_login, us.last_login,
                   us.last_ip, us.is_banned,
                   COALESCE(ua.ace_count, 0) as ace_count, COALESCE(ua.total_ace, 0) as total_ace,
                   COALESCE(ua.ep, 0) as ep, COALESCE(ua.sp, 0) as sp,
                   COALESCE(ua.rp, 0) as rp, COALESCE(ua.tp, 0) as tp,
                   COALESCE(ua.ap, 0) as ap, COALESCE(ua.lp, 0) as lp,
                   COALESCE(ua.weekly_money, 0) as weekly_money,
                   COALESCE(ua.rate, 0) as rate, COALESCE(ua.credit, 0) as credit,
                   ua.honor_name, COALESCE(ua.level_number, 0) as level_number,
                   COALESCE(ua.left_area, 0) as left_area, COALESCE(ua.right_area, 0) as right_area,
                   COALESCE(ua.direct_push, 0) as direct_push, COALESCE(ua.sub_account, 0) as sub_account,
                   ua.updated_at as asset_updated_at
            FROM user_stats us LEFT JOIN user_assets ua ON us.username = ua.username
            ORDER BY us.last_login DESC NULLS LAST LIMIT $1 OFFSET $2
        ''', limit, offset)
        return _sanitize_output_rows(rows)


async def get_dashboard_data() -> Dict:
    pool = _get_pool()
    return await build_traffic_dashboard(pool)


# ===== 数据库管理（通用表操作） =====

async def get_all_tables() -> List[str]:
    """获取所有表名"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
        return [r['tablename'] for r in rows]


async def get_table_schema(table_name: str) -> List[Dict]:
    """获取表结构"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT ordinal_position as cid, column_name as name,
                   data_type as type, is_nullable,
                   column_default as dflt_value
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1
            ORDER BY ordinal_position
        ''', table_name)
        result = []
        for r in rows:
            result.append({
                'cid': r['cid'], 'name': r['name'], 'type': r['type'],
                'notnull': 1 if r['is_nullable'] == 'NO' else 0,
                'dflt_value': r['dflt_value'], 'pk': 0
            })
        return result


async def query_table(table_name: str, limit: int = 100, offset: int = 0,
                      order_by: str = None, order_desc: bool = True,
                      filter_col: str = None, filter_op: str = '=', filter_val: Any = None) -> Dict:
    """查询表数据（带大表保护与单条件筛选）"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        quoted_table = _quote_identifier(table_name, 'table')
        columns = await _get_table_columns(table_name, conn)
        if not columns:
            raise GuardError("unknown_table", "Unknown table")

        # 构建过滤条件（仅允许已存在字段，运算符白名单）
        has_filter = bool(filter_col) and filter_col in columns and filter_val is not None
        allowed_ops = {'=', 'ilike'}
        op = filter_op.lower() if filter_op else '='
        if op not in allowed_ops:
            op = '='

        guard = get_big_table_guard()
        decision = await guard.validate_table_query(
            table_name=table_name,
            limit=limit,
            offset=offset,
            has_filter=has_filter,
        )

        normalized_limit = decision.limit if decision.limit is not None else limit
        sql_params = []

        where_clause = ''
        if has_filter:
            quoted_filter_col = _quote_existing_column(filter_col, columns, 'filter column')
            where_clause = f" WHERE {quoted_filter_col} {op.upper()} $1"
            sql_params.append(filter_val if op != 'ilike' else f"%{filter_val}%")
        elif not decision.count_allowed:
            # 大表无筛选时拒绝
            raise GuardError("require_where_on_big_table", f"大表 {table_name} 查询需要 WHERE 条件以避免全表扫描")

        order_clause = ''
        if order_by and order_by in columns:
            direction = 'DESC' if order_desc else 'ASC'
            quoted_order_by = _quote_existing_column(order_by, columns, 'order column')
            order_clause = f' ORDER BY {quoted_order_by} {direction}'

        total_sql = f'SELECT COUNT(*) FROM {quoted_table}{where_clause}'
        total = await conn.fetchval(total_sql, *sql_params)

        data_sql = f'SELECT * FROM {quoted_table}{where_clause}{order_clause} LIMIT {normalized_limit} OFFSET {offset}'
        rows = await conn.fetch(data_sql, *sql_params)

        return {
            'total': total,
            'rows': _sanitize_output_rows(rows),
            'limit_capped': decision.limit_capped,
            'table_info': decision.table_info or {},
            'filter_applied': has_filter,
            'filter_op': op,
        }


async def insert_row(table_name: str, data: dict) -> int:
    """插入数据"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        quoted_table = _quote_identifier(table_name, 'table')
        columns = await _get_table_columns(table_name, conn)
        if not columns:
            raise GuardError("unknown_table", "Unknown table")
        insert_keys = [key for key in data.keys() if key in columns]
        if not insert_keys:
            raise GuardError("empty_insert", "No valid columns to insert")
        cols = ', '.join(_quote_existing_column(key, columns, 'column') for key in insert_keys)
        placeholders = ', '.join([f'${i+1}' for i in range(len(insert_keys))])
        sql = f'INSERT INTO {quoted_table} ({cols}) VALUES ({placeholders}) RETURNING id'
        row_id = await conn.fetchval(sql, *[data[key] for key in insert_keys])
        return row_id


async def update_row(table_name: str, pk_column: str, pk_value, data: dict) -> int:
    """更新数据（自动根据列类型转换值）"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        quoted_table = _quote_identifier(table_name, 'table')
        # 查询列类型用于自动转换
        col_types = {}
        rows = await conn.fetch(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1",
            table_name)
        for r in rows:
            col_types[r['column_name']] = r['data_type']
        if not col_types:
            raise GuardError("unknown_table", "Unknown table")
        if pk_column not in col_types:
            raise GuardError("invalid_identifier", "Invalid primary key column")

        # 过滤掉不属于该表的字段（如JOIN产生的虚拟列）
        filtered = {}
        for k, v in data.items():
            if k not in col_types:
                continue
            filtered[k] = _convert_value(v, col_types.get(k, ''))

        if not filtered:
            return 0

        set_parts = [f'{_quote_identifier(k, "column")} = ${i+1}' for i, k in enumerate(filtered.keys())]
        set_clause = ', '.join(set_parts)
        pk_idx = len(filtered) + 1
        # 主键值也需要转换
        pk_converted = _convert_value(pk_value, col_types.get(pk_column, ''))
        quoted_pk_column = _quote_identifier(pk_column, 'primary key column')
        sql = f'UPDATE {quoted_table} SET {set_clause} WHERE {quoted_pk_column} = ${pk_idx}'
        result = await conn.execute(sql, *filtered.values(), pk_converted)
        return int(result.split()[-1])


def _convert_value(val, data_type: str):
    """根据PostgreSQL列类型转换Python值"""
    if val is None or val == '':
        return None
    dt = data_type.lower()
    try:
        if 'int' in dt or dt in ('bigserial', 'serial', 'smallserial'):
            return int(val)
        elif dt in ('double precision', 'real', 'numeric', 'decimal'):
            return float(val)
        elif dt == 'boolean':
            if isinstance(val, bool):
                return val
            return str(val).lower() in ('true', '1', 't', 'yes')
        elif 'timestamp' in dt or dt == 'date':
            if isinstance(val, (datetime,)):
                return val
            # 解析ISO格式时间字符串
            s = str(val).replace('T', ' ').replace('Z', '')
            for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M:%S.%f', '%Y-%m-%d'):
                try:
                    return datetime.strptime(s, fmt)
                except ValueError:
                    continue
            return val
    except (ValueError, TypeError):
        pass
    return val


async def delete_row(table_name: str, pk_column: str, pk_value) -> int:
    """删除数据"""
    pool = _get_pool()
    if pk_column.endswith('id') or pk_column == 'id':
        try:
            pk_value = int(pk_value)
        except (ValueError, TypeError):
            pass
    async with pool.acquire() as conn:
        quoted_table = _quote_identifier(table_name, 'table')
        columns = await _get_table_columns(table_name, conn)
        if not columns:
            raise GuardError("unknown_table", "Unknown table")
        quoted_pk_column = _quote_existing_column(pk_column, columns, 'primary key column')
        sql = f'DELETE FROM {quoted_table} WHERE {quoted_pk_column} = $1'
        result = await conn.execute(sql, pk_value)
        return int(result.split()[-1])


async def execute_sql(sql: str):
    """执行自定义SQL（带大表保护、超时和返回行数上限）"""
    policy = classify_admin_sql(sql)
    if policy.has_multiple_statements:
        raise GuardError("multi_statement_blocked", "Multiple SQL statements are not allowed")
    if policy.blocked:
        raise GuardError(policy.block_code, policy.block_message)
    if policy.explain_analyze:
        raise GuardError("explain_analyze_blocked", "自定义 SQL 不允许执行 EXPLAIN ANALYZE")

    guard = get_big_table_guard()
    await guard.validate_sql(sql)

    pool = _get_pool()
    async with pool.acquire() as conn:
        timeout_seconds = ADMIN_SQL_TIMEOUT_MS / 1000
        try:
            if policy.is_readonly:
                async with conn.transaction(readonly=True):
                    await _set_local_statement_timeout(conn)
                    return await _fetch_admin_sql_rows(conn, sql, ADMIN_SQL_MAX_ROWS, timeout_seconds)
            async with conn.transaction():
                await _set_local_statement_timeout(conn)
                result = await conn.execute(sql, timeout=timeout_seconds)
                try:
                    affected_rows = int(result.split()[-1]) if result else 0
                except (ValueError, IndexError):
                    affected_rows = 0
                return {'affected_rows': affected_rows}
        except (asyncio.TimeoutError, asyncpg.exceptions.QueryCanceledError) as exc:
            raise GuardError("sql_timeout", f"SQL执行超过 {ADMIN_SQL_TIMEOUT_MS}ms，已中止") from exc


async def _set_local_statement_timeout(conn) -> None:
    await conn.execute(f"SET LOCAL statement_timeout = {ADMIN_SQL_TIMEOUT_MS}")


async def _fetch_admin_sql_rows(conn, sql: str, max_rows: int, timeout_seconds: float) -> List[Dict[str, Any]]:
    cursor = await conn.cursor(sql, timeout=timeout_seconds)
    rows = await cursor.fetch(max_rows + 1, timeout=timeout_seconds)
    truncated = len(rows) > max_rows
    sanitized = _sanitize_output_rows(rows[:max_rows])
    if truncated:
        sanitized.append(_build_admin_sql_truncation_notice(sanitized, max_rows))
    return sanitized


def _build_admin_sql_truncation_notice(rows: List[Dict[str, Any]], max_rows: int) -> Dict[str, Any]:
    if not rows:
        return {"notice": f"结果已截断，仅显示前 {max_rows} 行"}
    notice = {key: "" for key in rows[0].keys()}
    first_key = next(iter(notice), "notice")
    notice[first_key] = f"结果已截断，仅显示前 {max_rows} 行"
    return notice


# ===== 管理员Token持久化 =====

async def save_admin_token(token: str, role: str, expire: float, sub_name: str = ''):
    """保存管理员Token到数据库"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        await conn.execute('''
            INSERT INTO admin_tokens (token, role, expire, sub_name) VALUES ($1, $2, $3, $4)
            ON CONFLICT(token) DO UPDATE SET role=$2, expire=$3, sub_name=$4
        ''', token, role, expire, sub_name)


async def get_admin_token(token: str) -> Optional[Dict]:
    """获取Token信息"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            'SELECT role, expire, sub_name FROM admin_tokens WHERE token = $1', token)
        if row:
            return {'role': row['role'], 'expire': row['expire'], 'sub_name': row['sub_name'] or ''}
        return None


async def mark_admin_token_invalidated(token: str, reason: str, role: str = '', sub_name: str = '') -> None:
    pool = _get_pool()
    async with pool.acquire() as conn:
        await conn.execute('''
            INSERT INTO admin_token_invalidations (token_hash, reason, role, sub_name, invalidated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT(token_hash) DO UPDATE SET
                reason = $2, role = $3, sub_name = $4, invalidated_at = NOW()
        ''', _admin_token_hash(token), reason, role or '', sub_name or '')


async def get_admin_token_invalidation(token: str) -> Optional[Dict]:
    pool = _get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            'SELECT reason, role, sub_name, invalidated_at FROM admin_token_invalidations WHERE token_hash = $1',
            _admin_token_hash(token)
        )
        return dict(row) if row else None


async def delete_admin_token(token: str, reason: str = 'deleted'):
    """删除指定Token"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow('SELECT role, sub_name FROM admin_tokens WHERE token = $1', token)
            if row:
                await conn.execute('''
                    INSERT INTO admin_token_invalidations (token_hash, reason, role, sub_name, invalidated_at)
                    VALUES ($1, $2, $3, $4, NOW())
                    ON CONFLICT(token_hash) DO UPDATE SET
                        reason = $2, role = $3, sub_name = $4, invalidated_at = NOW()
                ''', _admin_token_hash(token), reason, row['role'] or '', row['sub_name'] or '')
            await conn.execute('DELETE FROM admin_operation_leases WHERE admin_token = $1', token)
            await conn.execute('DELETE FROM admin_tokens WHERE token = $1', token)


async def delete_admin_tokens_by_role(role: str, reason: str = 'replaced') -> int:
    """删除指定角色的所有Token"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            rows = await conn.fetch('SELECT token, role, sub_name FROM admin_tokens WHERE role = $1', role)
            tokens = [r['token'] for r in rows]
            for row in rows:
                await conn.execute('''
                    INSERT INTO admin_token_invalidations (token_hash, reason, role, sub_name, invalidated_at)
                    VALUES ($1, $2, $3, $4, NOW())
                    ON CONFLICT(token_hash) DO UPDATE SET
                        reason = $2, role = $3, sub_name = $4, invalidated_at = NOW()
                ''', _admin_token_hash(row['token']), reason, row['role'] or '', row['sub_name'] or '')
            if tokens:
                await conn.execute('DELETE FROM admin_operation_leases WHERE admin_token = ANY($1::text[])', tokens)
            result = await conn.execute('DELETE FROM admin_tokens WHERE role = $1', role)
            return int(result.split()[-1])


async def delete_admin_tokens_by_sub_name(sub_name: str, reason: str = 'replaced') -> int:
    """删除指定子管理员的所有Token"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            rows = await conn.fetch(
                "SELECT token, role, sub_name FROM admin_tokens WHERE role = 'sub_admin' AND sub_name = $1", sub_name)
            tokens = [r['token'] for r in rows]
            for row in rows:
                await conn.execute('''
                    INSERT INTO admin_token_invalidations (token_hash, reason, role, sub_name, invalidated_at)
                    VALUES ($1, $2, $3, $4, NOW())
                    ON CONFLICT(token_hash) DO UPDATE SET
                        reason = $2, role = $3, sub_name = $4, invalidated_at = NOW()
                ''', _admin_token_hash(row['token']), reason, row['role'] or '', row['sub_name'] or '')
            if tokens:
                await conn.execute('DELETE FROM admin_operation_leases WHERE admin_token = ANY($1::text[])', tokens)
            result = await conn.execute(
                "DELETE FROM admin_tokens WHERE role = 'sub_admin' AND sub_name = $1", sub_name)
            return int(result.split()[-1])


async def cleanup_expired_tokens() -> int:
    """清理过期Token"""
    import time as _time
    pool = _get_pool()
    async with pool.acquire() as conn:
        now = _time.time()
        async with conn.transaction():
            rows = await conn.fetch('SELECT token FROM admin_tokens WHERE expire < $1', now)
            tokens = [r['token'] for r in rows]
            for token in tokens:
                await conn.execute('''
                    INSERT INTO admin_token_invalidations (token_hash, reason, role, sub_name, invalidated_at)
                    SELECT $1, 'expired', role, sub_name, NOW()
                    FROM admin_tokens WHERE token = $2
                    ON CONFLICT(token_hash) DO UPDATE SET
                        reason = EXCLUDED.reason,
                        role = EXCLUDED.role,
                        sub_name = EXCLUDED.sub_name,
                        invalidated_at = NOW()
                ''', _admin_token_hash(token), token)
            if tokens:
                await conn.execute('DELETE FROM admin_operation_leases WHERE admin_token = ANY($1::text[])', tokens)
            await conn.execute('DELETE FROM admin_operation_leases WHERE expire < $1', now)
            result = await conn.execute('DELETE FROM admin_tokens WHERE expire < $1', now)
            return int(result.split()[-1])


async def load_all_admin_tokens() -> Dict:
    """加载所有未过期的Token"""
    import time as _time
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            'SELECT token, role, expire, sub_name FROM admin_tokens WHERE expire > $1', _time.time())
        return {r['token']: {'role': r['role'], 'expire': r['expire'], 'sub_name': r['sub_name'] or ''} for r in rows}


async def get_admin_totp_secret(identity: str) -> Optional[Dict]:
    pool = _get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            '''
            SELECT identity, role, sub_name, secret, created_at, updated_at
            FROM admin_totp_secrets
            WHERE identity = $1
            ''',
            identity
        )
        return dict(row) if row else None


async def upsert_admin_totp_secret(identity: str, role: str, sub_name: str, secret: str) -> Dict:
    pool = _get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            '''
            INSERT INTO admin_totp_secrets (identity, role, sub_name, secret, created_at, updated_at)
            VALUES ($1, $2, $3, $4, NOW(), NOW())
            ON CONFLICT(identity) DO UPDATE SET
                role = $2,
                sub_name = $3,
                secret = $4,
                updated_at = NOW()
            RETURNING identity, role, sub_name, secret, created_at, updated_at
            ''',
            identity, role, sub_name or '', secret
        )
        return dict(row)


async def list_admin_totp_secrets() -> List[Dict]:
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            '''
            SELECT identity, role, sub_name, secret, created_at, updated_at
            FROM admin_totp_secrets
            ORDER BY role, sub_name
            '''
        )
        return [dict(r) for r in rows]


async def save_admin_operation_lease(lease_token: str, admin_token: str, role: str, sub_name: str,
                                     scope: str, expire: float, client_ip: str = '',
                                     user_agent: str = '') -> Dict:
    pool = _get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            '''
            INSERT INTO admin_operation_leases
                (lease_token, admin_token, role, sub_name, scope, expire, client_ip, user_agent, issued_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            RETURNING lease_token, admin_token, role, sub_name, scope, expire, client_ip, user_agent, issued_at, last_used_at
            ''',
            lease_token, admin_token, role, sub_name or '', scope, expire, client_ip or '', user_agent or ''
        )
        return dict(row)


async def get_admin_operation_lease(lease_token: str) -> Optional[Dict]:
    pool = _get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            '''
            SELECT lease_token, admin_token, role, sub_name, scope, expire, client_ip, user_agent, issued_at, last_used_at
            FROM admin_operation_leases
            WHERE lease_token = $1
            ''',
            lease_token
        )
        return dict(row) if row else None


async def touch_admin_operation_lease(lease_token: str) -> None:
    pool = _get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            'UPDATE admin_operation_leases SET last_used_at = NOW() WHERE lease_token = $1',
            lease_token
        )


async def delete_admin_operation_lease(lease_token: str) -> None:
    pool = _get_pool()
    async with pool.acquire() as conn:
        await conn.execute('DELETE FROM admin_operation_leases WHERE lease_token = $1', lease_token)


async def cleanup_expired_admin_operation_leases(now_ts: float = None) -> int:
    import time as _time
    pool = _get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            'DELETE FROM admin_operation_leases WHERE expire < $1',
            now_ts if now_ts is not None else _time.time()
        )
        return int(result.split()[-1])


# ===== 激活码操作日志 =====

async def add_license_log(action: str, license_key: str = None, product_id: str = None,
                          billing_mode: str = None, detail: str = None, operator: str = 'admin'):
    """记录激活码操作日志"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        await conn.execute('''
            INSERT INTO license_logs (action, license_key, product_id, billing_mode, detail, operator)
            VALUES ($1, $2, $3, $4, $5, $6)
        ''', action, license_key, product_id, billing_mode, detail, operator)


async def get_license_logs(action: str = None, limit: int = 100, offset: int = 0) -> Dict:
    """获取激活码操作记录"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        if action:
            total = await conn.fetchval('SELECT COUNT(*) FROM license_logs WHERE action = $1', action)
            rows = await conn.fetch('''
                SELECT * FROM license_logs WHERE action = $1
                ORDER BY created_at DESC LIMIT $2 OFFSET $3
            ''', action, limit, offset)
        else:
            total = await conn.fetchval('SELECT COUNT(*) FROM license_logs')
            rows = await conn.fetch('''
                SELECT * FROM license_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2
            ''', limit, offset)
        return {'rows': [dict(r) for r in rows], 'total': total}


# ===== 子管理员管理 =====

def _normalize_bound_account_username(username: str) -> str:
    return (str(username or '').strip().lower())


async def _check_binding_conflict(conn: asyncpg.Connection, sub_name: str, normalized_bound_username: str) -> None:
    """仅检查该授权账号是否已被其他子管理员绑定（唯一性冲突），不校验账号是否存在或有效"""
    if not normalized_bound_username:
        return
    binding_row = await conn.fetchrow('''
        SELECT sub_name
        FROM sub_admin_account_bindings
        WHERE account_username = $1
    ''', normalized_bound_username)
    if binding_row and str(binding_row['sub_name'] or '').strip() != str(sub_name or '').strip():
        raise ValueError(f'账号 [{normalized_bound_username}] 已绑定子管理员 [{binding_row["sub_name"]}]')

async def db_get_all_sub_admins() -> Dict:
    """获取所有子管理员"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT s.name,
                   s.password,
                   s.permissions,
                   s.created_at AS sub_admin_created_at,
                   b.account_username,
                   b.bound_by,
                   b.created_at AS binding_created_at,
                   b.updated_at AS binding_updated_at,
                   aa.status AS bound_account_status,
                   aa.expire_time AS bound_account_expire_time
            FROM sub_admins s
            LEFT JOIN sub_admin_account_bindings b ON b.sub_name = s.name
            LEFT JOIN authorized_accounts aa ON aa.username = b.account_username
            ORDER BY s.created_at
        ''')
        result = {}
        for r in rows:
            result[r['name']] = {
                'password': r['password'],
                'permissions': json.loads(r['permissions'] or '{}'),
                'created_at': _serialize_time_value(r['sub_admin_created_at']),
                'bound_username': str(r['account_username'] or '').strip().lower(),
                'is_bound': bool(str(r['account_username'] or '').strip()),
                'bound_by': str(r['bound_by'] or '').strip(),
                'binding_created_at': _serialize_time_value(r['binding_created_at']),
                'binding_updated_at': _serialize_time_value(r['binding_updated_at']),
                'bound_account_status': str(r['bound_account_status'] or '').strip(),
                'bound_account_expire_time': _serialize_time_value(r['bound_account_expire_time'])
            }
        return result


async def db_set_sub_admin(name: str, password: str, permissions: dict = None,
                           bound_username: str = '', bound_by: str = '') -> Dict:
    """添加或更新子管理员（创建时要求绑定非空；仅做唯一性冲突校验，不核对账号是否存在）"""
    perm_json = json.dumps(permissions or {})
    normalized_bound_username = _normalize_bound_account_username(bound_username)
    if not normalized_bound_username:
        raise ValueError('请绑定账号')
    pool = _get_pool()
    async with pool.acquire() as conn:
        await _check_binding_conflict(conn, name, normalized_bound_username)
        async with conn.transaction():
            await conn.execute('''
                INSERT INTO sub_admins (name, password, permissions) VALUES ($1, $2, $3)
                ON CONFLICT(name) DO UPDATE SET password = $2, permissions = $3
            ''', name, password, perm_json)
            await conn.execute('''
                INSERT INTO sub_admin_account_bindings (sub_name, account_username, bound_by)
                VALUES ($1, $2, $3)
                ON CONFLICT(sub_name) DO UPDATE SET
                    account_username = EXCLUDED.account_username,
                    bound_by = EXCLUDED.bound_by,
                    updated_at = NOW()
            ''', name, normalized_bound_username, str(bound_by or '').strip())
    result = await db_get_sub_admin(name)
    if not result:
        raise ValueError(f'子管理员 [{name}] 保存后读取失败')
    return result


async def db_set_sub_admin_binding(name: str, bound_username: str, bound_by: str = '') -> Dict:
    """统一的绑定关系设置入口：支持补绑/换绑/解绑。
    - bound_username 非空：upsert 绑定（补绑或换绑）
    - bound_username 为空：删除绑定（解绑）
    返回: { 'op': 'created'|'updated'|'deleted'|'noop', 'data': <子管理员详情> }
    """
    normalized_bound_username = _normalize_bound_account_username(bound_username)
    pool = _get_pool()
    async with pool.acquire() as conn:
        sub_admin_row = await conn.fetchrow('SELECT name FROM sub_admins WHERE name = $1', name)
        if not sub_admin_row:
            raise ValueError(f'子管理员 [{name}] 不存在')
        existing_row = await conn.fetchrow(
            'SELECT account_username FROM sub_admin_account_bindings WHERE sub_name = $1', name)
        existing_username = str(existing_row['account_username'] or '').strip().lower() if existing_row else ''
        if normalized_bound_username:
            await _check_binding_conflict(conn, name, normalized_bound_username)
            async with conn.transaction():
                await conn.execute('''
                    INSERT INTO sub_admin_account_bindings (sub_name, account_username, bound_by)
                    VALUES ($1, $2, $3)
                    ON CONFLICT(sub_name) DO UPDATE SET
                        account_username = EXCLUDED.account_username,
                        bound_by = EXCLUDED.bound_by,
                        updated_at = NOW()
                ''', name, normalized_bound_username, str(bound_by or '').strip())
            if not existing_username:
                op = 'created'
            elif existing_username == normalized_bound_username:
                op = 'noop'
            else:
                op = 'updated'
        else:
            if existing_username:
                await conn.execute('DELETE FROM sub_admin_account_bindings WHERE sub_name = $1', name)
                op = 'deleted'
            else:
                op = 'noop'
    result = await db_get_sub_admin(name)
    if not result:
        raise ValueError(f'子管理员 [{name}] 绑定变更后读取失败')
    return {'op': op, 'data': result}


async def db_delete_sub_admin(name: str) -> bool:
    """删除子管理员"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute('DELETE FROM sub_admins WHERE name = $1', name)
        return int(result.split()[-1]) > 0


async def db_get_sub_admin(name: str) -> Optional[Dict]:
    """获取单个子管理员"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            '''
            SELECT s.name,
                   s.password,
                   s.permissions,
                   s.created_at AS sub_admin_created_at,
                   b.account_username,
                   b.bound_by,
                   b.created_at AS binding_created_at,
                   b.updated_at AS binding_updated_at,
                   aa.status AS bound_account_status,
                   aa.expire_time AS bound_account_expire_time
            FROM sub_admins s
            LEFT JOIN sub_admin_account_bindings b ON b.sub_name = s.name
            LEFT JOIN authorized_accounts aa ON aa.username = b.account_username
            WHERE s.name = $1
            ''', name)
        if not row:
            return None
        result = {
            'name': row['name'],
            'password': row['password'],
            'permissions': json.loads(row['permissions'] or '{}'),
            'created_at': _serialize_time_value(row['sub_admin_created_at']),
            'bound_username': str(row['account_username'] or '').strip().lower(),
            'is_bound': bool(str(row['account_username'] or '').strip()),
            'bound_by': str(row['bound_by'] or '').strip(),
            'binding_created_at': _serialize_time_value(row['binding_created_at']),
            'binding_updated_at': _serialize_time_value(row['binding_updated_at']),
            'bound_account_status': str(row['bound_account_status'] or '').strip(),
            'bound_account_expire_time': _serialize_time_value(row['bound_account_expire_time'])
        }
        return result


async def db_update_sub_admin_permissions(name: str, permissions: dict) -> bool:
    """仅更新子管理员权限"""
    perm_json = json.dumps(permissions or {})
    pool = _get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute('UPDATE sub_admins SET permissions = $1 WHERE name = $2', perm_json, name)
        return int(result.split()[-1]) > 0


# ===== 授权白名单 =====

async def check_authorized(username: str) -> Optional[Dict]:
    """检查账号是否在白名单中且未过期（高频调用，需要快）"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, expire_time, status FROM authorized_accounts WHERE username = $1 AND status = 'active'",
            username)
        if not row:
            return None
        return {'id': row['id'], 'expire_time': row['expire_time'], 'status': row['status']}


async def add_authorized_account(username: str, password: str, added_by: str,
                                  plan_type: str, credits_cost: int,
                                  duration_days: int,
                                  nickname: str = '') -> Dict:
    """添加授权账号"""
    pool = _get_pool()
    username = username.lower() if username else username
    now = datetime.now()
    expire_time = now + timedelta(days=duration_days)
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow('''
                INSERT INTO authorized_accounts
                    (username, password, added_by, plan_type, credits_cost, start_time, expire_time, status, nickname)
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
                ON CONFLICT(username) DO UPDATE SET
                    password=$2, added_by=$3, plan_type=$4, credits_cost=$5,
                    start_time=$6, expire_time=$7, status='active', nickname=$8, updated_at=NOW()
                RETURNING id, expire_time
            ''', username, password, added_by, plan_type, credits_cost, now, expire_time, nickname)
            await _upsert_user_stats_identity(conn, username, real_name=nickname)
        return {'id': row['id'], 'expire_time': str(row['expire_time']), 'username': username, 'real_name': nickname}


async def add_authorized_account_atomic(username: str, password: str, added_by: str,
                                        plan_type: str, credits_cost: int,
                                        duration_days: int,
                                        nickname: str = '', charge_admin: bool = False,
                                        plan_name: str = '') -> Dict:
    pool = _get_pool()
    normalized_username = username.lower().strip() if username else ''
    normalized_added_by = str(added_by or '').strip()
    if not normalized_username:
        raise ValueError("账号不能为空")
    if not normalized_added_by:
        raise ValueError("添加人不能为空")
    now = datetime.now()
    expire_time = now + timedelta(days=duration_days)
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute('SELECT pg_advisory_xact_lock(884447, hashtext($1))', normalized_username)
            existing = await conn.fetchrow('''
                SELECT username, added_by, status, expire_time
                FROM authorized_accounts
                WHERE username = $1
                FOR UPDATE
            ''', normalized_username)
            previous_added_by = str(existing['added_by'] or '').strip() if existing else ''
            if existing and existing['status'] == 'active' and existing['expire_time'] and existing['expire_time'] > now:
                owner = previous_added_by or 'unknown'
                raise ValueError(f"账号[{normalized_username}]已由[{owner}]授权，请勿重复添加")
            if charge_admin and credits_cost > 0:
                current = await conn.fetchval('SELECT credits FROM sub_admins WHERE name = $1 FOR UPDATE', normalized_added_by)
                if (current or 0) < credits_cost:
                    raise ValueError(f"积分不足: 当前{current or 0}, 需要{credits_cost}")
                await conn.execute(
                    'UPDATE sub_admins SET credits = credits - $1 WHERE name = $2',
                    credits_cost, normalized_added_by)
                new_balance = (current or 0) - credits_cost
                await conn.execute('''
                    INSERT INTO credit_transactions
                        (admin_name, type, amount, balance_after, description, related_username, operator)
                    VALUES ($1, 'deduct', $2, $3, $4, $5, $6)
                ''', normalized_added_by, -credits_cost, new_balance,
                    f"授权账号[{normalized_username}] {plan_name or plan_type}",
                    normalized_username, normalized_added_by)
            row = await conn.fetchrow('''
                INSERT INTO authorized_accounts
                    (username, password, added_by, plan_type, credits_cost, start_time, expire_time, status, nickname)
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
                ON CONFLICT(username) DO UPDATE SET
                    password=$2, added_by=$3, plan_type=$4, credits_cost=$5,
                    start_time=$6, expire_time=$7, status='active', nickname=$8, updated_at=NOW()
                RETURNING id, expire_time
            ''', normalized_username, password, normalized_added_by, plan_type, credits_cost, now, expire_time, nickname)
            await _upsert_user_stats_identity(conn, normalized_username, real_name=nickname)
        return {
            'id': row['id'],
            'expire_time': str(row['expire_time']),
            'username': normalized_username,
            'real_name': nickname,
            'previous_added_by': previous_added_by,
        }


async def renew_authorized_account(username: str, plan_type: str, credits_cost: int,
                                    duration_days: int) -> Optional[Dict]:
    """续期授权账号（从当前过期时间或现在起延长）"""
    pool = _get_pool()
    now = datetime.now()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            'SELECT id, expire_time FROM authorized_accounts WHERE username = $1', username)
        if not row:
            return None
        base_time = max(row['expire_time'], now)
        new_expire = base_time + timedelta(days=duration_days)
        await conn.execute('''
            UPDATE authorized_accounts SET
                plan_type=$1, credits_cost=credits_cost+$2, expire_time=$3,
                status='active', updated_at=NOW()
            WHERE username=$4
        ''', plan_type, credits_cost, new_expire, username)
        return {'id': row['id'], 'old_expire': str(row['expire_time']),
                'new_expire': str(new_expire), 'username': username}


async def delete_authorized_account(username: str) -> bool:
    """删除授权账号（标记为deleted）"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "UPDATE authorized_accounts SET status='deleted', updated_at=NOW() WHERE username=$1",
            username)
        return int(result.split()[-1]) > 0


async def get_authorized_account(username: str) -> Optional[Dict]:
    pool = _get_pool()
    username = username.lower() if username else username
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM authorized_accounts WHERE username = $1",
            username)
        return dict(row) if row else None


async def update_authorized_account_nickname(username: str, nickname: str,
                                             added_by: str = None) -> Optional[Dict]:
    pool = _get_pool()
    username = username.lower().strip() if username else ''
    nickname = nickname.strip() if nickname else ''
    if not username or not nickname:
        return None
    async with pool.acquire() as conn:
        async with conn.transaction():
            if added_by:
                row = await conn.fetchrow('''
                    UPDATE authorized_accounts
                    SET nickname=$1, updated_at=NOW()
                    WHERE username=$2 AND added_by=$3
                    RETURNING username, nickname
                ''', nickname, username, added_by)
            else:
                row = await conn.fetchrow('''
                    UPDATE authorized_accounts
                    SET nickname=$1, updated_at=NOW()
                    WHERE username=$2
                    RETURNING username, nickname
                ''', nickname, username)
            if not row:
                return None
            await _upsert_user_stats_identity(conn, username, real_name=nickname)
            return dict(row)


async def ensure_sub_admin_bound_account_authorized(sub_name: str, bound_username: str) -> Dict:
    normalized_sub_name = str(sub_name or '').strip()
    normalized_username = _normalize_bound_account_username(bound_username)
    if not normalized_sub_name:
        raise ValueError('子管理员名称不能为空')
    if not normalized_username:
        raise ValueError('绑定账号不能为空')
    now = datetime.now()
    expire_time = datetime(2099, 12, 31, 23, 59, 59)
    pool = _get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow('''
                INSERT INTO authorized_accounts
                    (username, password, added_by, plan_type, credits_cost, start_time, expire_time, status, nickname)
                VALUES ($1, '', $2, 'sub_admin_bound', 0, $3, $4, 'active', '')
                ON CONFLICT(username) DO UPDATE SET
                    added_by=$2,
                    plan_type=CASE
                        WHEN COALESCE(authorized_accounts.plan_type, '') = '' THEN 'sub_admin_bound'
                        ELSE authorized_accounts.plan_type
                    END,
                    expire_time=GREATEST(authorized_accounts.expire_time, $4),
                    status='active',
                    updated_at=NOW()
                RETURNING id, username, added_by, status, expire_time
            ''', normalized_username, normalized_sub_name, now, expire_time)
            await _upsert_user_stats_identity(conn, normalized_username)
        return {
            'id': row['id'],
            'username': row['username'],
            'added_by': row['added_by'],
            'status': row['status'],
            'expire_time': str(row['expire_time'])
        }


async def get_authorized_accounts(added_by: str = None, status: str = None,
                                   limit: int = 100, offset: int = 0,
                                   search: str = None) -> Dict:
    """获取授权账号列表（支持按添加人过滤实现数据隔离）"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        conditions = []
        params = []
        idx = 1
        if added_by:
            conditions.append(f"added_by = ${idx}")
            params.append(added_by)
            idx += 1
        if status:
            conditions.append(f"status = ${idx}")
            params.append(status)
            idx += 1
        if search:
            conditions.append(f"(username ILIKE ${idx} OR nickname ILIKE ${idx} OR added_by ILIKE ${idx})")
            params.append(f"%{search}%")
            idx += 1

        where = f" WHERE {' AND '.join(conditions)}" if conditions else ""

        total = await conn.fetchval(f"SELECT COUNT(*) FROM authorized_accounts{where}", *params)

        params.append(limit)
        params.append(offset)
        rows = await conn.fetch(f'''
            SELECT * FROM authorized_accounts{where}
            ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx+1}
        ''', *params)
        return {'total': total or 0, 'rows': _sanitize_output_rows(rows)}


async def get_expiring_accounts(days: int = 7, added_by: str = None) -> List[Dict]:
    """获取即将到期的账号（用于提醒子管理员续期）"""
    pool = _get_pool()
    deadline = datetime.now() + timedelta(days=days)
    async with pool.acquire() as conn:
        if added_by:
            rows = await conn.fetch('''
                SELECT * FROM authorized_accounts
                WHERE status='active' AND expire_time <= $1 AND expire_time > NOW() AND added_by = $2
                ORDER BY expire_time ASC
            ''', deadline, added_by)
        else:
            rows = await conn.fetch('''
                SELECT * FROM authorized_accounts
                WHERE status='active' AND expire_time <= $1 AND expire_time > NOW()
                ORDER BY expire_time ASC
            ''', deadline)
        return _sanitize_output_rows(rows)


def _serialize_meeting_permission(row: Dict[str, Any]) -> Dict:
    can_publish = bool(row.get('can_publish_owned')) or bool(row.get('can_publish_all'))
    return {
        'username': str(row.get('username') or '').strip().lower(),
        'nickname': str(row.get('nickname') or '').strip(),
        'added_by': str(row.get('added_by') or '').strip(),
        'status': str(row.get('status') or '').strip(),
        'expire_time': _serialize_time_value(row.get('expire_time')),
        'can_publish': can_publish,
        'can_publish_owned': bool(row.get('can_publish_owned')),
        'can_publish_all': bool(row.get('can_publish_all')),
        'granted_by': str(row.get('granted_by') or '').strip(),
        'scope_owner': str(row.get('scope_owner') or '').strip(),
        'created_at': _serialize_time_value(row.get('created_at')),
        'updated_at': _serialize_time_value(row.get('updated_at')),
    }


async def get_meeting_permission_candidates(added_by: str = None, search: str = None,
                                            limit: int = 200, offset: int = 0) -> Dict:
    pool = _get_pool()
    conditions = ["aa.status = 'active'"]
    params: List[Any] = []
    idx = 1
    if added_by:
        conditions.append(f"aa.added_by = ${idx}")
        params.append(added_by)
        idx += 1
    if search:
        conditions.append(f"(aa.username ILIKE ${idx} OR COALESCE(aa.nickname, '') ILIKE ${idx})")
        params.append(f"%{search}%")
        idx += 1
    where = f" WHERE {' AND '.join(conditions)}"
    async with pool.acquire() as conn:
        total = await conn.fetchval(f"SELECT COUNT(*) FROM authorized_accounts aa{where}", *params)
        params.extend([limit, offset])
        rows = await conn.fetch(f'''
            SELECT aa.username, aa.nickname, aa.added_by, aa.status, aa.expire_time,
                   COALESCE(mp.can_publish_owned, FALSE) AS can_publish_owned,
                   COALESCE(mp.can_publish_all, FALSE) AS can_publish_all,
                   COALESCE(mp.granted_by, '') AS granted_by,
                   COALESCE(mp.scope_owner, '') AS scope_owner,
                   mp.created_at, mp.updated_at
            FROM authorized_accounts aa
            LEFT JOIN meeting_publish_permissions mp ON mp.username = aa.username
            {where}
            ORDER BY aa.created_at DESC
            LIMIT ${idx} OFFSET ${idx + 1}
        ''', *params)
        return {'total': int(total or 0), 'rows': [_serialize_meeting_permission(dict(row)) for row in rows]}


async def get_meeting_publish_permissions(added_by: str = None, search: str = None,
                                          limit: int = 200, offset: int = 0) -> Dict:
    pool = _get_pool()
    conditions = ["(mp.can_publish_owned = TRUE OR mp.can_publish_all = TRUE)"]
    params: List[Any] = []
    idx = 1
    if added_by:
        conditions.append(f"aa.added_by = ${idx}")
        params.append(added_by)
        idx += 1
    if search:
        conditions.append(f"(aa.username ILIKE ${idx} OR COALESCE(aa.nickname, '') ILIKE ${idx})")
        params.append(f"%{search}%")
        idx += 1
    where = f" WHERE {' AND '.join(conditions)}"
    async with pool.acquire() as conn:
        total = await conn.fetchval(f'''
            SELECT COUNT(*)
            FROM meeting_publish_permissions mp
            JOIN authorized_accounts aa ON aa.username = mp.username AND aa.status = 'active'
            {where}
        ''', *params)
        params.extend([limit, offset])
        rows = await conn.fetch(f'''
            SELECT aa.username, aa.nickname, aa.added_by, aa.status, aa.expire_time,
                   mp.can_publish_owned, mp.can_publish_all, mp.granted_by,
                   mp.scope_owner, mp.created_at, mp.updated_at
            FROM meeting_publish_permissions mp
            JOIN authorized_accounts aa ON aa.username = mp.username AND aa.status = 'active'
            {where}
            ORDER BY mp.updated_at DESC
            LIMIT ${idx} OFFSET ${idx + 1}
        ''', *params)
        return {'total': int(total or 0), 'rows': [_serialize_meeting_permission(dict(row)) for row in rows]}


async def get_meeting_publish_permission(username: str) -> Optional[Dict]:
    pool = _get_pool()
    normalized_username = str(username or '').strip().lower()
    if not normalized_username:
        return None
    async with pool.acquire() as conn:
        row = await conn.fetchrow('''
            SELECT aa.username, aa.nickname, aa.added_by, aa.status, aa.expire_time,
                   COALESCE(mp.can_publish_owned, FALSE) AS can_publish_owned,
                   COALESCE(mp.can_publish_all, FALSE) AS can_publish_all,
                   COALESCE(mp.granted_by, '') AS granted_by,
                   COALESCE(mp.scope_owner, '') AS scope_owner,
                   mp.created_at, mp.updated_at
            FROM authorized_accounts aa
            LEFT JOIN meeting_publish_permissions mp ON mp.username = aa.username
            WHERE aa.username = $1 AND aa.status = 'active'
        ''', normalized_username)
        return _serialize_meeting_permission(dict(row)) if row else None


async def set_meeting_publish_permission(username: str, can_publish_owned: bool,
                                         can_publish_all: bool, granted_by: str,
                                         scope_owner: str) -> Optional[Dict]:
    pool = _get_pool()
    normalized_username = str(username or '').strip().lower()
    normalized_granted_by = str(granted_by or '').strip()
    normalized_scope_owner = str(scope_owner or '').strip()
    if not normalized_username:
        return None
    async with pool.acquire() as conn:
        account = await conn.fetchrow('''
            SELECT username, added_by
            FROM authorized_accounts
            WHERE username = $1 AND status = 'active'
        ''', normalized_username)
        if not account:
            return None
        await conn.execute('''
            INSERT INTO meeting_publish_permissions
                (username, can_publish_owned, can_publish_all, granted_by, scope_owner, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
            ON CONFLICT(username) DO UPDATE SET
                can_publish_owned = $2,
                can_publish_all = $3,
                granted_by = $4,
                scope_owner = $5,
                updated_at = NOW()
        ''', normalized_username, bool(can_publish_owned), bool(can_publish_all),
                           normalized_granted_by, normalized_scope_owner)
    return await get_meeting_publish_permission(normalized_username)


async def revoke_meeting_publish_permission(username: str) -> bool:
    pool = _get_pool()
    normalized_username = str(username or '').strip().lower()
    if not normalized_username:
        return False
    async with pool.acquire() as conn:
        result = await conn.execute('''
            UPDATE meeting_publish_permissions
            SET can_publish_owned = FALSE,
                can_publish_all = FALSE,
                updated_at = NOW()
            WHERE username = $1
        ''', normalized_username)
        return int(result.split()[-1]) > 0


async def expire_overdue_accounts() -> int:
    """将已过期的active账号标记为expired"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "UPDATE authorized_accounts SET status='expired', updated_at=NOW() WHERE status='active' AND expire_time < NOW()")
        return int(result.split()[-1])


async def get_overdue_authorized_account_owners() -> List[str]:
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT DISTINCT LOWER(added_by) AS added_by FROM authorized_accounts WHERE status='active' AND expire_time < NOW() AND COALESCE(added_by, '') <> ''")
        return [str(row['added_by']).strip().lower() for row in rows if str(row['added_by']).strip()]


def _load_json_object(raw: Any, default: Any) -> Any:
    try:
        if raw in (None, ''):
            return default
        data = json.loads(raw)
        if isinstance(default, dict) and isinstance(data, dict):
            return data
        if isinstance(default, list) and isinstance(data, list):
            return data
    except Exception:
        pass
    return default


def _serialize_time_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.replace(microsecond=0).isoformat(sep=' ')
    return value


def _serialize_notification_campaign(row: Dict[str, Any]) -> Dict:
    data = dict(row)
    data['payload'] = _load_json_object(data.pop('payload_json', '{}'), {})
    data['audience_snapshot'] = _load_json_object(data.pop('audience_snapshot_json', '{}'), {})
    data['target_count'] = int(data.get('target_count') or 0)
    if 'read_count' in data:
        data['read_count'] = int(data.get('read_count') or 0)
    if 'unread_count' in data:
        data['unread_count'] = int(data.get('unread_count') or 0)
    data['created_at'] = _serialize_time_value(data.get('created_at'))
    data['published_at'] = _serialize_time_value(data.get('published_at'))
    return data


def _serialize_notification_delivery(row: Dict[str, Any]) -> Dict:
    return {
        'username': str(row.get('username') or ''),
        'delivery_status': str(row.get('delivery_status') or ''),
        'created_at': _serialize_time_value(row.get('created_at')),
        'delivered_at': _serialize_time_value(row.get('delivered_at')),
        'last_push_at': _serialize_time_value(row.get('last_push_at')),
        'read_at': _serialize_time_value(row.get('read_at')),
        'read': bool(row.get('read_at')),
    }


async def _fetch_notification_recipient_page(conn, campaign_id: int, status: str = 'unread',
                                             limit: int = 100, offset: int = 0) -> Dict:
    normalized_status = str(status or 'unread').strip().lower()
    if normalized_status not in {'unread', 'read', 'all'}:
        normalized_status = 'unread'
    limit = max(1, min(int(limit or 100), 500))
    offset = max(0, int(offset or 0))
    where = 'WHERE campaign_id = $1'
    if normalized_status == 'unread':
        where += ' AND read_at IS NULL'
    elif normalized_status == 'read':
        where += ' AND read_at IS NOT NULL'
    total = await conn.fetchval(f'''
        SELECT COUNT(*)
        FROM notification_deliveries
        {where}
    ''', int(campaign_id))
    rows = await conn.fetch(f'''
        SELECT username, delivery_status, delivered_at, read_at, last_push_at, created_at
        FROM notification_deliveries
        {where}
        ORDER BY CASE WHEN read_at IS NULL THEN 0 ELSE 1 END, username ASC
        LIMIT $2 OFFSET $3
    ''', int(campaign_id), limit, offset)
    items = [_serialize_notification_delivery(dict(item)) for item in rows]
    next_offset = offset + len(items)
    total_count = int(total or 0)
    return {
        'status': normalized_status,
        'total': total_count,
        'limit': limit,
        'offset': offset,
        'next_offset': next_offset,
        'has_more': next_offset < total_count,
        'rows': items,
    }


async def _fetch_all_notification_recipients(conn, campaign_id: int) -> List[Dict]:
    rows = await conn.fetch('''
        SELECT username, delivery_status, delivered_at, read_at, last_push_at, created_at
        FROM notification_deliveries
        WHERE campaign_id = $1
        ORDER BY CASE WHEN read_at IS NULL THEN 0 ELSE 1 END, username ASC
    ''', int(campaign_id))
    return [_serialize_notification_delivery(dict(item)) for item in rows]


def _serialize_notification_item(row: Dict[str, Any]) -> Dict:
    return {
        'id': int(row.get('id') or 0),
        'notification_type': str(row.get('notification_type') or ''),
        'title': str(row.get('title') or ''),
        'content': str(row.get('content') or ''),
        'payload': _load_json_object(row.get('payload_json', '{}'), {}),
        'created_by': str(row.get('created_by') or ''),
        'created_at': _serialize_time_value(row.get('created_at')),
        'published_at': _serialize_time_value(row.get('published_at')),
        'delivered_at': _serialize_time_value(row.get('delivered_at')),
        'read_at': _serialize_time_value(row.get('read_at')),
        'read': bool(row.get('read_at')),
    }


async def _insert_notification_deliveries_bulk(conn, campaign_id: int, usernames: List[str], sent_at: datetime) -> None:
    rows = [(int(campaign_id), str(username or '').strip().lower(), sent_at) for username in usernames or [] if username]
    if not rows:
        return
    columns = rows_to_columns(rows, 3)
    await execute_bulk_unnest(
        conn,
        _NOTIFICATION_DELIVERY_BULK_INSERT_SQL,
        columns,
        operation="notification.deliveries",
        row_count=len(rows),
    )


async def create_notification_campaign(notification_type: str, title: str, content: str,
                                      payload: Dict[str, Any], audience_mode: str,
                                      audience_snapshot: Dict[str, Any], created_by: str,
                                      usernames: List[str]) -> Dict:
    pool = _get_pool()
    normalized_usernames: List[str] = []
    seen: set[str] = set()
    for item in usernames or []:
        username = str(item or '').strip().lower()
        if not username or username in seen:
            continue
        seen.add(username)
        normalized_usernames.append(username)
    now = datetime.now().replace(microsecond=0)
    payload_json = json.dumps(payload or {}, ensure_ascii=False)
    audience_snapshot_json = json.dumps(audience_snapshot or {}, ensure_ascii=False)
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow('''
                INSERT INTO notification_campaigns
                    (notification_type, title, content, payload_json, audience_mode, audience_snapshot_json, created_by, target_count, created_at, published_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
                RETURNING id, notification_type, title, content, payload_json, audience_mode, audience_snapshot_json, created_by, target_count, created_at, published_at
            ''', notification_type, title, content, payload_json, audience_mode, audience_snapshot_json, created_by, len(normalized_usernames), now)
            if normalized_usernames:
                await _insert_notification_deliveries_bulk(conn, int(row['id']), normalized_usernames, now)
    return _serialize_notification_campaign(dict(row))


async def get_notification_campaign_item(campaign_id: int) -> Optional[Dict]:
    pool = _get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow('''
            SELECT id, notification_type, title, content, payload_json, created_by, created_at, published_at
            FROM notification_campaigns
            WHERE id = $1
        ''', campaign_id)
    if not row:
        return None
    return _serialize_notification_item({**dict(row), 'delivered_at': row['published_at'], 'read_at': None})


async def get_user_notification_items(username: str, limit: int = 20) -> List[Dict]:
    pool = _get_pool()
    normalized_username = str(username or '').strip().lower()
    if not normalized_username:
        return []
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT c.id, c.notification_type, c.title, c.content, c.payload_json,
                   c.created_by, c.created_at, c.published_at,
                   d.delivered_at, d.read_at
            FROM notification_deliveries d
            JOIN notification_campaigns c ON c.id = d.campaign_id
            WHERE d.username = $1
            ORDER BY c.id DESC
            LIMIT $2
        ''', normalized_username, limit)
    return [_serialize_notification_item(dict(row)) for row in rows]


async def get_notification_unread_count(username: str) -> int:
    pool = _get_pool()
    normalized_username = str(username or '').strip().lower()
    if not normalized_username:
        return 0
    async with pool.acquire() as conn:
        count = await conn.fetchval('''
            SELECT COUNT(*)
            FROM notification_deliveries
            WHERE username = $1 AND read_at IS NULL
        ''', normalized_username)
    return int(count or 0)


async def mark_all_notifications_read(username: str) -> List[int]:
    pool = _get_pool()
    normalized_username = str(username or '').strip().lower()
    if not normalized_username:
        return []
    now = datetime.now().replace(microsecond=0)
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            UPDATE notification_deliveries
            SET read_at = $2
            WHERE username = $1 AND read_at IS NULL
            RETURNING campaign_id
        ''', normalized_username, now)
    return [int(row['campaign_id']) for row in rows]


async def _get_notification_campaigns_from_join(limit: int = 20, offset: int = 0,
                                                created_by: str = None) -> Dict:
    pool = _get_pool()
    params: List[Any] = []
    where = ''
    if created_by:
        params.append(created_by)
        where = ' WHERE c.created_by = $1'
    async with pool.acquire() as conn:
        total = await conn.fetchval(f'SELECT COUNT(*) FROM notification_campaigns c{where}', *params)
        params.extend([limit, offset])
        limit_idx = len(params) - 1
        offset_idx = len(params)
        rows = await conn.fetch(f'''
            SELECT c.id, c.notification_type, c.title, c.content, c.payload_json,
                   c.audience_mode, c.audience_snapshot_json, c.created_by,
                   c.target_count, c.created_at, c.published_at,
                   COALESCE(SUM(CASE WHEN d.id IS NOT NULL AND d.read_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS read_count,
                   COALESCE(SUM(CASE WHEN d.id IS NOT NULL AND d.read_at IS NULL THEN 1 ELSE 0 END), 0) AS unread_count
            FROM notification_campaigns c
            LEFT JOIN notification_deliveries d ON d.campaign_id = c.id
            {where}
            GROUP BY c.id
            ORDER BY c.id DESC
            LIMIT ${limit_idx} OFFSET ${offset_idx}
        ''', *params)
    return {'total': int(total or 0), 'rows': [dict(row) for row in rows]}


async def get_notification_campaigns(limit: int = 20, offset: int = 0,
                                    created_by: str = None) -> Dict:
    pool = _get_pool()
    result = await build_notification_campaign_page(
        pool,
        limit=limit,
        offset=offset,
        created_by=created_by,
        fallback=_get_notification_campaigns_from_join,
    )
    return {'total': int(result.get('total') or 0), 'rows': [_serialize_notification_campaign(dict(row)) for row in result.get('rows') or []]}


async def get_notification_campaign_detail(campaign_id: int, created_by: str = None,
                                           recipient_limit: int = 0) -> Optional[Dict]:
    pool = _get_pool()
    if not int(campaign_id or 0):
        return None
    params: List[Any] = [int(campaign_id)]
    where = ' WHERE c.id = $1'
    if created_by:
        params.append(created_by)
        where += ' AND c.created_by = $2'
    async with pool.acquire() as conn:
        row = await conn.fetchrow(f'''
            SELECT c.id, c.notification_type, c.title, c.content, c.payload_json,
                   c.audience_mode, c.audience_snapshot_json, c.created_by,
                   c.target_count, c.created_at, c.published_at
            FROM notification_campaigns c
            {where}
        ''', *params)
        if not row:
            return None
        if int(recipient_limit or 0) > 0:
            unread_page = await _fetch_notification_recipient_page(conn, int(campaign_id), status='unread', limit=recipient_limit, offset=0)
            read_page = await _fetch_notification_recipient_page(conn, int(campaign_id), status='read', limit=recipient_limit, offset=0)
        else:
            recipients = await _fetch_all_notification_recipients(conn, int(campaign_id))
            unread_rows = [item for item in recipients if not item.get('read')]
            read_rows = [item for item in recipients if item.get('read')]
            unread_page = {
                'status': 'unread',
                'total': len(unread_rows),
                'limit': len(unread_rows) or 100,
                'offset': 0,
                'next_offset': len(unread_rows),
                'has_more': False,
                'rows': unread_rows,
            }
            read_page = {
                'status': 'read',
                'total': len(read_rows),
                'limit': len(read_rows) or 100,
                'offset': 0,
                'next_offset': len(read_rows),
                'has_more': False,
                'rows': read_rows,
            }
    data = _serialize_notification_campaign(dict(row))
    data['read_count'] = int(read_page.get('total') or 0)
    data['unread_count'] = int(unread_page.get('total') or 0)
    data['recipient_pages'] = {
        'unread': unread_page,
        'read': read_page,
    }
    data['recipients'] = list(unread_page.get('rows') or []) + list(read_page.get('rows') or [])
    return data


async def get_notification_campaign_recipients(campaign_id: int, created_by: str = None,
                                               status: str = 'unread', limit: int = 100,
                                               offset: int = 0) -> Optional[Dict]:
    pool = _get_pool()
    normalized_campaign_id = int(campaign_id or 0)
    if not normalized_campaign_id:
        return None
    params: List[Any] = [normalized_campaign_id]
    where = 'WHERE id = $1'
    if created_by:
        params.append(created_by)
        where += ' AND created_by = $2'
    async with pool.acquire() as conn:
        exists = await conn.fetchval(f'''
            SELECT 1
            FROM notification_campaigns
            {where}
        ''', *params)
        if not exists:
            return None
        return await _fetch_notification_recipient_page(conn, normalized_campaign_id, status=status, limit=limit, offset=offset)


# ===== 积分配置 =====

async def get_credit_config() -> List[Dict]:
    """获取积分定价配置"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch('SELECT * FROM credit_config ORDER BY duration_days ASC')
        return [dict(r) for r in rows]


async def update_credit_config(plan_type: str, plan_name: str, credits_cost: int, duration_days: int) -> bool:
    """更新/添加积分定价"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        await conn.execute('''
            INSERT INTO credit_config (plan_type, plan_name, credits_cost, duration_days, updated_at)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT(plan_type) DO UPDATE SET
                plan_name=$2, credits_cost=$3, duration_days=$4, updated_at=NOW()
        ''', plan_type, plan_name, credits_cost, duration_days)
        return True


async def delete_credit_config(plan_type: str) -> bool:
    """删除积分定价"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute('DELETE FROM credit_config WHERE plan_type = $1', plan_type)
        return int(result.split()[-1]) > 0


# ===== 积分操作 =====

async def get_sub_admin_credits(name: str) -> int:
    """获取子管理员积分余额"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        val = await conn.fetchval('SELECT credits FROM sub_admins WHERE name = $1', name)
        return val or 0


async def topup_credits(admin_name: str, amount: int, operator: str = 'super_admin',
                        description: str = '') -> Dict:
    """给子管理员充值积分"""
    if amount <= 0:
        raise ValueError("充值金额必须大于0")
    pool = _get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                'UPDATE sub_admins SET credits = credits + $1 WHERE name = $2', amount, admin_name)
            new_balance = await conn.fetchval('SELECT credits FROM sub_admins WHERE name = $1', admin_name)
            await conn.execute('''
                INSERT INTO credit_transactions (admin_name, type, amount, balance_after, description, operator)
                VALUES ($1, 'topup', $2, $3, $4, $5)
            ''', admin_name, amount, new_balance or 0, description or f"充值{amount}积分", operator)
            return {'balance': new_balance or 0, 'amount': amount}


async def deduct_credits(admin_name: str, amount: int, related_username: str = '',
                          description: str = '') -> Dict:
    """扣除子管理员积分（事务安全，余额不足时回滚）"""
    if amount <= 0:
        raise ValueError("扣除金额必须大于0")
    pool = _get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            current = await conn.fetchval('SELECT credits FROM sub_admins WHERE name = $1', admin_name)
            if (current or 0) < amount:
                raise ValueError(f"积分不足: 当前{current or 0}, 需要{amount}")
            await conn.execute(
                'UPDATE sub_admins SET credits = credits - $1 WHERE name = $2', amount, admin_name)
            new_balance = (current or 0) - amount
            await conn.execute('''
                INSERT INTO credit_transactions
                    (admin_name, type, amount, balance_after, description, related_username, operator)
                VALUES ($1, 'deduct', $2, $3, $4, $5, $6)
            ''', admin_name, -amount, new_balance, description or f"扣除{amount}积分", related_username, admin_name)
            return {'balance': new_balance, 'deducted': amount}


async def get_credit_transactions(admin_name: str = None, limit: int = 50, offset: int = 0) -> Dict:
    """获取积分流水"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        if admin_name:
            total = await conn.fetchval(
                'SELECT COUNT(*) FROM credit_transactions WHERE admin_name = $1', admin_name)
            rows = await conn.fetch('''
                SELECT * FROM credit_transactions WHERE admin_name = $1
                ORDER BY created_at DESC LIMIT $2 OFFSET $3
            ''', admin_name, limit, offset)
        else:
            total = await conn.fetchval('SELECT COUNT(*) FROM credit_transactions')
            rows = await conn.fetch('''
                SELECT * FROM credit_transactions ORDER BY created_at DESC LIMIT $1 OFFSET $2
            ''', limit, offset)
        return {'total': total or 0, 'rows': [dict(r) for r in rows]}


# ===== 订阅组管理 =====

async def create_subscription_group(group_id: str, name: str, source_type: str, source_url: str,
                                     total_servers: int, created_by: str = 'admin', notes: str = '') -> bool:
    """创建订阅组"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        try:
            await conn.execute('''
                INSERT INTO subscription_groups (id, name, source_type, source_url, total_servers, active_servers, created_by, notes)
                VALUES ($1, $2, $3, $4, $5, $5, $6, $7)
            ''', group_id, name, source_type, source_url, total_servers, created_by, notes)
            return True
        except Exception as e:
            logger.error(f"[DB] 创建订阅组失败: {e}")
            return False


async def get_subscription_groups(created_by: str = None) -> list:
    """获取订阅组列表"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        if created_by:
            rows = await conn.fetch('''
                SELECT id, name, source_type, source_url, import_time, total_servers, active_servers, created_by, notes
                FROM subscription_groups WHERE created_by = $1 ORDER BY import_time DESC
            ''', created_by)
        else:
            rows = await conn.fetch('''
                SELECT id, name, source_type, source_url, import_time, total_servers, active_servers, created_by, notes
                FROM subscription_groups ORDER BY import_time DESC
            ''')
        return [dict(r) for r in rows]


async def update_subscription_group_servers(group_id: str, total_servers: int, active_servers: int) -> bool:
    """更新订阅组的服务器数量"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        try:
            await conn.execute('''
                UPDATE subscription_groups
                SET total_servers = $2, active_servers = $3, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            ''', group_id, total_servers, active_servers)
            return True
        except Exception as e:
            logger.error(f"[DB] 更新订阅组服务器数量失败: {e}")
            return False


async def update_subscription_group_notes(group_id: str, notes: str) -> bool:
    """更新订阅组备注"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        try:
            await conn.execute('''
                UPDATE subscription_groups
                SET notes = $2, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            ''', group_id, notes)
            return True
        except Exception as e:
            logger.error(f"[DB] 更新订阅组备注失败: {e}")
            return False


async def update_subscription_group_name(group_id: str, name: str) -> bool:
    """更新订阅组名称"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        try:
            result = await conn.execute('''
                UPDATE subscription_groups
                SET name = $2, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            ''', group_id, name)
            return result.endswith('1')
        except Exception as e:
            logger.error(f"[DB] 更新订阅组名称失败: {e}")
            return False


async def delete_subscription_group(group_id: str) -> bool:
    """删除订阅组"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        try:
            await conn.execute('DELETE FROM subscription_groups WHERE id = $1', group_id)
            return True
        except Exception as e:
            logger.error(f"[DB] 删除订阅组失败: {e}")
            return False


async def clear_all_subscription_groups() -> bool:
    """清除所有订阅组记录"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        try:
            await conn.execute('DELETE FROM subscription_groups')
            return True
        except Exception as e:
            logger.error(f"[DB] 清除订阅组失败: {e}")
            return False


# ===== 出口风控事件 =====

async def insert_exit_event(exit_name: str, exit_ip: str, status_code: int, api_path: str = "", client_ip: str = "", account: str = "") -> None:
    """异步写入一条403/429事件，失败静默忽略"""
    pool = _get_pool()
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                'INSERT INTO exit_events (exit_name, exit_ip, status_code, api_path, client_ip, account) VALUES ($1,$2,$3,$4,$5,$6)',
                exit_name, exit_ip or "", status_code, api_path, client_ip or "", account or ""
            )
    except Exception as e:
        logger.debug(f"[DB] exit_event写入失败: {e}")


async def query_exit_events(exit_name: str = None, status_code: int = None, client_ip: str = None, account: str = None,
                             hours: int = 24, limit: int = 200) -> List[Dict]:
    """查询出口风控事件，支持按出口名、状态码、时间范围过滤"""
    pool = _get_pool()
    conditions = ["ts >= NOW() - INTERVAL '" + str(hours) + " hours'"]
    params: list = []
    if exit_name:
        params.append(exit_name)
        conditions.append(f"exit_name = ${len(params)}")
    if status_code:
        params.append(status_code)
        conditions.append(f"status_code = ${len(params)}")
    if client_ip:
        params.append(client_ip)
        conditions.append(f"client_ip = ${len(params)}")
    if account:
        params.append(account)
        conditions.append(f"account = ${len(params)}")
    where = " AND ".join(conditions)
    params.append(limit)
    sql = f"SELECT id,exit_name,exit_ip,client_ip,account,status_code,api_path,ts FROM exit_events WHERE {where} ORDER BY ts DESC LIMIT ${len(params)}"
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, *params)
        return [{**dict(r), "ts": r["ts"].strftime("%m-%d %H:%M:%S")} for r in rows]


async def cleanup_exit_events(days: int = 30) -> int:
    """清理超过 days 天的旧事件，返回删除行数"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            f"DELETE FROM exit_events WHERE ts < NOW() - INTERVAL '{days} days'"
        )
        deleted = int(result.split()[-1])
        if deleted > 0:
            logger.info(f"[DB] 清理旧exit_events: {deleted} 条")
        return deleted


async def get_all_sub_admin_credits() -> List[Dict]:
    """获取所有子管理员积分概览"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT s.name, COALESCE(s.credits, 0) as credits,
                   (SELECT COUNT(*) FROM authorized_accounts WHERE added_by = s.name AND status = 'active') as active_count,
                   (SELECT COUNT(*) FROM authorized_accounts WHERE added_by = s.name) as total_count
            FROM sub_admins s ORDER BY s.name
        ''')
        return [dict(r) for r in rows]


class SystemConfig:
    _instance = None
    _cache: Dict[str, Any] = {}
    _cache_lock = asyncio.Lock()
    _cache_ttl = 60
    _cache_time = 0.0

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    async def _ensure_table(self):
        pool = _get_pool()
        async with pool.acquire() as conn:
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS system_config (
                    key VARCHAR(100) PRIMARY KEY,
                    value JSONB NOT NULL,
                    description TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            await conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_system_config_key ON system_config(key)
            ''')

    async def get(self, key: str, default: Any = None) -> Any:
        now = time.time()
        async with self._cache_lock:
            if now - self._cache_time < self._cache_ttl and key in self._cache:
                return self._cache.get(key, default)
        await self._ensure_table()
        pool = _get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                'SELECT value FROM system_config WHERE key = $1', key
            )
            if row:
                value = json.loads(row['value'])
            else:
                value = default
        async with self._cache_lock:
            self._cache[key] = value
            if now - self._cache_time >= self._cache_ttl:
                self._cache_time = now
        return value

    async def set(self, key: str, value: Any, description: str = '') -> bool:
        try:
            await self._ensure_table()
            pool = _get_pool()
            async with pool.acquire() as conn:
                await conn.execute('''
                    INSERT INTO system_config (key, value, description, updated_at)
                    VALUES ($1, $2, $3, NOW())
                    ON CONFLICT (key) DO UPDATE SET
                        value = $2, description = $3, updated_at = NOW()
                ''', key, json.dumps(value), description)
            async with self._cache_lock:
                self._cache.pop(key, None)
                self._cache_time = 0.0
            logger.info(f'[SystemConfig] 配置已更新: {key} = {value}')
            return True
        except Exception as e:
            logger.error(f'[SystemConfig] 设置配置失败: {key} = {value}, {e}')
            return False


system_config = SystemConfig()


async def get_whitelist_global_status() -> bool:
    return bool(await system_config.get('whitelist_open_to_all', True))


async def set_whitelist_global_status(enabled: bool) -> bool:
    return await system_config.set(
        'whitelist_open_to_all',
        bool(enabled),
        '全体白名单：开启后所有人可登录AK服务器，关闭后仅白名单用户可登录'
    )


def _normalize_shared_login_state_policy(value: Any) -> Dict[str, Any]:
    if isinstance(value, bool):
        return {'global_enabled': bool(value), 'sub_admins': {}}
    if not isinstance(value, dict):
        return {'global_enabled': False, 'sub_admins': {}}
    sub_admins = value.get('sub_admins')
    if not isinstance(sub_admins, dict):
        sub_admins = {}
    return {
        'global_enabled': bool(value.get('global_enabled', False)),
        'sub_admins': {
            str(key or '').strip().lower(): bool(enabled)
            for key, enabled in sub_admins.items()
            if str(key or '').strip()
        },
    }


async def get_shared_login_state_policy() -> Dict[str, Any]:
    saved = await system_config.get('shared_login_state_policy', None)
    if saved is None:
        legacy = await system_config.get('shared_login_state_enabled', None)
        saved = legacy if isinstance(legacy, bool) else None
    return _normalize_shared_login_state_policy(saved)


async def set_shared_login_state_policy(policy: Dict[str, Any]) -> bool:
    normalized = _normalize_shared_login_state_policy(policy)
    return await system_config.set(
        'shared_login_state_policy',
        normalized,
        '共享登录态：总管理员控制全局，子管理员控制自己白名单成员'
    )


async def get_risk_isolation_404_page_enabled() -> bool:
    return bool(await system_config.get('risk_isolation_404_page_enabled', True))


async def set_risk_isolation_404_page_enabled(enabled: bool) -> bool:
    return await system_config.set(
        'risk_isolation_404_page_enabled',
        bool(enabled),
        '风险隔离：开启后被隔离用户登录时跳转404页面，关闭后返回普通登录失败'
    )


# ===== 点数统计配额：5 分钟冷却 + 每日 3 账号限额 =====

POINT_STATS_COOLDOWN_SECONDS = 300
POINT_STATS_DAILY_ACCOUNT_LIMIT = 3


async def record_point_stats_quota_usage(admin_id: str, target_account: str, point_type: str) -> None:
    """记录一次点数统计 sync 调用：UPSERT used_at = NOW()。
    超管也记录（用于配额接口展示），但调用方在外层判定是否豁免限额。
    """
    pool = _get_pool()
    async with pool.acquire() as conn:
        await conn.execute('''
            INSERT INTO admin_point_stats_quota (admin_id, target_account, point_type, used_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (admin_id, target_account, point_type) DO UPDATE SET used_at = NOW()
        ''', admin_id, target_account.lower(), point_type.upper())


async def get_point_stats_cooldown_remaining(admin_id: str, target_account: str, point_type: str) -> int:
    """返回 (admin, account, type) 组合的剩余冷却秒数；无记录或已过期返回 0。"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        used_at = await conn.fetchval('''
            SELECT used_at FROM admin_point_stats_quota
            WHERE admin_id = $1 AND target_account = $2 AND point_type = $3
        ''', admin_id, target_account.lower(), point_type.upper())
    if used_at is None:
        return 0
    elapsed = (datetime.now() - used_at).total_seconds()
    remaining = int(POINT_STATS_COOLDOWN_SECONDS - elapsed)
    return remaining if remaining > 0 else 0


async def get_point_stats_quota_status(admin_id: str) -> Dict[str, Any]:
    """返回某管理员当日点数统计配额状态：已操作 distinct 账号集合 + 当前冷却中条目。
    used_count 仅按 distinct target_account 计数（同账号多个 point_type 算 1 个）。
    """
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT target_account, point_type, used_at
            FROM admin_point_stats_quota
            WHERE admin_id = $1 AND used_at::date = CURRENT_DATE
            ORDER BY used_at DESC
        ''', admin_id)
    used_accounts: List[str] = []
    seen_accounts = set()
    cooldowns: List[Dict[str, Any]] = []
    now = datetime.now()
    for row in rows:
        account = row['target_account']
        point_type = row['point_type']
        used_at = row['used_at']
        if account not in seen_accounts:
            seen_accounts.add(account)
            used_accounts.append(account)
        elapsed = (now - used_at).total_seconds()
        remaining = int(POINT_STATS_COOLDOWN_SECONDS - elapsed)
        if remaining > 0:
            cooldowns.append({
                'account': account,
                'point_type': point_type,
                'remaining_seconds': remaining,
            })
    return {
        'used_count': len(used_accounts),
        'used_accounts': used_accounts,
        'cooldowns': cooldowns,
    }
