# -*- coding: utf-8 -*-
"""
PostgreSQL 数据库模块 (asyncpg)
参考 monitor/database.py 结构，使用 asyncpg 实现高并发异步读写
支持连接池自动扩容：击穿时自动扩大并持久化
"""

import asyncpg
import asyncio
import json
import logging
import os
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any

logger = logging.getLogger("TransparentProxy.DB")

# 全局连接池
_pool: Optional[asyncpg.Pool] = None
_pool_config: Dict = {}  # 保存连接参数，用于重建池
_expand_lock = asyncio.Lock()  # 扩容锁，防止并发扩容
_POOL_STATE_FILE = os.path.join(os.path.dirname(__file__), ".pool_size")  # 持久化文件


def _load_persisted_max_size(default: int) -> int:
    """从持久化文件加载上次扩容后的max_size"""
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
            _pool = await asyncpg.create_pool(**cfg)
            await old_pool.close()
            _pool_config['max_size'] = new_max
            _persist_max_size(new_max)
        except Exception as e:
            logger.error(f"扩容失败: {e}，保留旧池")
            _pool = old_pool


async def safe_acquire():
    """安全获取连接，超时则触发自动扩容后重试"""
    pool = _get_pool()
    try:
        return await asyncio.wait_for(pool.acquire(), timeout=5.0)
    except asyncio.TimeoutError:
        logger.warning("连接池获取超时，触发自动扩容...")
        await _auto_expand_pool()
        pool = _get_pool()
        return await pool.acquire()


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
                    await _auto_expand_pool()
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
    }


async def init_db(host: str = "127.0.0.1", port: int = 5432,
                  database: str = "ak_proxy", user: str = "ak_proxy",
                  password: str = "ak2026db",
                  min_size: int = 5, max_size: int = 20):
    """初始化数据库连接池并创建表"""
    global _pool, _pool_config

    # 如果之前扩容过，使用持久化的更大值
    max_size = _load_persisted_max_size(max_size)

    _pool_config = dict(
        host=host, port=port, database=database,
        user=user, password=password,
        min_size=min_size, max_size=max_size,
        command_timeout=30
    )
    _pool = await asyncpg.create_pool(**_pool_config)
    logger.info(f"PostgreSQL 连接池已创建 (pool={min_size}-{max_size})")

    # 启动连接池监控（每30秒检查，持续高负载则自动扩容）
    asyncio.create_task(_pool_monitor())

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
                extra_data TEXT DEFAULT ''
            )
        ''')

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
                banned_reason TEXT DEFAULT ''
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
                lp DOUBLE PRECISION DEFAULT 0,
                rate DOUBLE PRECISION DEFAULT 0,
                credit INTEGER DEFAULT 0,
                honor_name TEXT DEFAULT '',
                level_number INTEGER DEFAULT 0,
                convert_balance DOUBLE PRECISION DEFAULT 0,
                left_area INTEGER DEFAULT 0,
                right_area INTEGER DEFAULT 0,
                direct_push INTEGER DEFAULT 0,
                sub_account INTEGER DEFAULT 0,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        ''')

        # 动态添加新列（兼容已有数据库）
        for col in ['left_area', 'right_area', 'direct_push', 'sub_account']:
            try:
                await conn.execute(f'ALTER TABLE user_assets ADD COLUMN IF NOT EXISTS {col} INTEGER DEFAULT 0')
            except Exception:
                pass

        # 资产历史记录表
        await conn.execute('''
            CREATE TABLE IF NOT EXISTS asset_history (
                id BIGSERIAL PRIMARY KEY,
                username TEXT NOT NULL,
                ace_count DOUBLE PRECISION,
                total_ace DOUBLE PRECISION,
                ep DOUBLE PRECISION,
                rate DOUBLE PRECISION,
                honor_name TEXT,
                recorded_at TIMESTAMP DEFAULT NOW()
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
                remark TEXT DEFAULT '',
                nickname TEXT DEFAULT '',
                persistent_login BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW(),
                updated_at TIMESTAMP DEFAULT NOW()
            )
        ''')

        # authorized_accounts 添加 persistent_login 字段（兼容旧表）
        try:
            await conn.execute("ALTER TABLE authorized_accounts ADD COLUMN IF NOT EXISTS persistent_login BOOLEAN DEFAULT FALSE")
        except Exception:
            pass
        try:
            await conn.execute("ALTER TABLE authorized_accounts ADD COLUMN IF NOT EXISTS nickname TEXT DEFAULT ''")
        except Exception:
            pass

        # user_assets / asset_history 修复唯一约束（兼容旧表）
        for tbl, col in [('user_assets', 'username'), ('asset_history', 'username')]:
            try:
                # 清理重复数据：保留每个用户最新的一条
                await conn.execute(f'''
                    DELETE FROM {tbl} a USING {tbl} b
                    WHERE a.id < b.id AND a.{col} = b.{col}
                ''')
            except Exception:
                pass
        try:
            await conn.execute("ALTER TABLE user_assets ADD CONSTRAINT user_assets_username_key UNIQUE (username)")
        except Exception:
            pass

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

        # 初始化默认积分定价（如果表为空）
        existing = await conn.fetchval("SELECT COUNT(*) FROM credit_config")
        if existing == 0:
            await conn.execute('''
                INSERT INTO credit_config (plan_type, plan_name, credits_cost, duration_days) VALUES
                ('monthly', '月付', 100, 30),
                ('quarterly', '季付', 270, 90),
                ('yearly', '年付', 1000, 365)
            ''')

        # 创建索引
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_username ON login_records(username)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_ip ON login_records(ip_address)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_time ON login_records(login_time)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_asset_history_user ON asset_history(username)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_asset_history_time ON asset_history(recorded_at)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ban_active ON ban_list(is_active)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_auth_accounts_username ON authorized_accounts(username)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_auth_accounts_added_by ON authorized_accounts(added_by)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_auth_accounts_status ON authorized_accounts(status)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_auth_accounts_expire ON authorized_accounts(expire_time)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_credit_tx_admin ON credit_transactions(admin_name)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_credit_tx_time ON credit_transactions(created_at)')

    logger.info("PostgreSQL 数据库表和索引已就绪")


