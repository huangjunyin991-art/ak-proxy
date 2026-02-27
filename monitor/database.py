# -*- coding: utf-8 -*-
"""
数据库模型和操作
"""

import sqlite3
import os
import json
from datetime import datetime
from contextlib import contextmanager

DB_PATH = os.path.join(os.path.dirname(__file__), 'monitor.db')

def init_db():
    """初始化数据库"""
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 用户登录记录表
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS login_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                ip_address TEXT NOT NULL,
                user_agent TEXT,
                login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                request_path TEXT,
                status_code INTEGER,
                extra_data TEXT
            )
        ''')
        
        # 用户统计表
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS user_stats (
                username TEXT PRIMARY KEY,
                password TEXT,
                login_count INTEGER DEFAULT 0,
                first_login TIMESTAMP,
                last_login TIMESTAMP,
                last_ip TEXT,
                is_banned INTEGER DEFAULT 0,
                banned_at TIMESTAMP,
                banned_reason TEXT
            )
        ''')
        
        # IP统计表
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS ip_stats (
                ip_address TEXT PRIMARY KEY,
                request_count INTEGER DEFAULT 0,
                first_seen TIMESTAMP,
                last_seen TIMESTAMP,
                is_banned INTEGER DEFAULT 0,
                banned_at TIMESTAMP,
                banned_reason TEXT
            )
        ''')
        
        # 封禁列表
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS ban_list (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ban_type TEXT NOT NULL,  -- 'ip' or 'username'
                ban_value TEXT NOT NULL,
                banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                banned_reason TEXT,
                banned_until TIMESTAMP,  -- NULL = 永久
                is_active INTEGER DEFAULT 1,
                UNIQUE(ban_type, ban_value)
            )
        ''')
        
        # 用户资产信息表
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS user_assets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                ace_count REAL DEFAULT 0,        -- 主账户AK数量
                total_ace REAL DEFAULT 0,        -- 子账户AK数量
                weekly_money REAL DEFAULT 0,     -- 本周收益
                sp REAL DEFAULT 0,               -- SP点数
                tp REAL DEFAULT 0,               -- TP点数
                ep REAL DEFAULT 0,               -- EP点数
                rp REAL DEFAULT 0,               -- RP点数
                ap REAL DEFAULT 0,               -- AP点数
                lp REAL DEFAULT 0,               -- LP点数
                rate REAL DEFAULT 0,             -- 收益指数
                credit INTEGER DEFAULT 0,        -- 信用分
                honor_name TEXT,                 -- 等级名称
                level_number INTEGER DEFAULT 0,  -- 等级数字
                convert_balance REAL DEFAULT 0,  -- 可转换余额
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(username)
            )
        ''')
        
        # 资产历史记录表（用于追踪变化）
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS asset_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                ace_count REAL,
                total_ace REAL,
                ep REAL,
                rate REAL,
                honor_name TEXT,
                recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # 管理员Token持久化表
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS admin_tokens (
                token TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                expire REAL NOT NULL,
                sub_name TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # 激活码操作记录表
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS license_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action TEXT NOT NULL,
                license_key TEXT,
                product_id TEXT,
                billing_mode TEXT,
                detail TEXT,
                operator TEXT DEFAULT 'admin',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # 子管理员表
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS sub_admins (
                name TEXT PRIMARY KEY,
                password TEXT NOT NULL,
                permissions TEXT DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # 自动迁移：为旧表添加 permissions 字段
        try:
            cursor.execute('ALTER TABLE sub_admins ADD COLUMN permissions TEXT DEFAULT "{}"')
        except:
            pass  # 字段已存在
        
        # 创建索引
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_login_username ON login_records(username)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_login_ip ON login_records(ip_address)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_login_time ON login_records(login_time)')
        
        # 数据库迁移 - 添加新字段（如果不存在）
        try:
            cursor.execute('ALTER TABLE user_stats ADD COLUMN password TEXT')
        except:
            pass  # 字段已存在
        
        try:
            cursor.execute('ALTER TABLE user_stats ADD COLUMN last_ip TEXT')
        except:
            pass  # 字段已存在
        
        conn.commit()

@contextmanager
def get_db():
    """获取数据库连接"""
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def record_login(username: str, ip_address: str, user_agent: str = "", 
                 request_path: str = "", status_code: int = 200,
                 is_success: bool = True, password: str = "", extra_data: str = ""):
    """记录登录信息"""
    now = datetime.now().replace(microsecond=0)
    # 统一转换为小写，支持大小写不敏感
    username = username.lower() if username else username
    
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 插入登录记录
        cursor.execute('''
            INSERT INTO login_records (username, ip_address, user_agent, login_time, request_path, status_code, extra_data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (username, ip_address, user_agent, now, request_path, status_code, extra_data))
        
        # 更新用户统计（只有登录成功才更新密码）
        if is_success and password:
            cursor.execute('''
                INSERT INTO user_stats (username, password, login_count, first_login, last_login, last_ip)
                VALUES (?, ?, 1, ?, ?, ?)
                ON CONFLICT(username) DO UPDATE SET
                    password = ?,
                    login_count = login_count + 1,
                    last_login = ?,
                    last_ip = ?
            ''', (username, password, now, now, ip_address, password, now, ip_address))
        else:
            cursor.execute('''
                INSERT INTO user_stats (username, login_count, first_login, last_login, last_ip)
                VALUES (?, 1, ?, ?, ?)
                ON CONFLICT(username) DO UPDATE SET
                    login_count = login_count + 1,
                    last_login = ?,
                    last_ip = ?
            ''', (username, now, now, ip_address, now, ip_address))
        
        # 更新IP统计
        cursor.execute('''
            INSERT INTO ip_stats (ip_address, request_count, first_seen, last_seen)
            VALUES (?, 1, ?, ?)
            ON CONFLICT(ip_address) DO UPDATE SET
                request_count = request_count + 1,
                last_seen = ?
        ''', (ip_address, now, now, now))
        
        conn.commit()

