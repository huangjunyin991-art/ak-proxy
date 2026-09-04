# -*- coding: utf-8 -*-
"""
透明代理 - 配置文件
"""

import os

# ===== 代理服务器设置 =====
# Backend is intentionally loopback-only; public traffic must enter through Nginx.
PROXY_HOST = "127.0.0.1"
PROXY_PORT = 8080

# ===== 上游API =====
AKAPI_URL = "https://www.akapi1.com/RPC/"

# ===== 中央监控服务器（可选，留空则不上报） =====
# 填写你的监控服务器地址，透明代理会将登录/资产数据上报
MONITOR_SERVER = os.environ.get("MONITOR_SERVER", "")
MONITOR_API_KEY = os.environ.get("MONITOR_API_KEY", "")

IM_LOCATION_AMAP_WEB_KEY = os.environ.get("IM_LOCATION_AMAP_WEB_KEY", "")
IM_LOCATION_AMAP_SECURITY_JS_CODE = os.environ.get("IM_LOCATION_AMAP_SECURITY_JS_CODE", "")

# ===== 本地日志 =====
LOG_FILE = "proxy.log"
LOG_LEVEL = "INFO"  # DEBUG / INFO / WARNING / ERROR
LOG_TO_CONSOLE = True
LOG_TO_FILE = True

# ===== 请求超时 =====
REQUEST_TIMEOUT = 20  # 普通 RPC 总超时（秒）
LOGIN_REQUEST_TIMEOUT = 20  # 登录 RPC 总超时（秒）
try:
    LOGIN_FASTPATH_VALIDATION_TIMEOUT = max(
        1.0,
        min(5.0, float(os.environ.get("LOGIN_FASTPATH_VALIDATION_TIMEOUT", "3"))),
    )
except (TypeError, ValueError):
    LOGIN_FASTPATH_VALIDATION_TIMEOUT = 3.0
RPC_CONNECT_TIMEOUT = 3  # RPC 建连超时（秒）
AK_SELL_READ_REQUEST_TIMEOUT = 20  # 自动挂卖读取接口的单出口超时（秒）
AK_SELL_WRITE_REQUEST_TIMEOUT = 20  # 自动挂卖提交接口的单出口超时（秒）

# 订阅组运行时健康度低于阈值时自动刷新订阅源
SUBSCRIPTION_REFRESH_INTERVAL_SECONDS = 60
SUBSCRIPTION_REFRESH_COOLDOWN_SECONDS = 300
SUBSCRIPTION_REFRESH_AVAILABILITY_THRESHOLD = 10.0
NOTICE_GUIDANCE_REQUEST_TIMEOUT = 20  # 指导销售内部查询超时（秒）
NOTICE_GUIDANCE_CONNECT_TIMEOUT = 1  # 指导销售内部查询建连超时（秒）

# ===== 封禁功能（本地） =====
ENABLE_LOCAL_BAN = True  # 是否启用本地封禁检查

# ===== PostgreSQL 数据库 =====
DB_HOST = "127.0.0.1"
DB_PORT = 5432
DB_NAME = "ak_proxy"
DB_USER = "ak_proxy"
DB_PASSWORD = os.environ.get("AK_PROXY_DB_PASSWORD", "")
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
LOGIN_RATE_PER_EXIT = 10  # 每个负载均衡出口节点每分钟最多登录次数