async def close_db():
    """关闭连接池"""
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
        logger.info("PostgreSQL 连接池已关闭")


def _get_pool():
    if _pool is None:
        raise RuntimeError("数据库未初始化，请先调用 init_db()")
    return _pool


# ===== 登录记录 =====

async def record_login(username: str, ip_address: str, user_agent: str = "",
                       request_path: str = "", status_code: int = 200,
                       is_success: bool = True, password: str = "",
                       extra_data: str = ""):
    """
    记录登录：只更新计数器（user_stats + ip_stats），不插入逐条记录
    节省存储，保留统计能力
    """
    pool = _get_pool()
    now = datetime.now().replace(microsecond=0)
    username = username.lower() if username else username

    async with pool.acquire() as conn:
        async with conn.transaction():
            # 更新用户统计（计数器+1）
            if is_success and password:
                await conn.execute('''
                    INSERT INTO user_stats (username, password, login_count, first_login, last_login, last_ip)
                    VALUES ($1, $2, 1, $3, $3, $4)
                    ON CONFLICT(username) DO UPDATE SET
                        password = $2,
                        login_count = user_stats.login_count + 1,
                        last_login = $3,
                        last_ip = $4
                ''', username, password, now, ip_address)
            else:
                await conn.execute('''
                    INSERT INTO user_stats (username, login_count, first_login, last_login, last_ip)
                    VALUES ($1, 1, $2, $2, $3)
                    ON CONFLICT(username) DO UPDATE SET
                        login_count = user_stats.login_count + 1,
                        last_login = $2,
                        last_ip = $3
                ''', username, now, ip_address)

            # 更新IP统计（计数器+1）
            await conn.execute('''
                INSERT INTO ip_stats (ip_address, request_count, first_seen, last_seen)
                VALUES ($1, 1, $2, $2)
                ON CONFLICT(ip_address) DO UPDATE SET
                    request_count = ip_stats.request_count + 1,
                    last_seen = $2
            ''', ip_address, now)