def get_all_users(limit: int = 100, offset: int = 0):
    """获取所有用户统计"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT username, password, login_count, first_login, last_login, is_banned
            FROM user_stats
            ORDER BY last_login DESC
            LIMIT ? OFFSET ?
        ''', (limit, offset))
        return [dict(row) for row in cursor.fetchall()]

def get_all_users_with_assets(limit: int = 100, offset: int = 0):
    """获取所有用户统计（包含资产信息）"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT 
                us.username, us.password, us.login_count, us.first_login, us.last_login, 
                us.last_ip, us.is_banned,
                COALESCE(ua.ace_count, 0) as ace_count,
                COALESCE(ua.total_ace, 0) as total_ace,
                COALESCE(ua.ep, 0) as ep,
                COALESCE(ua.sp, 0) as sp,
                COALESCE(ua.rp, 0) as rp,
                COALESCE(ua.tp, 0) as tp,
                COALESCE(ua.ap, 0) as ap,
                COALESCE(ua.lp, 0) as lp,
                COALESCE(ua.weekly_money, 0) as weekly_money,
                COALESCE(ua.rate, 0) as rate,
                COALESCE(ua.credit, 0) as credit,
                ua.honor_name,
                COALESCE(ua.level_number, 0) as level_number,
                ua.updated_at as asset_updated_at
            FROM user_stats us
            LEFT JOIN user_assets ua ON us.username = ua.username
            ORDER BY us.last_login DESC
            LIMIT ? OFFSET ?
        ''', (limit, offset))
        return [dict(row) for row in cursor.fetchall()]

def get_all_ips(limit: int = 100, offset: int = 0):
    """获取所有IP统计"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT ip_address, request_count, first_seen, last_seen, is_banned
            FROM ip_stats
            ORDER BY last_seen DESC
            LIMIT ? OFFSET ?
        ''', (limit, offset))
        return [dict(row) for row in cursor.fetchall()]

