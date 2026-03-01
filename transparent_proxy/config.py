# -*- coding: utf-8 -*-
"""
透明代理 - 配置文件
"""

# ===== 代理服务器设置 =====
PROXY_HOST = "0.0.0.0"
PROXY_PORT = 8080

# ===== 上游API =====
AKAPI_URL = "https://www.akapi1.com/RPC/"

# ===== 中央监控服务器（可选，留空则不上报） =====
# 填写你的监控服务器地址，透明代理会将登录/资产数据上报
MONITOR_SERVER = ""  # 例如: "http://ak2025.vip:8000"
MONITOR_API_KEY = ""  # 上报认证密钥（预留）

# ===== 本地日志 =====
LOG_FILE = "proxy.log"
LOG_LEVEL = "INFO"  # DEBUG / INFO / WARNING / ERROR
LOG_TO_CONSOLE = True
LOG_TO_FILE = True

# ===== 请求超时 =====
REQUEST_TIMEOUT = 30  # 秒

# ===== 封禁功能（本地） =====
ENABLE_LOCAL_BAN = True  # 是否启用本地封禁检查

# ===== PostgreSQL 数据库 =====
DB_HOST = "127.0.0.1"
DB_PORT = 5432
DB_NAME = "ak_proxy"
DB_USER = "ak_proxy"
DB_PASSWORD = "ak2026db"  # 部署时修改
DB_MIN_POOL = 10   # 最小连接数
DB_MAX_POOL = 30   # 最大连接数（4核8G服务器最估值，PG默认max_connections=100）

# ===== 出口IP设置（sing-box SOCKS5隧道） =====
# 每个出口对应sing-box的一个本地SOCKS5端口
# 直连（服务器本机IP）自动包含，无需配置
SOCKS5_EXITS = [
    # {"name": "出口_01",   "port": 10001},
    # {"name": "出口_pro",  "port": 10002},
    # {"name": "新加坡_01", "port": 10003},
    # ... 请根据sing-box配置删除注释
]
LOGIN_RATE_PER_EXIT = 10  # 每个出口IP每分钟最多登录次数