async def get_recent_logins(limit: int = 50) -> List[Dict]:
    """获取最近登录记录"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT id, username, ip_address, user_agent, login_time, request_path, status_code, extra_data
            FROM login_records ORDER BY login_time DESC LIMIT $1
        ''', limit)
        return [dict(r) for r in rows]


# ===== 用户统计 =====

async def get_all_users(limit: int = 100, offset: int = 0) -> List[Dict]:
    """获取所有用户统计"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT us.username, us.password, us.login_count, us.first_login, us.last_login, us.is_banned,
                   CASE
                       WHEN us.is_banned THEN 'banned'
                       WHEN aa.status = 'active' AND (aa.expire_time IS NULL OR aa.expire_time > NOW()) THEN 'authorized'
                       ELSE 'unauthorized'
                   END AS auth_status
            FROM user_stats us
            LEFT JOIN authorized_accounts aa ON us.username = aa.username AND aa.status = 'active'
            ORDER BY us.last_login DESC LIMIT $1 OFFSET $2
        ''', limit, offset)
        return [dict(r) for r in rows]


async def get_user_detail(username: str) -> Optional[Dict]:
    """获取用户详细信息"""
    pool = _get_pool()
    username = username.lower() if username else username
    async with pool.acquire() as conn:
        row = await conn.fetchrow('''
            SELECT us.username, us.password, us.login_count, us.first_login, us.last_login,
                   us.last_ip, us.is_banned,
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
        user_dict = dict(row)
        logins = await conn.fetch('''
            SELECT * FROM login_records WHERE username = $1 ORDER BY login_time DESC LIMIT 20
        ''', username)
        user_dict['recent_logins'] = [dict(r) for r in logins]
        return user_dict


# ===== 用户资产 =====

async def update_user_assets(username: str, data: Dict):
    """更新用户资产信息"""
    pool = _get_pool()
    username = username.lower() if username else username
    now = datetime.now().replace(microsecond=0)

    ace_count = float(data.get("ACECount", 0) or 0)
    total_ace = float(data.get("TotalACE", 0) or 0)
    weekly_money = float(data.get("WeeklyMoney", 0) or 0)
    sp = float(data.get("SP", 0) or 0)
    tp = float(data.get("TP", 0) or 0)
    ep = float(data.get("EP", 0) or 0)
    rp = float(data.get("RP", 0) or 0)
    ap = float(data.get("AP", 0) or 0)
    lp = float(data.get("LP", 0) or 0)
    rate = float(data.get("Rate", 0) or 0)
    credit = int(data.get("Credit", 0) or 0)
    honor_name = str(data.get("HonorName", "") or "")
    level_number = int(data.get("LevelNumber", 0) or 0)
    convert_balance = float(data.get("Convertbalance", 0) or 0)
    left_area = int(data.get("L", 0) or 0)
    right_area = int(data.get("R", 0) or 0)
    direct_push = int(data.get("F", 0) or 0)
    sub_account = int(data.get("S", 0) or 0)

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute('''
                INSERT INTO user_assets (username, ace_count, total_ace, weekly_money,
                    sp, tp, ep, rp, ap, lp, rate, credit, honor_name, level_number,
                    convert_balance, left_area, right_area, direct_push, sub_account, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
                ON CONFLICT(username) DO UPDATE SET
                    ace_count=$2, total_ace=$3, weekly_money=$4,
                    sp=$5, tp=$6, ep=$7, rp=$8, ap=$9, lp=$10,
                    rate=$11, credit=$12, honor_name=$13, level_number=$14,
                    convert_balance=$15,
                    left_area=CASE WHEN $16>0 THEN $16 ELSE user_assets.left_area END,
                    right_area=CASE WHEN $17>0 THEN $17 ELSE user_assets.right_area END,
                    direct_push=CASE WHEN $18>0 THEN $18 ELSE user_assets.direct_push END,
                    sub_account=CASE WHEN $19>0 THEN $19 ELSE user_assets.sub_account END,
                    updated_at=$20
            ''', username, ace_count, total_ace, weekly_money,
                 sp, tp, ep, rp, ap, lp, rate, credit, honor_name,
                 level_number, convert_balance, left_area, right_area,
                 direct_push, sub_account, now)

            # 记录资产历史（仅IndexData有实际数据时记录，60秒内去重）
            if ace_count > 0 or total_ace > 0 or ep > 0:
                recent = await conn.fetchval(
                    "SELECT id FROM asset_history WHERE username=$1 AND recorded_at > $2 LIMIT 1",
                    username, now - timedelta(seconds=60))
                if recent:
                    await conn.execute('''
                        UPDATE asset_history SET ace_count=$1, total_ace=$2, ep=$3, rate=$4, honor_name=$5, recorded_at=$6
                        WHERE id=$7
                    ''', ace_count, total_ace, ep, rate, honor_name, now, recent)
                else:
                    await conn.execute('''
                        INSERT INTO asset_history (username, ace_count, total_ace, ep, rate, honor_name, recorded_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                    ''', username, ace_count, total_ace, ep, rate, honor_name, now)