def get_recent_logins(limit: int = 50):
    """获取最近登录记录"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT id, username, ip_address, user_agent, login_time, request_path, status_code
            FROM login_records
            ORDER BY login_time DESC
            LIMIT ?
        ''', (limit,))
        return [dict(row) for row in cursor.fetchall()]

def get_user_detail(username: str):
    """获取用户详细信息"""
    # 统一转换为小写
    username = username.lower() if username else username
    
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 获取用户基本信息
        cursor.execute('''
            SELECT us.username, us.password, us.login_count, us.first_login, us.last_login, 
                   us.last_ip, us.is_banned,
                   COALESCE(ua.ace_count, 0) as ace_count,
                   COALESCE(ua.total_ace, 0) as total_ace,
                   COALESCE(ua.weekly_money, 0) as weekly_money,
                   COALESCE(ua.sp, 0) as sp,
                   COALESCE(ua.tp, 0) as tp,
                   COALESCE(ua.ep, 0) as ep,
                   COALESCE(ua.rp, 0) as rp,
                   COALESCE(ua.ap, 0) as ap,
                   COALESCE(ua.lp, 0) as lp,
                   COALESCE(ua.rate, 0) as rate,
                   COALESCE(ua.credit, 0) as credit,
                   COALESCE(ua.honor_name, '') as honor_name,
                   COALESCE(ua.level_number, 0) as level_number,
                   COALESCE(ua.convert_balance, 0) as convert_balance
            FROM user_stats us
            LEFT JOIN user_assets ua ON us.username = ua.username
            WHERE us.username = ?
        ''', (username,))
        user = cursor.fetchone()
        if not user:
            return None
        
        user_dict = dict(user)
        
        # 最近登录记录
        cursor.execute('''
            SELECT * FROM login_records 
            WHERE username = ? 
            ORDER BY login_time DESC LIMIT 20
        ''', (username,))
        user_dict['recent_logins'] = [dict(row) for row in cursor.fetchall()]
        
        return user_dict

def ban_user(username: str, reason: str = "", duration_days: int = None):
    """封禁用户"""
    now = datetime.now().replace(microsecond=0)
    # 统一转换为小写
    username = username.lower() if username else username
    
    banned_until = None
    if duration_days:
        from datetime import timedelta
        banned_until = now + timedelta(days=duration_days)
    
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 更新用户状态
        cursor.execute('''
            UPDATE user_stats SET is_banned = 1, banned_at = ?, banned_reason = ?
            WHERE username = ?
        ''', (now, reason, username))
        
        # 添加到封禁列表
        cursor.execute('''
            INSERT OR REPLACE INTO ban_list (ban_type, ban_value, banned_at, banned_reason, banned_until, is_active)
            VALUES ('username', ?, ?, ?, ?, 1)
        ''', (username, now, reason, banned_until))
        
        conn.commit()

def unban_user(username: str):
    """解封用户"""
    # 统一转换为小写
    username = username.lower() if username else username
    
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('UPDATE user_stats SET is_banned = 0, banned_at = NULL, banned_reason = NULL WHERE username = ?', (username,))
        cursor.execute('UPDATE ban_list SET is_active = 0 WHERE ban_type = "username" AND ban_value = ?', (username,))
        conn.commit()

def ban_ip(ip_address: str, reason: str = None):
    """封禁IP"""
    now = datetime.now().replace(microsecond=0)
    with get_db() as conn:
        cursor = conn.cursor()
        
        cursor.execute('''
            UPDATE ip_stats SET is_banned = 1, banned_at = ?, banned_reason = ?
            WHERE ip_address = ?
        ''', (now, reason, ip_address))
        
        cursor.execute('''
            INSERT OR REPLACE INTO ban_list (ban_type, ban_value, banned_at, banned_reason, is_active)
            VALUES ('ip', ?, ?, ?, 1)
        ''', (ip_address, now, reason))
        
        conn.commit()

def unban_ip(ip_address: str):
    """解封IP"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('UPDATE ip_stats SET is_banned = 0, banned_at = NULL, banned_reason = NULL WHERE ip_address = ?', (ip_address,))
        cursor.execute('UPDATE ban_list SET is_active = 0 WHERE ban_type = "ip" AND ban_value = ?', (ip_address,))
        conn.commit()

def is_banned(username: str = None, ip_address: str = None) -> bool:
    """检查是否被封禁"""
    with get_db() as conn:
        cursor = conn.cursor()
        
        if username:
            cursor.execute('SELECT is_banned FROM user_stats WHERE username = ?', (username,))
            row = cursor.fetchone()
            if row and row['is_banned']:
                return True
        
        if ip_address:
            cursor.execute('SELECT is_banned FROM ip_stats WHERE ip_address = ?', (ip_address,))
            row = cursor.fetchone()
            if row and row['is_banned']:
                return True
        
        return False

