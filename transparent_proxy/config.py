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
DB_MIN_POOL = 5   # 最小连接数
DB_MAX_POOL = 20  # 最大连接数
