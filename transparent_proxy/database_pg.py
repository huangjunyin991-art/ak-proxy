# -*- coding: utf-8 -*-
"""
PostgreSQL 数据库模块 (asyncpg)
参考 monitor/database.py 结构，使用 asyncpg 实现高并发异步读写
"""

import asyncpg
import json
import logging
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any

logger = logging.getLogger("TransparentProxy.DB")

# 全局连接池
_pool: Optional[asyncpg.Pool] = None


async def init_db(host: str = "127.0.0.1", port: int = 5432,
                  database: str = "ak_proxy", user: str = "ak_proxy",
                  password: str = "ak2026db",
                  min_size: int = 5, max_size: int = 20):
    """初始化数据库连接池并创建表"""
    global _pool
    _pool = await asyncpg.create_pool(
        host=host, port=port, database=database,
        user=user, password=password,
        min_size=min_size, max_size=max_size,
        command_timeout=30
    )
    logger.info(f"PostgreSQL 连接池已创建 (pool={min_size}-{max_size})")

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
                updated_at TIMESTAMP DEFAULT NOW()
            )
        ''')

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

        # 创建索引
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_username ON login_records(username)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_ip ON login_records(ip_address)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_time ON login_records(login_time)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_asset_history_user ON asset_history(username)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_asset_history_time ON asset_history(recorded_at)')
        await conn.execute('CREATE INDEX IF NOT EXISTS idx_ban_active ON ban_list(is_active)')

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
    """记录登录信息"""
    pool = _get_pool()
    now = datetime.now().replace(microsecond=0)
    username = username.lower() if username else username

    async with pool.acquire() as conn:
        async with conn.transaction():
            # 插入登录记录
            await conn.execute('''
                INSERT INTO login_records (username, ip_address, user_agent, login_time, request_path, status_code, extra_data)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            ''', username, ip_address, user_agent, now, request_path, status_code, extra_data)

            # 更新用户统计
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

            # 更新IP统计
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
            SELECT username, password, login_count, first_login, last_login, is_banned
            FROM user_stats ORDER BY last_login DESC LIMIT $1 OFFSET $2
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

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute('''
                INSERT INTO user_assets (username, ace_count, total_ace, weekly_money,
                    sp, tp, ep, rp, ap, lp, rate, credit, honor_name, level_number,
                    convert_balance, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
                ON CONFLICT(username) DO UPDATE SET
                    ace_count=$2, total_ace=$3, weekly_money=$4,
                    sp=$5, tp=$6, ep=$7, rp=$8, ap=$9, lp=$10,
                    rate=$11, credit=$12, honor_name=$13, level_number=$14,
                    convert_balance=$15, updated_at=$16
            ''', username, ace_count, total_ace, weekly_money,
                 sp, tp, ep, rp, ap, lp, rate, credit, honor_name,
                 level_number, convert_balance, now)

            # 记录资产历史
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
                              search: str = None) -> List[Dict]:
    """获取所有用户资产"""
    pool = _get_pool()
    async with pool.acquire() as conn:
        if search:
            rows = await conn.fetch('''
                SELECT * FROM user_assets WHERE username ILIKE $1
                ORDER BY updated_at DESC LIMIT $2 OFFSET $3
            ''', f'%{search}%', limit, offset)
        else:
            rows = await conn.fetch('''
                SELECT * FROM user_assets ORDER BY updated_at DESC LIMIT $1 OFFSET $2
            ''', limit, offset)
        return [dict(r) for r in rows]


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

async def cleanup_old_records(days: int = 90):
    """清理超过N天的登录记录和资产历史"""
    pool = _get_pool()
    cutoff = datetime.now() - timedelta(days=days)
    async with pool.acquire() as conn:
        deleted_logins = await conn.execute(
            'DELETE FROM login_records WHERE login_time < $1', cutoff
        )
        deleted_history = await conn.execute(
            'DELETE FROM asset_history WHERE recorded_at < $1', cutoff
        )
        logger.info(f"清理完成: 登录记录 {deleted_logins}, 资产历史 {deleted_history}")