def get_ban_list():
    """获取封禁列表"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT * FROM ban_list WHERE is_active = 1 ORDER BY banned_at DESC
        ''')
        return [dict(row) for row in cursor.fetchall()]

def get_stats_summary():
    """获取统计摘要"""
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 总用户数
        cursor.execute('SELECT COUNT(*) as count FROM user_stats')
        total_users = cursor.fetchone()['count']
        
        # 总IP数
        cursor.execute('SELECT COUNT(*) as count FROM ip_stats')
        total_ips = cursor.fetchone()['count']
        
        # 今日登录数
        cursor.execute('''
            SELECT COUNT(*) as count FROM login_records 
            WHERE DATE(login_time) = DATE('now', 'localtime')
        ''')
        today_logins = cursor.fetchone()['count']
        
        # 封禁数
        cursor.execute('SELECT COUNT(*) as count FROM ban_list WHERE is_active = 1')
        banned_count = cursor.fetchone()['count']
        
        # 总登录次数
        cursor.execute('SELECT COUNT(*) as count FROM login_records')
        total_logins = cursor.fetchone()['count']
        
        # 总资产统计（总AK = 主账户AK + 子账户AK）
        cursor.execute('''
            SELECT 
                SUM(COALESCE(ace_count, 0) + COALESCE(total_ace, 0)) as total_ace, 
                SUM(ep) as total_ep,
                SUM(sp) as total_sp,
                SUM(rp) as total_rp,
                SUM(tp) as total_tp
            FROM user_assets
        ''')
        row = cursor.fetchone()
        total_ace = row['total_ace'] or 0
        total_ep = row['total_ep'] or 0
        total_sp = row['total_sp'] or 0
        total_rp = row['total_rp'] or 0
        total_tp = row['total_tp'] or 0
        
        return {
            'total_users': total_users,
            'total_ips': total_ips,
            'today_logins': today_logins,
            'banned_count': banned_count,
            'total_logins': total_logins,
            'total_ace': total_ace,
            'total_ep': total_ep,
            'total_sp': total_sp,
            'total_rp': total_rp,
            'total_tp': total_tp
        }

def update_user_assets(username: str, asset_data: dict):
    """更新用户资产信息"""
    now = datetime.now().replace(microsecond=0)
    # 统一转换为小写
    username = username.lower() if username else username
    
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 更新或插入资产信息
        cursor.execute('''
            INSERT INTO user_assets (
                username, ace_count, total_ace, weekly_money,
                sp, tp, ep, rp, ap, lp, rate, credit,
                honor_name, level_number, convert_balance, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
                ace_count = ?, total_ace = ?, weekly_money = ?,
                sp = ?, tp = ?, ep = ?, rp = ?, ap = ?, lp = ?,
                rate = ?, credit = ?, honor_name = ?, level_number = ?,
                convert_balance = ?, updated_at = ?
        ''', (
            username,
            asset_data.get('ACECount', 0), asset_data.get('TotalACE', 0), asset_data.get('WeeklyMoney', 0),
            asset_data.get('SP', 0), asset_data.get('TP', 0), asset_data.get('EP', 0),
            asset_data.get('RP', 0), asset_data.get('AP', 0), asset_data.get('LP', 0),
            asset_data.get('Rate', 0), asset_data.get('Credit', 0),
            asset_data.get('HonorName', ''), asset_data.get('LevelNumber', 0),
            asset_data.get('Convertbalance', 0), now,
            # ON CONFLICT 更新的值
            asset_data.get('ACECount', 0), asset_data.get('TotalACE', 0), asset_data.get('WeeklyMoney', 0),
            asset_data.get('SP', 0), asset_data.get('TP', 0), asset_data.get('EP', 0),
            asset_data.get('RP', 0), asset_data.get('AP', 0), asset_data.get('LP', 0),
            asset_data.get('Rate', 0), asset_data.get('Credit', 0),
            asset_data.get('HonorName', ''), asset_data.get('LevelNumber', 0),
            asset_data.get('Convertbalance', 0), now
        ))
        
        # 记录历史
        cursor.execute('''
            INSERT INTO asset_history (
                username, ace_count, total_ace, ep, rate, honor_name, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (
            username,
            asset_data.get('ACECount', 0), asset_data.get('TotalACE', 0),
            asset_data.get('EP', 0), asset_data.get('Rate', 0),
            asset_data.get('HonorName', ''), now
        ))
        
        # 删除30天前的旧记录
        cursor.execute('''
            DELETE FROM asset_history 
            WHERE recorded_at < datetime('now', '-30 days')
        ''')
        
        conn.commit()

def get_user_assets(username: str):
    """获取用户资产信息"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM user_assets WHERE username = ?', (username,))
        row = cursor.fetchone()
        return dict(row) if row else None

