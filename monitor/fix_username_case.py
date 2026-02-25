# -*- coding: utf-8 -*-
"""
修复用户名大小写问题并去重
"""

import sqlite3
import os
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), 'monitor.db')

def backup_database():
    """备份数据库"""
    backup_path = DB_PATH + f'.backup_{datetime.now().strftime("%Y%m%d_%H%M%S")}'
    import shutil
    shutil.copy2(DB_PATH, backup_path)
    print(f"✅ 数据库已备份到: {backup_path}")
    return backup_path

def analyze_duplicates():
    """分析重复的用户名"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # 查找大小写不同但实际相同的用户名
    cursor.execute('''
        SELECT LOWER(username) as username_lower, GROUP_CONCAT(username, ', ') as variants, COUNT(*) as count
        FROM user_stats
        GROUP BY LOWER(username)
        HAVING COUNT(*) > 1
        ORDER BY count DESC
    ''')
    
    duplicates = cursor.fetchall()
    conn.close()
    
    return duplicates

def merge_duplicate_users(conn, username_lower, variants):
    """合并重复的用户记录"""
    cursor = conn.cursor()
    variant_list = [v.strip() for v in variants.split(',')]
    
    print(f"\n  📝 合并用户: {variants}")
    
    # 1. 合并所有变体的数据
    cursor.execute('''
        SELECT 
            SUM(login_count) as total_logins,
            MIN(first_login) as earliest_login,
            MAX(last_login) as latest_login,
            password,
            last_ip
        FROM user_stats
        WHERE LOWER(username) IN ({})
    '''.format(','.join('?' * len(variant_list))), variant_list)
    
    merged_stats = cursor.fetchone()
    if not merged_stats:
        return
    
    print(f"    → 合并为: {username_lower}")
    print(f"    → 总登录次数: {merged_stats[0]}")
    
    # 2. 检查小写版本是否已存在
    cursor.execute('SELECT username FROM user_stats WHERE username = ?', (username_lower,))
    lowercase_exists = cursor.fetchone()
    
    if lowercase_exists:
        # 小写版本已存在，更新它的数据
        cursor.execute('''
            UPDATE user_stats
            SET 
                login_count = ?,
                first_login = ?,
                last_login = ?,
                password = COALESCE(password, ?),
                last_ip = COALESCE(?, last_ip)
            WHERE username = ?
        ''', (
            merged_stats[0],  # total_logins
            merged_stats[1],  # earliest_login
            merged_stats[2],  # latest_login
            merged_stats[3],  # password
            merged_stats[4],  # last_ip
            username_lower
        ))
        
        # 删除其他大小写变体
        other_variants = [v for v in variant_list if v != username_lower]
        if other_variants:
            cursor.execute('''
                DELETE FROM user_stats
                WHERE username IN ({})
            '''.format(','.join('?' * len(other_variants))), other_variants)
            print(f"    ✅ 已删除重复: {', '.join(other_variants)}")
    else:
        # 小写版本不存在，选择一个变体重命名
        cursor.execute('''
            SELECT username FROM user_stats
            WHERE LOWER(username) IN ({})
            ORDER BY login_count DESC, first_login ASC
            LIMIT 1
        '''.format(','.join('?' * len(variant_list))), variant_list)
        
        primary = cursor.fetchone()
        primary_username = primary[0] if primary else variant_list[0]
        
        # 更新选中的变体为小写
        cursor.execute('''
            UPDATE user_stats
            SET 
                username = ?,
                login_count = ?,
                first_login = ?,
                last_login = ?
            WHERE username = ?
        ''', (
            username_lower,
            merged_stats[0],
            merged_stats[1],
            merged_stats[2],
            primary_username
        ))
        
        # 删除其他变体
        other_variants = [v for v in variant_list if v != primary_username]
        if other_variants:
            cursor.execute('''
                DELETE FROM user_stats
                WHERE username IN ({})
            '''.format(','.join('?' * len(other_variants))), other_variants)
            print(f"    ✅ 已删除重复: {', '.join(other_variants)}")
    
    # 5. 更新 login_records 中的用户名为小写
    cursor.execute('''
        UPDATE login_records
        SET username = ?
        WHERE LOWER(username) IN ({})
    '''.format(','.join('?' * len(variant_list))), [username_lower] + variant_list)
    
    # 6. 更新 user_assets 中的用户名
    cursor.execute('''
        SELECT username FROM user_assets WHERE LOWER(username) IN ({})
    '''.format(','.join('?' * len(variant_list))), variant_list)
    
    asset_variants = [row[0] for row in cursor.fetchall()]
    if asset_variants:
        # 合并资产（取最大值）
        cursor.execute('''
            SELECT 
                MAX(ace_count) as ace_count,
                MAX(total_ace) as total_ace,
                MAX(weekly_money) as weekly_money,
                MAX(sp) as sp,
                MAX(tp) as tp,
                MAX(ep) as ep,
                MAX(rp) as rp,
                MAX(ap) as ap,
                MAX(lp) as lp,
                MAX(rate) as rate,
                MAX(credit) as credit,
                MAX(level_number) as level_number,
                MAX(convert_balance) as convert_balance
            FROM user_assets
            WHERE LOWER(username) IN ({})
        '''.format(','.join('?' * len(variant_list))), variant_list)
        
        merged_assets = cursor.fetchone()
        
        # 更新或插入主用户资产
        cursor.execute('''
            INSERT OR REPLACE INTO user_assets (
                username, ace_count, total_ace, weekly_money, sp, tp, ep, rp, ap, lp,
                rate, credit, level_number, convert_balance, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (username_lower,) + tuple(merged_assets) + (datetime.now(),))
        
        # 删除其他变体的资产
        cursor.execute('''
            DELETE FROM user_assets
            WHERE LOWER(username) = ? AND username != ?
        ''', (username_lower, username_lower))
    
    # 7. 更新 ban_list 中的用户名
    cursor.execute('''
        UPDATE ban_list
        SET ban_value = ?
        WHERE ban_type = 'username' AND LOWER(ban_value) IN ({})
    '''.format(','.join('?' * len(variant_list))), [username_lower] + variant_list)

def recreate_tables_with_nocase():
    """重建表，添加 COLLATE NOCASE"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    print("\n🔧 重建表结构（添加大小写不敏感）...")
    
    # 备份现有数据
    cursor.execute('SELECT * FROM user_stats')
    user_stats_backup = cursor.fetchall()
    
    cursor.execute('SELECT * FROM user_assets')
    user_assets_backup = cursor.fetchall()
    
    # 删除旧表
    cursor.execute('DROP TABLE IF EXISTS user_stats_old')
    cursor.execute('ALTER TABLE user_stats RENAME TO user_stats_old')
    
    cursor.execute('DROP TABLE IF EXISTS user_assets_old')
    cursor.execute('ALTER TABLE user_assets RENAME TO user_assets_old')
    
    # 创建新表（带 COLLATE NOCASE）
    cursor.execute('''
        CREATE TABLE user_stats (
            username TEXT PRIMARY KEY COLLATE NOCASE,
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
    
    cursor.execute('''
        CREATE TABLE user_assets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL COLLATE NOCASE,
            ace_count REAL DEFAULT 0,
            total_ace REAL DEFAULT 0,
            weekly_money REAL DEFAULT 0,
            sp REAL DEFAULT 0,
            tp REAL DEFAULT 0,
            ep REAL DEFAULT 0,
            rp REAL DEFAULT 0,
            ap REAL DEFAULT 0,
            lp REAL DEFAULT 0,
            rate REAL DEFAULT 0,
            credit INTEGER DEFAULT 0,
            honor_name TEXT,
            level_number INTEGER DEFAULT 0,
            convert_balance REAL DEFAULT 0,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(username)
        )
    ''')
    
    # 迁移数据（转换为小写）
    cursor.execute('''
        INSERT INTO user_stats
        SELECT LOWER(username), password, login_count, first_login, last_login, 
               last_ip, is_banned, banned_at, banned_reason
        FROM user_stats_old
    ''')
    
    cursor.execute('''
        INSERT OR IGNORE INTO user_assets
        SELECT id, LOWER(username), ace_count, total_ace, weekly_money, sp, tp, ep, rp, ap, lp,
               rate, credit, honor_name, level_number, convert_balance, updated_at
        FROM user_assets_old
    ''')
    
    # 删除旧表
    cursor.execute('DROP TABLE user_stats_old')
    cursor.execute('DROP TABLE user_assets_old')
    
    # 更新其他表中的用户名
    cursor.execute('UPDATE login_records SET username = LOWER(username)')
    cursor.execute("UPDATE ban_list SET ban_value = LOWER(ban_value) WHERE ban_type = 'username'")
    
    # 创建索引
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_user_stats_username ON user_stats(username)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_user_assets_username ON user_assets(username)')
    
    conn.commit()
    conn.close()
    
    print("✅ 表结构已更新")

def main():
    print("=" * 60)
    print("修复用户名大小写问题")
    print("=" * 60)
    
    # 1. 备份数据库
    backup_path = backup_database()
    
    # 2. 分析重复数据
    print("\n📊 分析重复用户...")
    duplicates = analyze_duplicates()
    
    if not duplicates:
        print("✅ 未发现大小写不同的重复用户")
    else:
        print(f"\n⚠️  发现 {len(duplicates)} 组重复用户:\n")
        for dup in duplicates:
            print(f"  • {dup['variants']} (共 {dup['count']} 个变体)")
        
        # 3. 合并重复用户
        print("\n🔄 开始合并重复用户...")
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        
        for dup in duplicates:
            merge_duplicate_users(conn, dup['username_lower'], dup['variants'])
        
        conn.commit()
        conn.close()
        print("\n✅ 重复用户已合并")
    
    # 4. 重建表结构（添加 COLLATE NOCASE）
    recreate_tables_with_nocase()
    
    # 5. 验证结果
    print("\n🔍 验证修复结果...")
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute('SELECT COUNT(*) FROM user_stats')
    user_count = cursor.fetchone()[0]
    
    cursor.execute('SELECT COUNT(*) FROM login_records')
    login_count = cursor.fetchone()[0]
    
    cursor.execute('''
        SELECT LOWER(username), COUNT(*) as cnt
        FROM user_stats
        GROUP BY LOWER(username)
        HAVING cnt > 1
    ''')
    remaining_dups = cursor.fetchall()
    
    conn.close()
    
    print(f"  • 用户总数: {user_count}")
    print(f"  • 登录记录总数: {login_count}")
    print(f"  • 剩余重复: {len(remaining_dups)} 组")
    
    if len(remaining_dups) == 0:
        print("\n✅ 修复完成！数据库已支持大小写不敏感的用户名")
        print(f"   备份文件: {backup_path}")
    else:
        print("\n⚠️  仍有重复数据，请检查")

if __name__ == '__main__':
    main()
