# -*- coding: utf-8 -*-
"""
数据库模型和操作
"""

import sqlite3
import os
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
                login_count INTEGER DEFAULT 0,
                first_login TIMESTAMP,
                last_login TIMESTAMP,
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
        
        # 创建索引
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_login_username ON login_records(username)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_login_ip ON login_records(ip_address)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_login_time ON login_records(login_time)')
        
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

def record_login(username: str, ip_address: str, user_agent: str = None, 
                 request_path: str = None, status_code: int = None, extra_data: str = None):
    """记录登录"""
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 插入登录记录
        cursor.execute('''
            INSERT INTO login_records (username, ip_address, user_agent, login_time, request_path, status_code, extra_data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (username, ip_address, user_agent, now, request_path, status_code, extra_data))
        
        # 更新用户统计
        cursor.execute('''
            INSERT INTO user_stats (username, login_count, first_login, last_login)
            VALUES (?, 1, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
                login_count = login_count + 1,
                last_login = ?
        ''', (username, now, now, now))
        
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
            SELECT username, login_count, first_login, last_login, is_banned
            FROM user_stats
            ORDER BY last_login DESC
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
    """获取用户详情"""
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 基本信息
        cursor.execute('SELECT * FROM user_stats WHERE username = ?', (username,))
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

def ban_user(username: str, reason: str = None):
    """封禁用户"""
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        cursor = conn.cursor()
        
        # 更新用户状态
        cursor.execute('''
            UPDATE user_stats SET is_banned = 1, banned_at = ?, banned_reason = ?
            WHERE username = ?
        ''', (now, reason, username))
        
        # 添加到封禁列表
        cursor.execute('''
            INSERT OR REPLACE INTO ban_list (ban_type, ban_value, banned_at, banned_reason, is_active)
            VALUES ('username', ?, ?, ?, 1)
        ''', (username, now, reason))
        
        conn.commit()

def unban_user(username: str):
    """解封用户"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('UPDATE user_stats SET is_banned = 0, banned_at = NULL, banned_reason = NULL WHERE username = ?', (username,))
        cursor.execute('UPDATE ban_list SET is_active = 0 WHERE ban_type = "username" AND ban_value = ?', (username,))
        conn.commit()

def ban_ip(ip_address: str, reason: str = None):
    """封禁IP"""
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
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
        
        # 总资产统计
        cursor.execute('SELECT SUM(ace_count) as total, SUM(ep) as total_ep FROM user_assets')
        row = cursor.fetchone()
        total_ace = row['total'] or 0
        total_ep = row['total_ep'] or 0
        
        return {
            'total_users': total_users,
            'total_ips': total_ips,
            'today_logins': today_logins,
            'banned_count': banned_count,
            'total_logins': total_logins,
            'total_ace': total_ace,
            'total_ep': total_ep
        }

def save_user_assets(username: str, data: dict):
    """保存用户资产信息"""
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    
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
            data.get('ACECount', 0), data.get('TotalACE', 0), data.get('WeeklyMoney', 0),
            data.get('SP', 0), data.get('TP', 0), data.get('EP', 0),
            data.get('RP', 0), data.get('AP', 0), data.get('LP', 0),
            data.get('Rate', 0), data.get('Credit', 0),
            data.get('HonorName', ''), data.get('LevelNumber', 0),
            data.get('Convertbalance', 0), now,
            # ON CONFLICT 更新的值
            data.get('ACECount', 0), data.get('TotalACE', 0), data.get('WeeklyMoney', 0),
            data.get('SP', 0), data.get('TP', 0), data.get('EP', 0),
            data.get('RP', 0), data.get('AP', 0), data.get('LP', 0),
            data.get('Rate', 0), data.get('Credit', 0),
            data.get('HonorName', ''), data.get('LevelNumber', 0),
            data.get('Convertbalance', 0), now
        ))
        
        # 记录历史
        cursor.execute('''
            INSERT INTO asset_history (
                username, ace_count, total_ace, ep, rate, honor_name, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ''', (
            username,
            data.get('ACECount', 0), data.get('TotalACE', 0),
            data.get('EP', 0), data.get('Rate', 0),
            data.get('HonorName', ''), now
        ))
        
        conn.commit()

def get_user_assets(username: str):
    """获取用户资产信息"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM user_assets WHERE username = ?', (username,))
        row = cursor.fetchone()
        return dict(row) if row else None

def get_all_user_assets(limit: int = 100, offset: int = 0):
    """获取所有用户资产列表"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute('''
            SELECT ua.*, us.login_count, us.last_login, us.is_banned
            FROM user_assets ua
            LEFT JOIN user_stats us ON ua.username = us.username
            ORDER BY ua.ace_count DESC
            LIMIT ? OFFSET ?
        ''', (limit, offset))
        return [dict(row) for row in cursor.fetchall()]

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

# 初始化数据库
if __name__ == '__main__':
    init_db()
    print(f"数据库已初始化: {DB_PATH}")