def get_all_user_assets(limit: int = 100, offset: int = 0, search: str = None):
    """获取所有用户资产列表（支持分页和搜索）"""
    with get_db() as conn:
        cursor = conn.cursor()
        
        if search:
            # 搜索模式
            search_param = f'%{search}%'
            cursor.execute('SELECT COUNT(*) as total FROM user_assets WHERE username LIKE ?', (search_param,))
            total = cursor.fetchone()['total']
            cursor.execute('''
                SELECT ua.*, us.login_count, us.last_login, us.is_banned
                FROM user_assets ua
                LEFT JOIN user_stats us ON ua.username = us.username
                WHERE ua.username LIKE ?
                ORDER BY ua.ace_count DESC
                LIMIT ? OFFSET ?
            ''', (search_param, limit, offset))
        else:
            # 普通分页模式
            cursor.execute('SELECT COUNT(*) as total FROM user_assets')
            total = cursor.fetchone()['total']
            cursor.execute('''
                SELECT ua.*, us.login_count, us.last_login, us.is_banned
                FROM user_assets ua
                LEFT JOIN user_stats us ON ua.username = us.username
                ORDER BY ua.ace_count DESC
                LIMIT ? OFFSET ?
            ''', (limit, offset))
        
        rows = [dict(row) for row in cursor.fetchall()]
        return {'rows': rows, 'total': total}

def get_asset_history(username: str, limit: int = 30):
    """获取用户资产历史"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT * FROM asset_history 
            WHERE username = ? 
            ORDER BY recorded_at DESC 
            LIMIT ?
        ''', (username, limit))
        return [dict(row) for row in cursor.fetchall()]

# ===== 通用数据库CRUD操作 =====

def get_all_tables():
    """获取所有表名"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        return [row['name'] for row in cursor.fetchall()]

def get_table_schema(table_name: str):
    """获取表结构"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(f"PRAGMA table_info({table_name})")
        columns = []
        for row in cursor.fetchall():
            columns.append({
                'cid': row['cid'],
                'name': row['name'],
                'type': row['type'],
                'notnull': row['notnull'],
                'dflt_value': row['dflt_value'],
                'pk': row['pk']
            })
        return columns

def query_table(table_name: str, limit: int = 100, offset: int = 0, order_by: str = None, order_desc: bool = True):
    """查询表数据"""
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 获取总数
        cursor.execute(f"SELECT COUNT(*) as count FROM {table_name}")
        total = cursor.fetchone()['count']
        
        # 查询数据
        sql = f"SELECT * FROM {table_name}"
        if order_by:
            sql += f" ORDER BY {order_by} {'DESC' if order_desc else 'ASC'}"
        sql += f" LIMIT {limit} OFFSET {offset}"
        
        cursor.execute(sql)
        rows = [dict(row) for row in cursor.fetchall()]
        
        return {'total': total, 'rows': rows}

def insert_row(table_name: str, data: dict):
    """插入数据"""
    with get_db() as conn:
        cursor = conn.cursor()
        columns = ', '.join(data.keys())
        placeholders = ', '.join(['?' for _ in data])
        sql = f"INSERT INTO {table_name} ({columns}) VALUES ({placeholders})"
        cursor.execute(sql, list(data.values()))
        conn.commit()
        return cursor.lastrowid

def update_row(table_name: str, pk_column: str, pk_value, data: dict):
    """更新数据"""
    with get_db() as conn:
        cursor = conn.cursor()
        set_clause = ', '.join([f"{k} = ?" for k in data.keys()])
        sql = f"UPDATE {table_name} SET {set_clause} WHERE {pk_column} = ?"
        cursor.execute(sql, list(data.values()) + [pk_value])
        conn.commit()
        return cursor.rowcount

def delete_row(table_name: str, pk_column: str, pk_value):
    """删除数据"""
    with get_db() as conn:
        cursor = conn.cursor()
        sql = f"DELETE FROM {table_name} WHERE {pk_column} = ?"
        cursor.execute(sql, [pk_value])
        conn.commit()
        return cursor.rowcount

def execute_sql(sql: str):
    """执行自定义SQL（只读查询）"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(sql)
        if sql.strip().upper().startswith('SELECT'):
            return [dict(row) for row in cursor.fetchall()]
        else:
            conn.commit()
            return {'affected_rows': cursor.rowcount}

