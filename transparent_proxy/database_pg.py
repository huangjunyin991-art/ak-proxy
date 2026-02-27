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