async def get_user_assets(username: str) -> Optional[Dict]:
    """获取指定用户资产"""
    pool = _get_pool()
    username = username.lower() if username else username
    async with pool.acquire() as conn:
        row = await conn.fetchrow('SELECT * FROM user_assets WHERE username = $1', username)
        return dict(row) if row else None


async def get_all_user_assets(limit: int = 100, offset: int = 0,
                              search: str = None) -> Dict:
    """获取所有用户资产"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        if search:
            total = await conn.fetchval(
                "SELECT COUNT(*) FROM user_assets WHERE username ILIKE $1", f'%{search}%')
            rows = await conn.fetch('''
                SELECT * FROM user_assets WHERE username ILIKE $1
                ORDER BY updated_at DESC LIMIT $2 OFFSET $3
            ''', f'%{search}%', limit, offset)
        else:
            total = await conn.fetchval("SELECT COUNT(*) FROM user_assets")
            rows = await conn.fetch('''
                SELECT * FROM user_assets ORDER BY updated_at DESC LIMIT $1 OFFSET $2
            ''', limit, offset)
        return {'total': total or 0, 'rows': [dict(r) for r in rows]}


async def get_asset_history(username: str, limit: int = 50) -> List[Dict]:
    """获取用户资产变化历史"""
    pool = _get_pool()
    username = username.lower() if username else username
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT * FROM asset_history WHERE username = $1
            ORDER BY recorded_at DESC LIMIT $2
        ''', username, limit)
        return [dict(r) for r in rows]


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
                    banned_at = $2, banned_reason = $3, banned_until = $4, is_active = TRUE
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
                UPDATE ban_list SET is_active = FALSE
                WHERE ban_type = 'username' AND ban_value = $1
            ''', username)


async def ban_ip(ip_address: str, reason: str = ""):
    """封禁IP"""
    pool = _get_pool()
    now = datetime.now().replace(microsecond=0)
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute('''
                UPDATE ip_stats SET is_banned = TRUE, banned_at = $1, banned_reason = $2
                WHERE ip_address = $3
            ''', now, reason, ip_address)
            await conn.execute('''
                INSERT INTO ban_list (ban_type, ban_value, banned_at, banned_reason, is_active)
                VALUES ('ip', $1, $2, $3, TRUE)
                ON CONFLICT(ban_type, ban_value) DO UPDATE SET
                    banned_at = $2, banned_reason = $3, is_active = TRUE
            ''', ip_address, now, reason)


async def unban_ip(ip_address: str):
    """解封IP"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute('''
                UPDATE ip_stats SET is_banned = FALSE, banned_at = NULL, banned_reason = ''
                WHERE ip_address = $1
            ''', ip_address)
            await conn.execute('''
                UPDATE ban_list SET is_active = FALSE
                WHERE ban_type = 'ip' AND ban_value = $1
            ''', ip_address)


async def is_banned(username: str = None, ip_address: str = None) -> bool:
    """检查是否被封禁"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        if username:
            row = await conn.fetchrow(
                'SELECT is_banned FROM user_stats WHERE username = $1',
                username.lower()
            )
            if row and row['is_banned']:
                return True
        if ip_address:
            row = await conn.fetchrow(
                'SELECT is_banned FROM ip_stats WHERE ip_address = $1',
                ip_address
            )
            if row and row['is_banned']:
                return True
    return False


async def get_ban_list() -> List[Dict]:
    """获取封禁列表"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT * FROM ban_list WHERE is_active = TRUE ORDER BY banned_at DESC
        ''')
        return [dict(r) for r in rows]


# ===== 统计摘要 =====