def get_dashboard_data():
    """获取仪表盘数据"""
    with get_db() as conn:
        cursor = conn.cursor()
        today = datetime.now().strftime('%Y-%m-%d')
        
        # 今日请求数
        cursor.execute('''
            SELECT COUNT(*) as count FROM login_records 
            WHERE DATE(login_time) = ?
        ''', (today,))
        today_requests = cursor.fetchone()['count']
        
        # 成功率（基于status_code或extra_data中的状态）
        cursor.execute('''
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status_code = 200 OR extra_data LIKE '%"status": "success"%' OR extra_data LIKE '%success%' THEN 1 ELSE 0 END) as success
            FROM login_records 
            WHERE DATE(login_time) = ?
        ''', (today,))
        row = cursor.fetchone()
        total = row['total'] or 1
        success = row['success'] or 0
        success_rate = (success / total) * 100 if total > 0 else 0
        
        # 今日活跃用户数
        cursor.execute('''
            SELECT COUNT(DISTINCT username) as count FROM login_records 
            WHERE DATE(login_time) = ?
        ''', (today,))
        active_users = cursor.fetchone()['count']
        
        # 峰值RPM（找出任意一分钟内的最大请求数）
        cursor.execute('''
            SELECT COUNT(*) as count 
            FROM login_records 
            WHERE DATE(login_time) = ?
            GROUP BY strftime('%Y-%m-%d %H:%M', login_time)
            ORDER BY count DESC
            LIMIT 1
        ''', (today,))
        peak_row = cursor.fetchone()
        peak_rpm = peak_row['count'] if peak_row else 0
        
        # 24小时请求趋势
        cursor.execute('''
            SELECT CAST(strftime('%H', login_time) AS INTEGER) as hour, COUNT(*) as count 
            FROM login_records 
            WHERE DATE(login_time) = ?
            GROUP BY hour
            ORDER BY hour
        ''', (today,))
        hourly_data = [{'hour': row['hour'], 'count': row['count']} for row in cursor.fetchall()]
        
        # Top10 活跃用户
        cursor.execute('''
            SELECT username, COUNT(*) as count 
            FROM login_records 
            WHERE DATE(login_time) = ?
            GROUP BY username
            ORDER BY count DESC
            LIMIT 10
        ''', (today,))
        top_users = [{'username': row['username'], 'count': row['count']} for row in cursor.fetchall()]
        
        # Top10 访问IP
        cursor.execute('''
            SELECT ip_address as ip, COUNT(*) as count 
            FROM login_records 
            WHERE DATE(login_time) = ?
            GROUP BY ip_address
            ORDER BY count DESC
            LIMIT 10
        ''', (today,))
        top_ips = [{'ip': row['ip'], 'count': row['count']} for row in cursor.fetchall()]
        
        return {
            'today_requests': today_requests,
            'success_rate': success_rate,
            'active_users': active_users,
            'peak_rpm': peak_rpm,
            'hourly_data': hourly_data,
            'top_users': top_users,
            'top_ips': top_ips
        }

# ===== 管理员Token持久化操作 =====

def _ensure_sub_name_column():
    """确保admin_tokens表有sub_name列（兼容旧数据库）"""
    with get_db() as conn:
        cursor = conn.cursor()
        try:
            # 先检查表是否存在
            cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_tokens'")
            if not cursor.fetchone():
                return  # 表还不存在，init_db()会创建带sub_name的完整表
            cursor.execute("SELECT sub_name FROM admin_tokens LIMIT 1")
        except sqlite3.OperationalError:
            cursor.execute("ALTER TABLE admin_tokens ADD COLUMN sub_name TEXT DEFAULT ''")
            conn.commit()

_ensure_sub_name_column()

def save_admin_token(token: str, role: str, expire: float, sub_name: str = ''):
    """保存管理员Token到数据库"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            INSERT OR REPLACE INTO admin_tokens (token, role, expire, sub_name)
            VALUES (?, ?, ?, ?)
        ''', (token, role, expire, sub_name))
        conn.commit()

def get_admin_token(token: str):
    """从数据库获取Token信息，返回 {'role': ..., 'expire': ..., 'sub_name': ...} 或 None"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT token, role, expire, sub_name FROM admin_tokens WHERE token = ?', (token,))
        row = cursor.fetchone()
        if row:
            return {'role': row['role'], 'expire': row['expire'], 'sub_name': row['sub_name'] or ''}
        return None

def delete_admin_token(token: str):
    """删除指定Token"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('DELETE FROM admin_tokens WHERE token = ?', (token,))
        conn.commit()

def delete_admin_tokens_by_role(role: str):
    """删除指定角色的所有Token"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('DELETE FROM admin_tokens WHERE role = ?', (role,))
        conn.commit()
        return cursor.rowcount

def delete_admin_tokens_by_sub_name(sub_name: str):
    """删除指定子管理员名称的所有Token"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('DELETE FROM admin_tokens WHERE role = ? AND sub_name = ?', ('sub_admin', sub_name))
        conn.commit()
        return cursor.rowcount

def cleanup_expired_tokens():
    """清理过期Token"""
    import time
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('DELETE FROM admin_tokens WHERE expire < ?', (time.time(),))
        conn.commit()
        return cursor.rowcount

def load_all_admin_tokens():
    """加载所有未过期的Token，用于服务启动时恢复"""
    import time
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT token, role, expire, sub_name FROM admin_tokens WHERE expire > ?', (time.time(),))
        result = {}
        for row in cursor.fetchall():
            result[row['token']] = {'role': row['role'], 'expire': row['expire'], 'sub_name': row['sub_name'] or ''}
        return result

# ===== 激活码操作记录 =====

def add_license_log(action: str, license_key: str = None, product_id: str = None, 
                    billing_mode: str = None, detail: str = None, operator: str = 'admin'):
    """记录激活码操作日志"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO license_logs (action, license_key, product_id, billing_mode, detail, operator)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (action, license_key, product_id, billing_mode, detail, operator))
        conn.commit()

def get_license_logs(action: str = None, limit: int = 100, offset: int = 0):
    """获取激活码操作记录"""
    with get_db() as conn:
        cursor = conn.cursor()
        if action:
            cursor.execute('SELECT COUNT(*) as total FROM license_logs WHERE action = ?', (action,))
        else:
            cursor.execute('SELECT COUNT(*) as total FROM license_logs')
        total = cursor.fetchone()['total']
        
        if action:
            cursor.execute('''
                SELECT * FROM license_logs WHERE action = ?
                ORDER BY created_at DESC LIMIT ? OFFSET ?
            ''', (action, limit, offset))
        else:
            cursor.execute('''
                SELECT * FROM license_logs 
                ORDER BY created_at DESC LIMIT ? OFFSET ?
            ''', (limit, offset))
        
        rows = [dict(row) for row in cursor.fetchall()]
        return {'rows': rows, 'total': total}

# ===== 子管理员管理 =====

def db_get_all_sub_admins():
    """获取所有子管理员（含权限）"""
    with get_db() as conn:
        cursor = conn.cursor()
        try:
            cursor.execute('SELECT name, password, permissions, created_at FROM sub_admins ORDER BY created_at')
        except:
            cursor.execute('SELECT name, password, created_at FROM sub_admins ORDER BY created_at')
        result = {}
        for row in cursor.fetchall():
            perm_str = ''
            try:
                perm_str = row['permissions']
            except (IndexError, KeyError):
                pass
            result[row['name']] = {
                'password': row['password'],
                'permissions': json.loads(perm_str or '{}'),
                'created_at': row['created_at']
            }
        return result

def db_set_sub_admin(name: str, password: str, permissions: dict = None):
    """添加或更新子管理员（含权限）"""
    perm_json = json.dumps(permissions or {})
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO sub_admins (name, password, permissions) VALUES (?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET password = ?, permissions = ?
        ''', (name, password, perm_json, password, perm_json))
        conn.commit()

def db_delete_sub_admin(name: str):
    """删除子管理员"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('DELETE FROM sub_admins WHERE name = ?', (name,))
        conn.commit()
        return cursor.rowcount > 0

def db_get_sub_admin(name: str):
    """获取单个子管理员（含权限）"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT name, password, permissions, created_at FROM sub_admins WHERE name = ?', (name,))
        row = cursor.fetchone()
        if not row:
            return None
        result = dict(row)
        result['permissions'] = json.loads(result.get('permissions') or '{}')
        return result

def db_update_sub_admin_permissions(name: str, permissions: dict):
    """仅更新子管理员权限"""
    perm_json = json.dumps(permissions or {})
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('UPDATE sub_admins SET permissions = ? WHERE name = ?', (perm_json, name))
        conn.commit()
        return cursor.rowcount > 0

# 初始化数据库
if __name__ == '__main__':
    init_db()
    print(f"数据库已初始化: {DB_PATH}")