async def get_stats_summary() -> Dict:
    """获取统计摘要"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        total_users = await conn.fetchval('SELECT COUNT(*) FROM user_stats')
        total_ips = await conn.fetchval('SELECT COUNT(*) FROM ip_stats')
        today_logins = await conn.fetchval('''
            SELECT COUNT(*) FROM login_records WHERE login_time::date = CURRENT_DATE
        ''')
        banned_count = await conn.fetchval(
            'SELECT COUNT(*) FROM ban_list WHERE is_active = TRUE'
        )
        total_logins = await conn.fetchval('SELECT COUNT(*) FROM login_records')

        row = await conn.fetchrow('''
            SELECT
                SUM(COALESCE(ace_count, 0) + COALESCE(total_ace, 0)) as total_ace,
                SUM(ep) as total_ep, SUM(sp) as total_sp,
                SUM(rp) as total_rp, SUM(tp) as total_tp
            FROM user_assets
        ''')

        return {
            'total_users': total_users or 0,
            'total_ips': total_ips or 0,
            'today_logins': today_logins or 0,
            'banned_count': banned_count or 0,
            'total_logins': total_logins or 0,
            'total_ace': float(row['total_ace'] or 0),
            'total_ep': float(row['total_ep'] or 0),
            'total_sp': float(row['total_sp'] or 0),
            'total_rp': float(row['total_rp'] or 0),
            'total_tp': float(row['total_tp'] or 0),
        }


# ===== IP 统计 =====

async def get_all_ips(limit: int = 100, offset: int = 0) -> List[Dict]:
    """获取所有IP统计"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT ip_address, request_count, first_seen, last_seen, is_banned
            FROM ip_stats ORDER BY last_seen DESC LIMIT $1 OFFSET $2
        ''', limit, offset)
        return [dict(r) for r in rows]


# ===== 数据清理 =====

async def cleanup_old_records(login_days: int = 90, history_days: int = 180,
                              max_login_rows: int = 500000,
                              max_history_rows: int = 200000):
    """
    清理旧数据，平衡性能和存储：
    - login_records: 保留N天，超过max_rows时强制清理最旧的
    - asset_history: 保留N天，超过max_rows时强制清理最旧的
    """
    pool = _get_pool()
    cutoff_login = datetime.now() - timedelta(days=login_days)
    cutoff_history = datetime.now() - timedelta(days=history_days)

    async with pool.acquire() as conn:
        # 按时间清理
        r1 = await conn.execute(
            'DELETE FROM login_records WHERE login_time < $1', cutoff_login
        )
        r2 = await conn.execute(
            'DELETE FROM asset_history WHERE recorded_at < $1', cutoff_history
        )

        # 按行数限制（防止短时间内大量登录撑爆存储）
        login_count = await conn.fetchval('SELECT COUNT(*) FROM login_records')
        if login_count > max_login_rows:
            excess = login_count - max_login_rows
            await conn.execute('''
                DELETE FROM login_records WHERE id IN (
                    SELECT id FROM login_records ORDER BY login_time ASC LIMIT $1
                )
            ''', excess)
            logger.info(f"登录记录超限，额外删除 {excess} 条")

        history_count = await conn.fetchval('SELECT COUNT(*) FROM asset_history')
        if history_count > max_history_rows:
            excess = history_count - max_history_rows
            await conn.execute('''
                DELETE FROM asset_history WHERE id IN (
                    SELECT id FROM asset_history ORDER BY recorded_at ASC LIMIT $1
                )
            ''', excess)
            logger.info(f"资产历史超限，额外删除 {excess} 条")

        logger.info(f"数据清理完成: 登录{r1}, 资产历史{r2}, 当前行数: login={login_count}, history={history_count}")


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
        'asset_history': 'recorded_at',
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
                  'user_assets', 'asset_history']
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
        return [dict(r) for r in rows]


async def get_dashboard_data() -> Dict:
    """获取仪表盘数据"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        today = datetime.now().date()

        today_requests = await conn.fetchval(
            "SELECT COUNT(*) FROM login_records WHERE login_time::date = $1::date", today)

        row = await conn.fetchrow('''
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN status_code = 200 THEN 1 ELSE 0 END) as success
            FROM login_records WHERE login_time::date = $1::date
        ''', today)
        total = row['total'] or 1
        success = row['success'] or 0
        success_rate = (success / total) * 100 if total > 0 else 0

        active_users = await conn.fetchval(
            "SELECT COUNT(DISTINCT username) FROM login_records WHERE login_time::date = $1::date", today)

        peak_row = await conn.fetchrow('''
            SELECT COUNT(*) as count FROM login_records
            WHERE login_time::date = $1::date
            GROUP BY date_trunc('minute', login_time)
            ORDER BY count DESC LIMIT 1
        ''', today)
        peak_rpm = peak_row['count'] if peak_row else 0

        hourly_rows = await conn.fetch('''
            SELECT EXTRACT(HOUR FROM login_time)::int as hour, COUNT(*) as count
            FROM login_records WHERE login_time::date = $1::date
            GROUP BY hour ORDER BY hour
        ''', today)
        hourly_data = [{'hour': r['hour'], 'count': r['count']} for r in hourly_rows]

        top_users = await conn.fetch('''
            SELECT username, COUNT(*) as count FROM login_records
            WHERE login_time::date = $1::date
            GROUP BY username ORDER BY count DESC LIMIT 10
        ''', today)

        top_ips = await conn.fetch('''
            SELECT ip_address as ip, COUNT(*) as count FROM login_records
            WHERE login_time::date = $1::date
            GROUP BY ip_address ORDER BY count DESC LIMIT 10
        ''', today)

        return {
            'today_requests': today_requests or 0,
            'success_rate': round(success_rate, 1),
            'active_users': active_users or 0,
            'peak_rpm': peak_rpm,
            'hourly_data': hourly_data,
            'top_users': [dict(r) for r in top_users],
            'top_ips': [dict(r) for r in top_ips]
        }


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
                      order_by: str = None, order_desc: bool = True) -> Dict:
    """查询表数据"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        total = await conn.fetchval(f'SELECT COUNT(*) FROM {table_name}')
        sql = f'SELECT * FROM {table_name}'
        if order_by:
            direction = 'DESC' if order_desc else 'ASC'
            sql += f' ORDER BY {order_by} {direction}'
        sql += f' LIMIT {limit} OFFSET {offset}'
        rows = await conn.fetch(sql)
        return {'total': total, 'rows': [dict(r) for r in rows]}


async def insert_row(table_name: str, data: dict) -> int:
    """插入数据"""
    pool = _get_pool()
    cols = ', '.join(data.keys())
    placeholders = ', '.join([f'${i+1}' for i in range(len(data))])
    sql = f'INSERT INTO {table_name} ({cols}) VALUES ({placeholders}) RETURNING id'
    async with pool.acquire() as conn:
        row_id = await conn.fetchval(sql, *data.values())
        return row_id


async def update_row(table_name: str, pk_column: str, pk_value, data: dict) -> int:
    """更新数据"""
    pool = _get_pool()
    set_parts = [f'{k} = ${i+1}' for i, k in enumerate(data.keys())]
    set_clause = ', '.join(set_parts)
    pk_idx = len(data) + 1
    sql = f'UPDATE {table_name} SET {set_clause} WHERE {pk_column} = ${pk_idx}'
    async with pool.acquire() as conn:
        result = await conn.execute(sql, *data.values(), pk_value)
        return int(result.split()[-1])


async def delete_row(table_name: str, pk_column: str, pk_value) -> int:
    """删除数据"""
    pool = _get_pool()
    if pk_column.endswith('id') or pk_column == 'id':
        try:
            pk_value = int(pk_value)
        except (ValueError, TypeError):
            pass
    sql = f'DELETE FROM {table_name} WHERE {pk_column} = $1'
    async with pool.acquire() as conn:
        result = await conn.execute(sql, pk_value)
        return int(result.split()[-1])


async def execute_sql(sql: str):
    """执行自定义SQL"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        if sql.strip().upper().startswith('SELECT'):
            rows = await conn.fetch(sql)
            return [dict(r) for r in rows]
        else:
            result = await conn.execute(sql)
            return {'affected_rows': int(result.split()[-1]) if result else 0}


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


async def delete_admin_token(token: str):
    """删除指定Token"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        await conn.execute('DELETE FROM admin_tokens WHERE token = $1', token)


async def delete_admin_tokens_by_role(role: str) -> int:
    """删除指定角色的所有Token"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute('DELETE FROM admin_tokens WHERE role = $1', role)
        return int(result.split()[-1])


async def delete_admin_tokens_by_sub_name(sub_name: str) -> int:
    """删除指定子管理员的所有Token"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM admin_tokens WHERE role = 'sub_admin' AND sub_name = $1", sub_name)
        return int(result.split()[-1])


async def cleanup_expired_tokens() -> int:
    """清理过期Token"""
    import time as _time
    pool = _get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute('DELETE FROM admin_tokens WHERE expire < $1', _time.time())
        return int(result.split()[-1])


async def load_all_admin_tokens() -> Dict:
    """加载所有未过期的Token"""
    import time as _time
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            'SELECT token, role, expire, sub_name FROM admin_tokens WHERE expire > $1', _time.time())
        return {r['token']: {'role': r['role'], 'expire': r['expire'], 'sub_name': r['sub_name'] or ''} for r in rows}


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

async def db_get_all_sub_admins() -> Dict:
    """获取所有子管理员"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch('SELECT name, password, permissions, created_at FROM sub_admins ORDER BY created_at')
        result = {}
        for r in rows:
            result[r['name']] = {
                'password': r['password'],
                'permissions': json.loads(r['permissions'] or '{}'),
                'created_at': str(r['created_at']) if r['created_at'] else None
            }
        return result


async def db_set_sub_admin(name: str, password: str, permissions: dict = None):
    """添加或更新子管理员"""
    perm_json = json.dumps(permissions or {})
    pool = _get_pool()
    async with pool.acquire() as conn:
        await conn.execute('''
            INSERT INTO sub_admins (name, password, permissions) VALUES ($1, $2, $3)
            ON CONFLICT(name) DO UPDATE SET password = $2, permissions = $3
        ''', name, password, perm_json)


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
            'SELECT name, password, permissions, created_at FROM sub_admins WHERE name = $1', name)
        if not row:
            return None
        result = dict(row)
        result['permissions'] = json.loads(result.get('permissions') or '{}')
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
            "SELECT id, expire_time, status, persistent_login FROM authorized_accounts WHERE username = $1 AND status = 'active'",
            username)
        if not row:
            return None
        return {'id': row['id'], 'expire_time': row['expire_time'], 'status': row['status'],
                'persistent_login': row.get('persistent_login', False)}


async def add_authorized_account(username: str, password: str, added_by: str,
                                  plan_type: str, credits_cost: int,
                                  duration_days: int, remark: str = '',
                                  nickname: str = '') -> Dict:
    """添加授权账号"""
    pool = _get_pool()
    now = datetime.now()
    expire_time = now + timedelta(days=duration_days)
    async with pool.acquire() as conn:
        row = await conn.fetchrow('''
            INSERT INTO authorized_accounts
                (username, password, added_by, plan_type, credits_cost, start_time, expire_time, status, remark, nickname)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9)
            ON CONFLICT(username) DO UPDATE SET
                password=$2, added_by=$3, plan_type=$4, credits_cost=$5,
                start_time=$6, expire_time=$7, status='active', remark=$8, nickname=$9, updated_at=NOW()
            RETURNING id, expire_time
        ''', username, password, added_by, plan_type, credits_cost, now, expire_time, remark, nickname)
        return {'id': row['id'], 'expire_time': str(row['expire_time']), 'username': username}


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


async def toggle_persistent_login(username: str, enabled: bool) -> bool:
    """切换账号的强化登录开关"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "UPDATE authorized_accounts SET persistent_login=$1, updated_at=NOW() WHERE username=$2 AND status='active'",
            enabled, username)
        return int(result.split()[-1]) > 0


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
            conditions.append(f"username ILIKE ${idx}")
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
        return {'total': total or 0, 'rows': [dict(r) for r in rows]}


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
        return [dict(r) for r in rows]


async def expire_overdue_accounts() -> int:
    """将已过期的active账号标记为expired"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "UPDATE authorized_accounts SET status='expired', updated_at=NOW() WHERE status='active' AND expire_time < NOW()")
        return int(result.split()[-1])


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
