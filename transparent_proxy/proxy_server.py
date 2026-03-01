# -*- coding: utf-8 -*-
"""
透明代理服务器
用户在本地运行，游戏客户端连接本地代理，代理直接转发到API服务器。
API服务器看到的是用户自己的IP，同时代理拦截登录/资产数据并上报到中央监控。
"""

import asyncio
import json
import sys
import os
import io
import time
import logging
from logging.handlers import RotatingFileHandler
from datetime import datetime
from typing import Optional

import httpx
import secrets
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import JSONResponse, HTMLResponse, Response
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# 修复Windows控制台中文乱码
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# 加载配置
sys.path.insert(0, os.path.dirname(__file__))
try:
    from config import *
except ImportError:
    PROXY_HOST = "0.0.0.0"
    PROXY_PORT = 8080
    AKAPI_URL = "https://www.akapi1.com/RPC/"
    MONITOR_SERVER = ""
    MONITOR_API_KEY = ""
    LOG_FILE = "proxy.log"
    LOG_LEVEL = "INFO"
    LOG_TO_CONSOLE = True
    LOG_TO_FILE = True
    REQUEST_TIMEOUT = 30
    ENABLE_LOCAL_BAN = True
    DB_HOST = "127.0.0.1"
    DB_PORT = 5432
    DB_NAME = "ak_proxy"
    DB_USER = "ak_proxy"
    DB_PASSWORD = "ak2026db"
    DB_MIN_POOL = 10
    DB_MAX_POOL = 30
    SOCKS5_EXITS = []
    LOGIN_RATE_PER_EXIT = 8

# 数据库模块
import database_pg as db
# 出口IP调度模块
from outbound_dispatcher import dispatcher, OutboundExit

# 初始化调度器配置
if SOCKS5_EXITS:
    dispatcher.configure_from_list(SOCKS5_EXITS)
dispatcher.MAX_LOGIN_PER_MIN = LOGIN_RATE_PER_EXIT

# ===== 日志配置 =====
logger = logging.getLogger("TransparentProxy")
logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))
formatter = logging.Formatter('[%(asctime)s] [%(levelname)s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S')

if LOG_TO_CONSOLE:
    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(formatter)
    logger.addHandler(ch)

if LOG_TO_FILE:
    log_path = os.path.join(os.path.dirname(__file__), LOG_FILE)
    fh = RotatingFileHandler(
        log_path, maxBytes=1*1024*1024*1024, backupCount=3, encoding='utf-8'
    )
    fh.setFormatter(formatter)
    logger.addHandler(fh)

# ===== 统计数据 =====
class ProxyStats:
    def __init__(self):
        self.start_time = datetime.now()
        self.total_requests = 0
        self.login_requests = 0
        self.login_success = 0
        self.login_fail = 0
        self.index_data_requests = 0
        self.other_requests = 0
        self.errors = 0
        self.last_login_account = ""
        self.last_login_time = ""
        self.report_success = 0
        self.report_fail = 0
        # 本地封禁列表
        self.banned_accounts: set = set()
        self.banned_ips: set = set()

stats = ProxyStats()

# ===== FastAPI 应用 =====
app = FastAPI(title="AK透明代理")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    """启动时初始化数据库连接池"""
    try:
        await db.init_db(
            host=DB_HOST, port=DB_PORT, database=DB_NAME,
            user=DB_USER, password=DB_PASSWORD,
            min_size=DB_MIN_POOL, max_size=DB_MAX_POOL
        )
        logger.info("PostgreSQL 数据库连接成功")
        # 启动定期清理任务
        asyncio.create_task(_periodic_cleanup())
    except Exception as e:
        logger.error(f"PostgreSQL 连接失败: {e}，将使用内存模式")
    # 启动出口调度器
    await dispatcher.start()


async def _periodic_cleanup():
    """每6小时清理旧数据，平衡性能和存储"""
    while True:
        await asyncio.sleep(6 * 3600)  # 6小时
        try:
            await db.cleanup_old_records(
                login_days=90,           # 登录记录保留90天
                max_login_rows=500000    # 最多50万条登录记录
            )
        except Exception as e:
            logger.warning(f"定期清理失败: {e}")


@app.on_event("shutdown")
async def shutdown():
    """关闭时释放数据库连接池"""
    await db.close_db()

# ===== 工具函数 =====
def parse_request_params(content_type: str, query_params: dict, raw_body: bytes) -> dict:
    """统一解析请求参数（支持JSON/Form/QueryString）"""
    params = dict(query_params)
    
    if not raw_body:
        return params
    
    try:
        if "application/json" in content_type:
            body = json.loads(raw_body)
            params.update(body)
        elif "application/x-www-form-urlencoded" in content_type:
            from urllib.parse import parse_qs
            form_data = parse_qs(raw_body.decode('utf-8'))
            for key, value in form_data.items():
                params[key] = value[0] if value else ''
        else:
            # 尝试JSON，失败则尝试Form
            try:
                body = json.loads(raw_body)
                params.update(body)
            except (json.JSONDecodeError, UnicodeDecodeError):
                try:
                    from urllib.parse import parse_qs
                    form_data = parse_qs(raw_body.decode('utf-8'))
                    for key, value in form_data.items():
                        params[key] = value[0] if value else ''
                except Exception:
                    pass
    except Exception as e:
        logger.warning(f"参数解析异常: {e}")
    
    return params


async def report_to_monitor(endpoint: str, data: dict):
    """上报数据到中央监控服务器（异步，不阻塞主流程）"""
    if not MONITOR_SERVER:
        return
    
    url = f"{MONITOR_SERVER.rstrip('/')}/api/transparent_proxy/{endpoint}"
    headers = {"Content-Type": "application/json"}
    if MONITOR_API_KEY:
        headers["X-API-Key"] = MONITOR_API_KEY
    
    try:
        async with httpx.AsyncClient(verify=False, timeout=10) as client:
            resp = await client.post(url, json=data, headers=headers)
            if resp.status_code == 200:
                stats.report_success += 1
            else:
                stats.report_fail += 1
                logger.warning(f"上报失败 [{endpoint}]: HTTP {resp.status_code}")
    except Exception as e:
        stats.report_fail += 1
        logger.debug(f"上报异常 [{endpoint}]: {e}")


async def forward_request(method: str, api_path: str, content_type: str,
                          params: dict, raw_body: bytes, headers: dict,
                          client_ip: str = "",
                          is_login: bool = False) -> httpx.Response:
    """转发请求到真实API服务器（通过出口调度器选择出口IP）"""
    url = AKAPI_URL + api_path
    # 从nginx传递的头中提取用户真实IP
    real_ip = client_ip or headers.get("x-real-ip", "") or headers.get("x-forwarded-for", "").split(",")[0].strip()
    fwd_headers = {
        "User-Agent": headers.get("user-agent", ""),
        "Content-Type": content_type or "application/json",
        "Accept": headers.get("accept", "*/*"),
    }
    if real_ip:
        fwd_headers["X-Real-IP"] = real_ip
        fwd_headers["X-Forwarded-For"] = real_ip

    # 通过调度器选择出口
    exit_obj = dispatcher.pick_login_exit() if is_login else dispatcher.pick_api_exit()
    logger.debug(f"[Forward] {api_path} -> 出口[{exit_obj.name}]")

    return await dispatcher.forward(
        exit_obj, method, url, fwd_headers,
        content_type=content_type, params=params,
        raw_body=raw_body, timeout=REQUEST_TIMEOUT
    )


# ===== 状态页 =====
@app.get("/", response_class=HTMLResponse)
async def status_page():
    """代理状态页面"""
    uptime = datetime.now() - stats.start_time
    hours, remainder = divmod(int(uptime.total_seconds()), 3600)
    minutes, seconds = divmod(remainder, 60)
    
    monitor_status = f'<span style="color:#00ff88">已连接 ({MONITOR_SERVER})</span>' if MONITOR_SERVER else '<span style="color:#888">未配置</span>'
    
    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>AK透明代理</title>
<style>
body {{ background: #0a0e1a; color: #e0e0e0; font-family: 'Segoe UI', sans-serif; padding: 40px; }}
.card {{ background: #141928; border: 1px solid #2a2f45; border-radius: 12px; padding: 25px; margin: 15px 0; }}
h1 {{ color: #00e5ff; }} h3 {{ color: #00ff88; margin-top: 0; }}
.stat {{ display: inline-block; min-width: 150px; margin: 8px 15px 8px 0; }}
.stat .val {{ font-size: 28px; font-weight: bold; color: #00e5ff; }}
.stat .label {{ font-size: 13px; color: #888; }}
.ok {{ color: #00ff88; }} .err {{ color: #ff5252; }}
</style></head><body>
<h1>🔄 AK 透明代理服务器</h1>
<div class="card">
    <h3>运行状态</h3>
    <div class="stat"><div class="val">{hours}h {minutes}m {seconds}s</div><div class="label">运行时间</div></div>
    <div class="stat"><div class="val">{stats.total_requests}</div><div class="label">总请求数</div></div>
    <div class="stat"><div class="val">{stats.errors}</div><div class="label">错误数</div></div>
</div>
<div class="card">
    <h3>登录统计</h3>
    <div class="stat"><div class="val">{stats.login_requests}</div><div class="label">登录请求</div></div>
    <div class="stat"><div class="val ok">{stats.login_success}</div><div class="label">成功</div></div>
    <div class="stat"><div class="val err">{stats.login_fail}</div><div class="label">失败</div></div>
    <div class="stat"><div class="val">{stats.last_login_account or '-'}</div><div class="label">最近登录</div></div>
</div>
<div class="card">
    <h3>API统计</h3>
    <div class="stat"><div class="val">{stats.index_data_requests}</div><div class="label">IndexData</div></div>
    <div class="stat"><div class="val">{stats.other_requests}</div><div class="label">其他RPC</div></div>
</div>
<div class="card">
    <h3>中央监控上报</h3>
    <p>状态: {monitor_status}</p>
    <div class="stat"><div class="val ok">{stats.report_success}</div><div class="label">上报成功</div></div>
    <div class="stat"><div class="val err">{stats.report_fail}</div><div class="label">上报失败</div></div>
</div>
<div class="card" style="color:#888; font-size:13px;">
    <p>API目标: {AKAPI_URL}</p>
    <p>监听地址: {PROXY_HOST}:{PROXY_PORT}</p>
    <p>启动时间: {stats.start_time.strftime('%Y-%m-%d %H:%M:%S')}</p>
</div>
</body></html>"""
    return html


# ===== 登录拦截 =====
@app.api_route("/RPC/Login", methods=["GET", "POST"])
async def proxy_login(request: Request):
    """拦截登录请求：记录 → 转发(用户自己的IP) → 处理结果 → 上报"""
    stats.total_requests += 1
    stats.login_requests += 1
    
    client_ip = request.client.host if request.client else "unknown"
    user_agent = request.headers.get("user-agent", "")
    content_type = request.headers.get("content-type", "")
    
    # 解析参数
    raw_body = await request.body() if request.method == "POST" else b""
    params = parse_request_params(content_type, dict(request.query_params), raw_body)
    
    account = params.get("account", "unknown")
    password = params.get("password", "")
    
    logger.info(f"[Login] 账号={account}, IP={client_ip}")
    
    # 本地封禁检查（优先数据库，回退内存）
    if ENABLE_LOCAL_BAN:
        try:
            banned = await db.is_banned(username=account, ip_address=client_ip)
        except Exception:
            banned = account in stats.banned_accounts or client_ip in stats.banned_ips
        if banned:
            logger.warning(f"[Login] 封禁拦截: account={account}, IP={client_ip}")
            return JSONResponse({"Error": True, "Msg": "您的账号或IP已被封禁"})
    
    # 白名单检查
    persistent_login = False
    try:
        auth_info = await db.check_authorized(account)
        if not auth_info:
            logger.info(f"[Login] 白名单拦截(未授权): {account}")
            return JSONResponse({"Error": True, "Msg": "未获得访问权限，请联系上属老师获取权限或使用ak2018，ak928登录！"})
        if auth_info['expire_time'] < datetime.now():
            logger.info(f"[Login] 白名单拦截(已过期): {account}")
            return JSONResponse({"Error": True, "Msg": "您的访问权限已到期，请联系上属老师续期或使用ak2018，ak928登录！"})
        persistent_login = auth_info.get('persistent_login', False)
    except Exception as e:
        logger.warning(f"[Login] 白名单检查异常: {e}，放行")

    # 直接转发到API服务器（透传用户真实IP）
    try:
        response = await forward_request(
            request.method, "Login", content_type, params, raw_body, dict(request.headers),
            client_ip=client_ip, is_login=True
        )
        result = response.json()
    except Exception as e:
        stats.errors += 1
        logger.error(f"[Login] 转发失败: {e}")
        return JSONResponse({"Error": True, "Msg": f"API连接失败: {str(e)}"})
    
    # 判断登录结果
    is_success = result.get("Error") == False or (not result.get("Error") and result.get("UserData"))
    
    if is_success:
        stats.login_success += 1
        stats.last_login_account = account
        stats.last_login_time = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        logger.info(f"[Login] 登录成功: {account}")
    else:
        stats.login_fail += 1
        logger.info(f"[Login] 登录失败: {account}, Msg={result.get('Msg', '')}")
    
    # 记录到 PostgreSQL 数据库
    try:
        await db.record_login(
            username=account, ip_address=client_ip,
            user_agent=user_agent[:200],
            request_path="/RPC/Login",
            status_code=200 if is_success else 401,
            is_success=is_success, password=password,
            extra_data=json.dumps({"status": "success" if is_success else "failed", "msg": result.get("Msg", "")})
        )
    except Exception as e:
        logger.warning(f"[Login] 数据库记录失败: {e}")

    # 异步上报到中央监控服务器
    report_data = {
        "account": account,
        "client_ip": client_ip,
        "user_agent": user_agent[:200],
        "is_success": is_success,
        "msg": result.get("Msg", ""),
        "time": datetime.now().replace(microsecond=0).isoformat(),
    }
    
    # 如果登录成功，提取资产数据并存入数据库
    if is_success and result.get("UserData"):
        user_data = result["UserData"]
        logger.info(f"[Login] UserData字段: {list(user_data.keys())}")
        logger.info(f"[Login] L={user_data.get('L')}, R={user_data.get('R')}, F={user_data.get('F')}, S={user_data.get('S')}")
        try:
            await db.update_user_assets(account, user_data)
        except Exception as e:
            logger.warning(f"[Login] 资产保存失败: {e}")
        report_data["assets"] = {
            "EP": user_data.get("EP", 0),
            "SP": user_data.get("SP", 0),
            "RP": user_data.get("RP", 0),
            "TP": user_data.get("TP", 0),
            "ACECount": user_data.get("ACECount", 0),
            "TotalACE": user_data.get("TotalACE", 0),
            "WeeklyMoney": user_data.get("WeeklyMoney", 0),
            "HonorName": user_data.get("HonorName", ""),
            "LevelNumber": user_data.get("LevelNumber", 0),
            "Rate": user_data.get("Rate", 0),
            "Credit": user_data.get("Credit", 0),
            "AP": user_data.get("AP", 0),
            "LP": user_data.get("LP", 0),
            "Convertbalance": user_data.get("Convertbalance", 0),
            "L": user_data.get("L", 0),
            "R": user_data.get("R", 0),
            "F": user_data.get("F", 0),
            "S": user_data.get("S", 0),
        }
    
    asyncio.create_task(report_to_monitor("login", report_data))
    
    # 返回原始结果
    resp = JSONResponse(result)
    if is_success:
        resp.set_cookie(key="ak_username", value=account, max_age=86400*30, httponly=False, samesite="lax")
        if persistent_login:
            resp.set_cookie(key="ak_persist", value="1", max_age=86400*30, httponly=False, samesite="lax")
        else:
            resp.delete_cookie(key="ak_persist")
    return resp


# ===== IndexData 拦截 =====
@app.api_route("/RPC/public_IndexData", methods=["GET", "POST"])
async def proxy_index_data(request: Request):
    """拦截资产数据请求：转发 → 提取数据 → 上报"""
    stats.total_requests += 1
    stats.index_data_requests += 1
    
    client_ip = request.client.host if request.client else "unknown"
    content_type = request.headers.get("content-type", "")
    
    raw_body = await request.body() if request.method == "POST" else b""
    params = parse_request_params(content_type, dict(request.query_params), raw_body)
    
    logger.debug(f"[IndexData] 请求参数: {list(params.keys())}")
    
    # 直接转发（透传用户真实IP）
    try:
        response = await forward_request(
            request.method, "public_IndexData", content_type, params, raw_body, dict(request.headers),
            client_ip=client_ip
        )
        result = response.json()
    except Exception as e:
        stats.errors += 1
        logger.error(f"[IndexData] 转发失败: {e}")
        return JSONResponse({"Error": True, "Msg": f"API连接失败: {str(e)}"})
    
    # 提取资产数据并上报
    if not result.get("Error") and result.get("Data"):
        data = result["Data"]
        # 从请求参数、响应数据、cookie中提取用户名（不用全局变量，避免并发错乱）
        username = (params.get("account") or params.get("Account") or
                   data.get("UserName") or data.get("Account") or
                   request.cookies.get("ak_username") or "unknown")
        
        if username and username != "unknown" and ('ACECount' in data or 'EP' in data):
            # 只有授权用户才保存资产
            try:
                auth_info = await db.check_authorized(username)
                if auth_info and auth_info.get('expire_time') and auth_info['expire_time'] > datetime.now():
                    await db.update_user_assets(username, data)
                else:
                    logger.debug(f"[IndexData] 跳过未授权用户: {username}")
            except Exception as e:
                logger.warning(f"[IndexData] 资产保存失败: {e}")
            report_data = {
                "account": username,
                "client_ip": client_ip,
                "time": datetime.now().replace(microsecond=0).isoformat(),
                "assets": {
                    "EP": data.get("EP", 0),
                    "SP": data.get("SP", 0),
                    "RP": data.get("RP", 0),
                    "TP": data.get("TP", 0),
                    "ACECount": data.get("ACECount", 0),
                    "TotalACE": data.get("TotalACE", 0),
                    "WeeklyMoney": data.get("WeeklyMoney", 0),
                    "HonorName": data.get("HonorName", ""),
                    "LevelNumber": data.get("LevelNumber", 0),
                    "Rate": data.get("Rate", 0),
                    "Credit": data.get("Credit", 0),
                    "AP": data.get("AP", 0),
                    "LP": data.get("LP", 0),
                    "Convertbalance": data.get("Convertbalance", 0),
                }
            }
            asyncio.create_task(report_to_monitor("asset_update", report_data))
            logger.info(f"[IndexData] 资产更新: {username}")
    
    return JSONResponse(result)


# ===== 通用 RPC 代理 =====
@app.api_route("/RPC/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy_rpc(path: str, request: Request):
    """透明转发所有其他RPC请求"""
    stats.total_requests += 1
    stats.other_requests += 1
    
    client_ip = request.client.host if request.client else "unknown"
    content_type = request.headers.get("content-type", "")
    
    # 封禁检查（优先数据库）
    if ENABLE_LOCAL_BAN:
        try:
            if await db.is_banned(ip_address=client_ip):
                return JSONResponse({"Error": True, "Msg": "您的IP已被封禁"})
        except Exception:
            if client_ip in stats.banned_ips:
                return JSONResponse({"Error": True, "Msg": "您的IP已被封禁"})
    
    raw_body = None
    if request.method in ["POST", "PUT"]:
        raw_body = await request.body()
    
    params = {}
    if raw_body:
        try:
            params = json.loads(raw_body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
    
    logger.debug(f"[RPC/{path}] 转发请求")
    
    try:
        response = await forward_request(
            request.method, path, content_type, params, raw_body, dict(request.headers),
            client_ip=client_ip
        )
        try:
            result = response.json()
            return JSONResponse(content=result, status_code=response.status_code)
        except Exception:
            return JSONResponse(content=response.text, status_code=response.status_code)
    except Exception as e:
        stats.errors += 1
        logger.error(f"[RPC/{path}] 转发失败: {e}")
        return JSONResponse({"Error": True, "Msg": f"请求失败: {str(e)}"}, status_code=500)


# ===== 管理API =====
@app.get("/api/status")
async def api_status():
    """获取代理状态（JSON）"""
    uptime = (datetime.now() - stats.start_time).total_seconds()
    return {
        "running": True,
        "uptime_seconds": int(uptime),
        "total_requests": stats.total_requests,
        "login": {
            "total": stats.login_requests,
            "success": stats.login_success,
            "fail": stats.login_fail,
            "last_account": stats.last_login_account,
            "last_time": stats.last_login_time,
        },
        "index_data_requests": stats.index_data_requests,
        "other_requests": stats.other_requests,
        "errors": stats.errors,
        "report": {
            "server": MONITOR_SERVER or "未配置",
            "success": stats.report_success,
            "fail": stats.report_fail,
        },
        "api_target": AKAPI_URL,
        "dispatcher": dispatcher.summary(),
    }


@app.get("/api/dispatcher")
async def api_dispatcher_status():
    """获取出口调度器状态"""
    return dispatcher.get_status()


@app.get("/api/db/size")
async def api_db_size():
    """查看数据库各表存储占用"""
    try:
        size_info = await db.get_db_size()
        row_counts = await db.get_table_row_counts()
        for t in size_info.get('tables', []):
            t['row_count_exact'] = row_counts.get(t['table_name'], 0)
        return {"success": True, "data": size_info}
    except Exception as e:
        return {"success": False, "message": f"查询失败: {e}"}


@app.post("/api/db/delete")
async def api_db_delete(request: Request):
    """按日期删除指定表数据
    参数: table, before_date, after_date, exact_date (YYYY-MM-DD)
    """
    try:
        data = await request.json()
        table = data.get("table", "")
        before_date = data.get("before_date")
        after_date = data.get("after_date")
        exact_date = data.get("exact_date")
        deleted = await db.delete_by_date(table, before_date, after_date, exact_date)
        return {"success": True, "deleted": deleted, "table": table}
    except ValueError as e:
        return {"success": False, "message": str(e)}
    except Exception as e:
        return {"success": False, "message": f"删除失败: {e}"}


@app.get("/api/db/stats")
async def api_db_stats():
    """获取数据库统计摘要 + 连接池状态"""
    try:
        summary = await db.get_stats_summary()
        row_counts = await db.get_table_row_counts()
        pool_info = db.get_pool_info()
        return {"success": True, "summary": summary, "row_counts": row_counts, "pool": pool_info}
    except Exception as e:
        return {"success": False, "message": f"查询失败: {e}"}


@app.post("/api/ban")
async def api_ban(request: Request):
    """封禁账号或IP（持久化到PostgreSQL）"""
    data = await request.json()
    ban_type = data.get("type", "")
    value = data.get("value", "")
    reason = data.get("reason", "")
    
    if ban_type == "account" and value:
        stats.banned_accounts.add(value.lower())
        try:
            await db.ban_user(value, reason)
        except Exception as e:
            logger.warning(f"[Ban] 数据库封禁失败: {e}")
        logger.info(f"[Ban] 封禁账号: {value}")
        return {"success": True, "message": f"已封禁账号: {value}"}
    elif ban_type == "ip" and value:
        stats.banned_ips.add(value)
        try:
            await db.ban_ip(value, reason)
        except Exception as e:
            logger.warning(f"[Ban] 数据库封禁失败: {e}")
        logger.info(f"[Ban] 封禁IP: {value}")
        return {"success": True, "message": f"已封禁IP: {value}"}
    
    return {"success": False, "message": "参数无效，需要 type(account/ip) 和 value"}


@app.post("/api/unban")
async def api_unban(request: Request):
    """解除封禁（持久化到PostgreSQL）"""
    data = await request.json()
    ban_type = data.get("type", "")
    value = data.get("value", "")
    
    if ban_type == "account" and value:
        stats.banned_accounts.discard(value.lower())
        try:
            await db.unban_user(value)
        except Exception as e:
            logger.warning(f"[Unban] 数据库解封失败: {e}")
        logger.info(f"[Unban] 解封账号: {value}")
        return {"success": True, "message": f"已解封账号: {value}"}
    elif ban_type == "ip" and value:
        stats.banned_ips.discard(value)
        try:
            await db.unban_ip(value)
        except Exception as e:
            logger.warning(f"[Unban] 数据库解封失败: {e}")
        logger.info(f"[Unban] 解封IP: {value}")
        return {"success": True, "message": f"已解封IP: {value}"}
    
    return {"success": False, "message": "参数无效"}


# ===== 管理后台系统 =====

ADMIN_PASSWORD = "ak-lovejjy1314"
DB_SECONDARY_PASSWORD = "aa292180"
ROLE_SUPER_ADMIN = "super_admin"
ROLE_SUB_ADMIN = "sub_admin"
SUB_ADMINS = {}
admin_tokens = {}
LOGIN_MAX_FAILS = 5
LOGIN_LOCKOUT_TIME = 300
login_fail_records = {}
db_auth_tokens = {}

LICENSE_SERVER_URL = os.environ.get('LICENSE_SERVER_URL', 'http://121.4.46.66:8080')
LICENSE_ADMIN_KEY = os.environ.get('LICENSE_ADMIN_KEY', 'ak-lovejjy1314')


# --- 登录防暴力 ---
def check_login_lockout(ip: str):
    record = login_fail_records.get(ip, [0, 0])
    if record[0] >= LOGIN_MAX_FAILS:
        elapsed = time.time() - record[1]
        if elapsed < LOGIN_LOCKOUT_TIME:
            return True, int(LOGIN_LOCKOUT_TIME - elapsed)
        login_fail_records.pop(ip, None)
    return False, 0

def record_login_fail(ip: str):
    record = login_fail_records.get(ip, [0, 0])
    record[0] += 1
    record[1] = time.time()
    login_fail_records[ip] = record

def clear_login_fail(ip: str):
    login_fail_records.pop(ip, None)


# --- 密码验证 ---
def verify_admin_password(password: str):
    if not password or not isinstance(password, str):
        return False, None, None
    if secrets.compare_digest(password, ADMIN_PASSWORD):
        return True, ROLE_SUPER_ADMIN, None
    for sub_name, sub_data in SUB_ADMINS.items():
        sub_pwd = sub_data.get('password', '') if isinstance(sub_data, dict) else sub_data
        if sub_pwd and secrets.compare_digest(password, sub_pwd):
            return True, ROLE_SUB_ADMIN, sub_name
    return False, None, None

def get_sub_admin_permissions(sub_name: str) -> dict:
    sub_data = SUB_ADMINS.get(sub_name, {})
    return sub_data.get('permissions', {}) if isinstance(sub_data, dict) else {}

def check_token_permission(token: str, perm_key: str) -> bool:
    role = get_token_role(token)
    if role == ROLE_SUPER_ADMIN:
        return True
    if role == ROLE_SUB_ADMIN:
        sub_name = get_token_sub_name(token)
        if sub_name:
            return get_sub_admin_permissions(sub_name).get(perm_key, False)
    return False


# --- Token管理 ---
async def _load_tokens_from_db():
    global admin_tokens
    try:
        admin_tokens = await db.load_all_admin_tokens()
        logger.info(f"[Token] 从数据库恢复了 {len(admin_tokens)} 个有效Token")
    except Exception as e:
        logger.warning(f"[Token] 加载Token失败: {e}")
        admin_tokens = {}

async def generate_admin_token(role: str, sub_name: str = '') -> str:
    if role == ROLE_SUB_ADMIN and sub_name:
        tokens_to_remove = [t for t, d in admin_tokens.items()
                            if d.get('role') == ROLE_SUB_ADMIN and d.get('sub_name') == sub_name]
        for t in tokens_to_remove:
            admin_tokens.pop(t, None)
        await db.delete_admin_tokens_by_sub_name(sub_name)
    else:
        tokens_to_remove = [t for t, d in admin_tokens.items() if d.get('role') == role]
        for t in tokens_to_remove:
            admin_tokens.pop(t, None)
        await db.delete_admin_tokens_by_role(role)

    token = secrets.token_urlsafe(32)
    expire = time.time() + 86400
    admin_tokens[token] = {'expire': expire, 'role': role, 'sub_name': sub_name}
    await db.save_admin_token(token, role, expire, sub_name)
    return token

async def verify_admin_token(token: str) -> bool:
    if not token:
        return False
    token_data = admin_tokens.get(token)
    if not token_data:
        token_data = await db.get_admin_token(token)
        if token_data:
            admin_tokens[token] = token_data
    if not token_data:
        return False
    if time.time() > token_data.get('expire', 0):
        admin_tokens.pop(token, None)
        await db.delete_admin_token(token)
        return False
    return True

def get_token_role(token: str):
    if not token:
        return None
    td = admin_tokens.get(token)
    if td and time.time() <= td.get('expire', 0):
        return td.get('role')
    return None

def get_token_sub_name(token: str) -> str:
    if not token:
        return ''
    td = admin_tokens.get(token)
    if td and time.time() <= td.get('expire', 0):
        return td.get('sub_name', '')
    return ''

async def kick_sub_admins(target_name: str = None) -> int:
    if target_name:
        tokens_to_remove = [t for t, d in admin_tokens.items()
                            if d.get('role') == ROLE_SUB_ADMIN and d.get('sub_name') == target_name]
        for t in tokens_to_remove:
            admin_tokens.pop(t, None)
        count = await db.delete_admin_tokens_by_sub_name(target_name)
        return max(len(tokens_to_remove), count)
    else:
        tokens_to_remove = [t for t, d in admin_tokens.items() if d.get('role') == ROLE_SUB_ADMIN]
        for t in tokens_to_remove:
            admin_tokens.pop(t, None)
        count = await db.delete_admin_tokens_by_role(ROLE_SUB_ADMIN)
        return max(len(tokens_to_remove), count)


# --- 二级密码 ---
def generate_db_token():
    token = secrets.token_urlsafe(32)
    db_auth_tokens[token] = time.time() + 1800
    expired = [k for k, v in db_auth_tokens.items() if v < time.time()]
    for k in expired:
        del db_auth_tokens[k]
    return token

def verify_db_token(token: str) -> bool:
    if not token:
        return False
    expire_time = db_auth_tokens.get(token)
    if not expire_time or time.time() > expire_time:
        db_auth_tokens.pop(token, None)
        return False
    return True

def verify_db_password(password: str) -> bool:
    if not password or not isinstance(password, str):
        return False
    return secrets.compare_digest(password, DB_SECONDARY_PASSWORD)

def check_db_auth(request: Request):
    token = request.headers.get("X-DB-Token")
    if not verify_db_token(token):
        raise HTTPException(status_code=403, detail="数据库操作需要二级密码验证")


# --- WebSocket管理器 ---
class ConnectionManager:
    def __init__(self):
        self.active_connections = set()
        self.sub_admin_sessions = {}

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)
        to_remove = [n for n, s in self.sub_admin_sessions.items() if s.get('websocket') is websocket]
        for n in to_remove:
            del self.sub_admin_sessions[n]

    def register_sub_admin(self, sub_name: str, websocket: WebSocket):
        self.sub_admin_sessions[sub_name] = {
            'websocket': websocket, 'last_heartbeat': datetime.now(),
            'login_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        }

    def heartbeat_sub_admin(self, sub_name: str):
        if sub_name in self.sub_admin_sessions:
            self.sub_admin_sessions[sub_name]['last_heartbeat'] = datetime.now()

    def get_online_sub_admins(self) -> dict:
        now = datetime.now()
        online, offline = {}, []
        for name, sess in self.sub_admin_sessions.items():
            if (now - sess['last_heartbeat']).total_seconds() > 15:
                offline.append(name)
            else:
                online[name] = sess['login_time']
        for n in offline:
            del self.sub_admin_sessions[n]
        return online

    async def broadcast(self, message: dict):
        dead = set()
        for conn in self.active_connections:
            try:
                await conn.send_json(message)
            except Exception:
                dead.add(conn)
        self.active_connections -= dead

ws_manager = ConnectionManager()


class OnlineUserManager:
    def __init__(self):
        self.users = {}
        self.messages = {}

    async def user_online(self, username, websocket, page, user_agent):
        self.users[username] = {
            'websocket': websocket, 'page': page, 'user_agent': user_agent,
            'online_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'last_heartbeat': datetime.now()
        }

    def user_offline(self, username):
        self.users.pop(username, None)

    def update_heartbeat(self, username):
        if username in self.users:
            self.users[username]['last_heartbeat'] = datetime.now()

    def get_online_users(self):
        now = datetime.now()
        online, offline = [], []
        for u, d in self.users.items():
            if (now - d['last_heartbeat']).seconds > 60:
                offline.append(u)
            else:
                online.append({'username': u, 'page': d['page'],
                               'user_agent': (d['user_agent'] or '')[:50],
                               'online_time': d['online_time']})
        for u in offline:
            del self.users[u]
        return online

    async def send_to_user(self, username, content, save_history=True):
        if username in self.users:
            try:
                await self.users[username]['websocket'].send_json({
                    'type': 'admin_message', 'content': content,
                    'time': datetime.now().strftime('%H:%M:%S')
                })
                if save_history:
                    self.messages.setdefault(username, []).append(
                        {'content': content, 'is_admin': True, 'time': datetime.now().strftime('%H:%M:%S')})
                return True
            except Exception:
                return False
        return False

    def save_user_message(self, username, content):
        self.messages.setdefault(username, []).append(
            {'content': content, 'is_admin': False, 'time': datetime.now().strftime('%H:%M:%S')})

    def get_messages(self, username):
        return self.messages.get(username, [])[-50:]

online_manager = OnlineUserManager()


# --- 启动任务 ---
@app.on_event("startup")
async def admin_startup():
    await _load_tokens_from_db()
    try:
        global SUB_ADMINS
        SUB_ADMINS = await db.db_get_all_sub_admins()
        logger.info(f"[SubAdmin] 加载了 {len(SUB_ADMINS)} 个子管理员")
    except Exception as e:
        logger.warning(f"[SubAdmin] 加载失败: {e}")

    async def _token_cleanup():
        while True:
            await asyncio.sleep(3600)
            try:
                expired = [k for k, v in admin_tokens.items() if v.get('expire', 0) < time.time()]
                for k in expired:
                    admin_tokens.pop(k, None)
                await db.cleanup_expired_tokens()
            except Exception:
                pass
    asyncio.create_task(_token_cleanup())

    async def _expire_accounts():
        while True:
            await asyncio.sleep(300)
            try:
                count = await db.expire_overdue_accounts()
                if count > 0:
                    logger.info(f"[Auth] 自动过期了 {count} 个账号")
            except Exception:
                pass
    asyncio.create_task(_expire_accounts())


# ===== 管理后台 API =====

@app.post("/admin/api/login")
async def admin_login(request: Request):
    client_ip = request.client.host if request.client else "unknown"
    is_locked, remaining = check_login_lockout(client_ip)
    if is_locked:
        return {"success": False, "message": f"登录尝试过多，请{remaining}秒后重试"}
    try:
        data = await request.json()
        password = data.get('password', '')
    except Exception:
        return {"success": False, "message": "请求无效"}
    await asyncio.sleep(0.3)
    is_valid, role, sub_name = verify_admin_password(password)
    if is_valid:
        clear_login_fail(client_ip)
        token = await generate_admin_token(role, sub_name=sub_name or '')
        if role == ROLE_SUPER_ADMIN:
            role_name = "系统总管理"
            permissions = {}
        else:
            role_name = f"子管理员({sub_name})" if sub_name else "子管理员"
            permissions = get_sub_admin_permissions(sub_name) if sub_name else {}
        return {"success": True, "token": token, "role": role, "role_name": role_name,
                "sub_name": sub_name or "", "permissions": permissions}
    else:
        record_login_fail(client_ip)
        await asyncio.sleep(0.7)
        record = login_fail_records.get(client_ip, [0, 0])
        if record[0] >= LOGIN_MAX_FAILS:
            return {"success": False, "message": f"密码错误次数过多，账号已锁定{LOGIN_LOCKOUT_TIME}秒"}
        return {"success": False, "message": f"密码错误，剩余{LOGIN_MAX_FAILS - record[0]}次尝试机会"}

@app.get("/admin/api/verify_token")
async def verify_token_api(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not token or not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"valid": False, "message": "未登录"})
    role = get_token_role(token)
    sub_name = get_token_sub_name(token)
    if role == ROLE_SUPER_ADMIN:
        role_name, permissions = "系统总管理", {}
    else:
        role_name = f"子管理员({sub_name})" if sub_name else "子管理员"
        permissions = get_sub_admin_permissions(sub_name) if sub_name else {}
    return {"valid": True, "role": role, "role_name": role_name, "sub_name": sub_name or "", "permissions": permissions}

@app.get("/admin/api/stats")
async def admin_stats():
    return await db.get_stats_summary()

@app.get("/admin/api/dashboard")
async def admin_dashboard():
    try:
        return await db.get_dashboard_data()
    except Exception as e:
        logger.warning(f"[Dashboard] 数据加载失败: {e}")
        return {"today_requests": 0, "success_rate": 0, "active_users": 0, "peak_rpm": 0, "hourly_data": [], "top_users": [], "top_ips": []}

@app.get("/admin/api/users")
async def admin_users(limit: int = 100, offset: int = 0):
    return await db.get_all_users_with_assets(limit, offset)

@app.get("/admin/api/ips")
async def admin_ips(limit: int = 100, offset: int = 0):
    return await db.get_all_ips(limit, offset)

@app.get("/admin/api/usage")
async def admin_usage(limit: int = 500):
    return await db.get_all_users(limit, 0)

@app.get("/admin/api/logins")
async def admin_logins(limit: int = 50):
    return await db.get_recent_logins(limit)

@app.get("/admin/api/user/{username}")
async def admin_user_detail(username: str):
    user = await db.get_user_detail(username)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    return user

@app.get("/admin/api/banlist")
async def admin_banlist():
    return await db.get_ban_list()

@app.get("/admin/api/assets")
async def admin_assets(limit: int = 100, offset: int = 0, search: str = None):
    return await db.get_all_user_assets(limit, offset, search)

@app.get("/admin/api/assets/{username}")
async def admin_user_assets(username: str):
    assets = await db.get_user_assets(username)
    if not assets:
        raise HTTPException(status_code=404, detail="用户资产不存在")
    return assets

@app.post("/admin/api/ban/user")
async def admin_ban_user(request: Request):
    data = await request.json()
    value, reason = data.get('value', ''), data.get('reason', '')
    await db.ban_user(value, reason)
    stats.banned_accounts.add(value.lower())
    await ws_manager.broadcast({"type": "user_banned", "data": {"username": value, "reason": reason}})
    return {"success": True, "message": f"用户 {value} 已被封禁"}

@app.post("/admin/api/unban/user")
async def admin_unban_user(request: Request):
    data = await request.json()
    value = data.get('value', '')
    await db.unban_user(value)
    stats.banned_accounts.discard(value.lower())
    await ws_manager.broadcast({"type": "user_unbanned", "data": {"username": value}})
    return {"success": True, "message": f"用户 {value} 已解封"}

@app.post("/admin/api/ban/ip")
async def admin_ban_ip(request: Request):
    data = await request.json()
    value, reason = data.get('value', ''), data.get('reason', '')
    await db.ban_ip(value, reason)
    stats.banned_ips.add(value)
    await ws_manager.broadcast({"type": "ip_banned", "data": {"ip": value, "reason": reason}})
    return {"success": True, "message": f"IP {value} 已被封禁"}

@app.post("/admin/api/unban/ip")
async def admin_unban_ip(request: Request):
    data = await request.json()
    value = data.get('value', '')
    await db.unban_ip(value)
    stats.banned_ips.discard(value)
    await ws_manager.broadcast({"type": "ip_unbanned", "data": {"ip": value}})
    return {"success": True, "message": f"IP {value} 已解封"}

@app.get("/admin/api/online")
async def admin_online_users():
    return online_manager.get_online_users()

@app.post("/admin/api/chat/send")
async def admin_chat_send(request: Request):
    data = await request.json()
    username, content = data.get('username'), data.get('content')
    if not username or not content:
        raise HTTPException(status_code=400, detail="缺少参数")
    success = await online_manager.send_to_user(username, content)
    if success:
        await ws_manager.broadcast({"type": "chat_message", "data": {
            "username": username, "content": content,
            "time": datetime.now().strftime('%H:%M:%S'), "is_admin": True}})
        return {"success": True}
    raise HTTPException(status_code=404, detail="用户不在线")

@app.get("/admin/api/chat/history/{username}")
async def admin_chat_history(username: str):
    return online_manager.get_messages(username)

@app.post("/admin/api/chat/broadcast")
async def admin_chat_broadcast(request: Request):
    data = await request.json()
    content = data.get('content')
    if not content:
        raise HTTPException(status_code=400, detail="缺少消息内容")
    online_users = online_manager.get_online_users()
    sent_count = 0
    for user in online_users:
        if await online_manager.send_to_user(user.get('username'), content, save_history=False):
            sent_count += 1
    await ws_manager.broadcast({"type": "broadcast_message", "data": {
        "content": content, "time": datetime.now().strftime('%H:%M:%S'), "sent_count": sent_count}})
    return {"success": True, "sent_count": sent_count}


# --- 子管理员管理 ---
@app.get("/admin/api/sub_admin")
async def admin_sub_admin_list(request: Request):
    online_subs = ws_manager.get_online_sub_admins()
    login_times = {}
    for token, data in admin_tokens.items():
        if data.get('role') == ROLE_SUB_ADMIN and data.get('expire', 0) > time.time():
            sname = data.get('sub_name', '')
            if sname and sname not in login_times:
                login_times[sname] = datetime.fromtimestamp(data.get('expire', 0) - 86400).strftime('%Y-%m-%d %H:%M:%S')
    sub_admin_list = []
    for name, sub_data in SUB_ADMINS.items():
        pwd = sub_data.get('password', '') if isinstance(sub_data, dict) else sub_data
        perms = sub_data.get('permissions', {}) if isinstance(sub_data, dict) else {}
        sub_admin_list.append({
            "name": name, "password_hint": pwd[:2] + "***" if pwd and len(pwd) > 2 else "***",
            "is_online": name in online_subs, "login_time": login_times.get(name), "permissions": perms})
    return {"sub_admins": sub_admin_list, "total": len(SUB_ADMINS)}

@app.post("/admin/api/sub_admin/set")
async def admin_sub_admin_set(request: Request):
    await asyncio.sleep(0.3)
    try:
        data = await request.json()
    except Exception:
        return {"success": False, "message": "请求无效"}
    admin_password = data.get('admin_password', '')
    secondary_password = data.get('secondary_password', '')
    sub_name = data.get('sub_name', '').strip()
    new_sub_password = data.get('new_sub_password', '')

    is_valid, role, _ = verify_admin_password(admin_password)
    if not is_valid or role != ROLE_SUPER_ADMIN:
        await asyncio.sleep(0.7)
        return {"success": False, "message": "系统总管理员密码错误"}
    if not verify_db_password(secondary_password):
        await asyncio.sleep(0.7)
        return {"success": False, "message": "二级密码错误"}
    if not sub_name or len(sub_name) > 20:
        return {"success": False, "message": "子管理员名称无效"}
    if not new_sub_password or len(new_sub_password) < 6:
        return {"success": False, "message": "子管理员密码至少6位"}
    if secrets.compare_digest(new_sub_password, ADMIN_PASSWORD):
        return {"success": False, "message": "不能与总管理员密码相同"}

    permissions = data.get('permissions', {})
    is_update = sub_name in SUB_ADMINS
    try:
        await db.db_set_sub_admin(sub_name, new_sub_password, permissions)
        SUB_ADMINS[sub_name] = {'password': new_sub_password, 'permissions': permissions}
        return {"success": True, "message": f"子管理员 [{sub_name}] {'更新' if is_update else '添加'}成功"}
    except Exception as e:
        return {"success": False, "message": f"保存失败: {e}"}

@app.post("/admin/api/sub_admin/update_permissions")
async def admin_sub_admin_update_perms(request: Request):
    await asyncio.sleep(0.3)
    try:
        data = await request.json()
    except Exception:
        return {"success": False, "message": "请求无效"}
    is_valid, role, _ = verify_admin_password(data.get('admin_password', ''))
    if not is_valid or role != ROLE_SUPER_ADMIN:
        return {"success": False, "message": "需要系统总管理员密码"}
    sub_name = data.get('sub_name', '').strip()
    if not sub_name or sub_name not in SUB_ADMINS:
        return {"success": False, "message": f"子管理员 [{sub_name}] 不存在"}
    permissions = data.get('permissions', {})
    try:
        await db.db_update_sub_admin_permissions(sub_name, permissions)
        if isinstance(SUB_ADMINS.get(sub_name), dict):
            SUB_ADMINS[sub_name]['permissions'] = permissions
        kicked = await kick_sub_admins(target_name=sub_name)
        msg = f"子管理员 [{sub_name}] 权限已更新"
        if kicked > 0:
            msg += f"，已踢出{kicked}个会话"
        return {"success": True, "message": msg}
    except Exception as e:
        return {"success": False, "message": f"更新失败: {e}"}

@app.post("/admin/api/sub_admin/delete")
async def admin_sub_admin_delete(request: Request):
    await asyncio.sleep(0.3)
    try:
        data = await request.json()
    except Exception:
        return {"success": False, "message": "请求无效"}
    is_valid, role, _ = verify_admin_password(data.get('admin_password', ''))
    if not is_valid or role != ROLE_SUPER_ADMIN:
        return {"success": False, "message": "系统总管理员密码错误"}
    if not verify_db_password(data.get('secondary_password', '')):
        return {"success": False, "message": "二级密码错误"}
    sub_name = data.get('sub_name', '').strip()
    if not sub_name or sub_name not in SUB_ADMINS:
        return {"success": False, "message": f"子管理员 [{sub_name}] 不存在"}
    await kick_sub_admins(target_name=sub_name)
    try:
        await db.db_delete_sub_admin(sub_name)
        SUB_ADMINS.pop(sub_name, None)
        return {"success": True, "message": f"子管理员 [{sub_name}] 已删除"}
    except Exception as e:
        return {"success": False, "message": f"删除失败: {e}"}

@app.post("/admin/api/sub_admin/kick")
async def admin_sub_admin_kick(request: Request):
    await asyncio.sleep(0.3)
    try:
        data = await request.json()
    except Exception:
        return {"success": False, "message": "请求无效"}
    is_valid, role, _ = verify_admin_password(data.get('admin_password', ''))
    if not is_valid or role != ROLE_SUPER_ADMIN:
        return {"success": False, "message": "系统总管理员密码错误"}
    sub_name = data.get('sub_name', '').strip()
    count = await kick_sub_admins(target_name=sub_name if sub_name else None)
    target = f"子管理员 [{sub_name}]" if sub_name else "所有子管理员"
    if count > 0:
        return {"success": True, "message": f"已踢出 {target} ({count} 个会话)"}
    return {"success": True, "message": f"{target} 当前没有在线会话"}


# --- 数据库管理API ---
@app.post("/admin/api/db/auth")
async def admin_db_auth(request: Request):
    try:
        data = await request.json()
        await asyncio.sleep(0.5)
        if verify_db_password(data.get('password', '')):
            token = generate_db_token()
            return {"success": True, "token": token, "expires_in": 1800}
        await asyncio.sleep(1)
        raise HTTPException(status_code=401, detail="二级密码错误")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=400, detail="验证请求无效")

@app.api_route("/admin/api/db/verify", methods=["GET", "POST"])
async def admin_db_verify(request: Request):
    token = request.headers.get("X-DB-Token")
    return {"valid": verify_db_token(token)}

@app.get("/admin/api/db/tables")
async def admin_db_tables(request: Request):
    check_db_auth(request)
    return await db.get_all_tables()

@app.get("/admin/api/db/schema/{table_name}")
async def admin_db_schema(table_name: str, request: Request):
    check_db_auth(request)
    return await db.get_table_schema(table_name)

@app.get("/admin/api/db/query/{table_name}")
async def admin_db_query(table_name: str, request: Request,
                         limit: int = 100, offset: int = 0,
                         order_by: str = None, order_desc: bool = True):
    check_db_auth(request)
    return await db.query_table(table_name, limit, offset, order_by, order_desc)

@app.post("/admin/api/db/insert/{table_name}")
async def admin_db_insert(table_name: str, request: Request):
    check_db_auth(request)
    data = await request.json()
    try:
        row_id = await db.insert_row(table_name, data)
        return {"success": True, "id": row_id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.put("/admin/api/db/update/{table_name}")
async def admin_db_update(table_name: str, request: Request):
    check_db_auth(request)
    data = await request.json()
    pk_column = data.pop('_pk_column', 'id')
    pk_value = data.pop('_pk_value', None)
    if pk_value is None:
        raise HTTPException(status_code=400, detail="缺少主键值")
    try:
        affected = await db.update_row(table_name, pk_column, pk_value, data)
        return {"success": True, "affected_rows": affected}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.delete("/admin/api/db/delete/{table_name}")
async def admin_db_delete_row(table_name: str, request: Request,
                              pk_column: str = "id", pk_value: str = None):
    check_db_auth(request)
    if pk_value is None:
        raise HTTPException(status_code=400, detail="缺少主键值")
    try:
        affected = await db.delete_row(table_name, pk_column, pk_value)
        return {"success": True, "affected_rows": affected}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/admin/api/db/sql")
async def admin_db_sql(request: Request):
    check_db_auth(request)
    data = await request.json()
    sql = data.get('sql', '')
    if not sql:
        raise HTTPException(status_code=400, detail="缺少SQL语句")
    try:
        result = await db.execute_sql(sql)
        return {"success": True, "result": result}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# --- 激活码管理代理 ---
async def proxy_license_request(method: str, path: str, params: dict = None, json_body: dict = None):
    url = f"{LICENSE_SERVER_URL}/api/v1{path}"
    if params is None:
        params = {}
    if 'admin_key' not in params:
        params['admin_key'] = LICENSE_ADMIN_KEY
    if json_body and 'admin_key' not in json_body:
        json_body['admin_key'] = LICENSE_ADMIN_KEY
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            if method == 'GET':
                resp = await client.get(url, params=params)
            else:
                resp = await client.post(url, json=json_body, params=params)
            return resp.json()
    except httpx.ConnectError:
        return {"error": True, "message": "无法连接激活码服务器"}
    except Exception as e:
        return {"error": True, "message": f"代理请求失败: {str(e)}"}

@app.get("/admin/api/license/statistics")
async def license_statistics(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', '/admin/statistics')

@app.get("/admin/api/license/list")
async def license_list(request: Request, limit: int = 50, offset: int = 0):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', '/admin/licenses', params={'limit': limit, 'offset': offset})

@app.get("/admin/api/license/info/{license_key}")
async def license_info(license_key: str, request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', f'/admin/license-info/{license_key}')

@app.post("/admin/api/license/create")
async def license_create(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    if not check_token_permission(token, 'license'):
        return {"error": True, "message": "您没有激活码管理权限"}
    data = await request.json()
    role = get_token_role(token)
    result = await proxy_license_request('POST', '/admin/create-license', json_body=data)
    if isinstance(result, dict) and not result.get('error'):
        lk = result.get('data', {}).get('license_key', '')
        detail = f"有效期{data.get('expiry_days', 365)}天"
        await db.add_license_log('create', lk, data.get('product_id'), data.get('billing_mode'), detail, role)
    return result

@app.post("/admin/api/license/revoke")
async def license_revoke(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    if not check_token_permission(token, 'license'):
        return {"error": True, "message": "您没有激活码管理权限"}
    data = await request.json()
    result = await proxy_license_request('POST', '/admin/revoke-license', json_body=data)
    if isinstance(result, dict) and not result.get('error'):
        await db.add_license_log('revoke', data.get('license_key'), detail='撤销激活码', operator=get_token_role(token))
    return result

@app.post("/admin/api/license/edit")
async def license_edit(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    if not check_token_permission(token, 'license'):
        return {"error": True, "message": "您没有激活码管理权限"}
    data = await request.json()
    return await proxy_license_request('POST', '/admin/edit-license', json_body=data)

@app.get("/admin/api/license/clients")
async def license_clients(request: Request, limit: int = 100, offset: int = 0):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', '/admin/clients', params={'limit': limit, 'offset': offset})

@app.get("/admin/api/license/clients/{client_id}")
async def license_client_detail(client_id: str, request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', f'/admin/clients/{client_id}')

@app.post("/admin/api/license/blacklist/add")
async def license_blacklist_add(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    if not check_token_permission(token, 'license'):
        return {"error": True, "message": "您没有激活码管理权限"}
    data = await request.json()
    return await proxy_license_request('POST', '/admin/blacklist', json_body=data)

@app.post("/admin/api/license/blacklist/remove")
async def license_blacklist_remove(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    if not check_token_permission(token, 'license'):
        return {"error": True, "message": "您没有激活码管理权限"}
    data = await request.json()
    return await proxy_license_request('POST', '/admin/blacklist/remove', json_body=data)

@app.get("/admin/api/license/blacklist")
async def license_blacklist_list(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', '/admin/blacklist')

@app.get("/admin/api/license/online-clients")
async def license_online_clients(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', '/admin/online-clients')

@app.post("/admin/api/license/disable-client")
async def license_disable_client(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    if get_token_role(token) != ROLE_SUPER_ADMIN:
        return {"error": True, "message": "仅系统总管理员可禁用客户端"}
    data = await request.json()
    return await proxy_license_request('POST', '/admin/disable-client', json_body=data)

@app.post("/admin/api/license/enable-client")
async def license_enable_client(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    if get_token_role(token) != ROLE_SUPER_ADMIN:
        return {"error": True, "message": "仅系统总管理员可启用客户端"}
    data = await request.json()
    return await proxy_license_request('POST', '/admin/enable-client', json_body=data)

@app.get("/admin/api/license/logs")
async def license_logs(request: Request, limit: int = 100, offset: int = 0):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', '/admin/logs', params={'limit': limit, 'offset': offset})

@app.get("/admin/api/license/local-logs")
async def license_local_logs(request: Request, action: str = None, limit: int = 50, offset: int = 0):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await db.get_license_logs(action=action or None, limit=limit, offset=offset)

@app.get("/admin/api/license/products")
async def license_products(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', '/admin/products')

@app.get("/admin/api/license/health")
async def license_health():
    return await proxy_license_request('GET', '/health')

@app.get("/admin/api/proxy_pool/status")
async def admin_proxy_pool_status():
    return {"config": {}, "pool": None, "available": False}


# --- 授权白名单管理 ---

@app.get("/admin/api/whitelist")
async def admin_whitelist_list(request: Request, limit: int = 100, offset: int = 0,
                                status: str = None, search: str = None):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    role = get_token_role(token)
    sub_name = get_token_sub_name(token)
    added_by = sub_name if role == ROLE_SUB_ADMIN and sub_name else None
    return await db.get_authorized_accounts(added_by=added_by, status=status or None,
                                             limit=limit, offset=offset, search=search or None)

@app.post("/admin/api/whitelist/add")
async def admin_whitelist_add(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    role = get_token_role(token)
    sub_name = get_token_sub_name(token)
    data = await request.json()
    username = data.get('username', '').strip()
    password = data.get('password', '')
    plan_type = data.get('plan_type', 'monthly')
    remark = data.get('remark', '')
    nickname = data.get('nickname', '').strip()
    if not username:
        return {"success": False, "message": "账号不能为空"}

    configs = await db.get_credit_config()
    config_map = {c['plan_type']: c for c in configs}
    plan = config_map.get(plan_type)
    if not plan:
        return {"success": False, "message": f"未知的套餐类型: {plan_type}"}
    credits_cost = plan['credits_cost']
    duration_days = plan['duration_days']

    if role == ROLE_SUPER_ADMIN:
        added_by = sub_name if sub_name and sub_name != '__super__' else 'super_admin'
    else:
        added_by = sub_name or 'unknown'
        try:
            await db.deduct_credits(added_by, credits_cost, related_username=username,
                                     description=f"授权账号[{username}] {plan['plan_name']}")
        except ValueError as e:
            return {"success": False, "message": str(e)}

    try:
        result = await db.add_authorized_account(
            username=username, password=password, added_by=added_by,
            plan_type=plan_type, credits_cost=credits_cost,
            duration_days=duration_days, remark=remark, nickname=nickname)
        return {"success": True, "message": f"账号 [{username}] 已授权 {plan['plan_name']}({duration_days}天)",
                "data": result}
    except Exception as e:
        if role != ROLE_SUPER_ADMIN:
            try:
                await db.topup_credits(added_by, credits_cost, operator='system',
                                        description=f"授权失败退回: {username}")
            except Exception:
                pass
        return {"success": False, "message": f"添加失败: {e}"}

@app.post("/admin/api/whitelist/renew")
async def admin_whitelist_renew(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    role = get_token_role(token)
    sub_name = get_token_sub_name(token)
    data = await request.json()
    username = data.get('username', '').strip()
    plan_type = data.get('plan_type', 'monthly')
    if not username:
        return {"success": False, "message": "账号不能为空"}

    configs = await db.get_credit_config()
    config_map = {c['plan_type']: c for c in configs}
    plan = config_map.get(plan_type)
    if not plan:
        return {"success": False, "message": f"未知的套餐类型: {plan_type}"}

    if role != ROLE_SUPER_ADMIN:
        admin_name = sub_name or 'unknown'
        try:
            await db.deduct_credits(admin_name, plan['credits_cost'], related_username=username,
                                     description=f"续期账号[{username}] {plan['plan_name']}")
        except ValueError as e:
            return {"success": False, "message": str(e)}

    try:
        result = await db.renew_authorized_account(
            username=username, plan_type=plan_type,
            credits_cost=plan['credits_cost'], duration_days=plan['duration_days'])
        if not result:
            return {"success": False, "message": f"账号 [{username}] 不存在"}
        return {"success": True, "message": f"账号 [{username}] 已续期 {plan['plan_name']}", "data": result}
    except Exception as e:
        if role != ROLE_SUPER_ADMIN:
            try:
                await db.topup_credits(sub_name or 'unknown', plan['credits_cost'],
                                        operator='system', description=f"续期失败退回: {username}")
            except Exception:
                pass
        return {"success": False, "message": f"续期失败: {e}"}

@app.post("/admin/api/whitelist/delete")
async def admin_whitelist_delete(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    data = await request.json()
    username = data.get('username', '').strip()
    if not username:
        return {"success": False, "message": "账号不能为空"}
    ok = await db.delete_authorized_account(username)
    if ok:
        return {"success": True, "message": f"账号 [{username}] 已删除（积分不退还）"}
    return {"success": False, "message": f"账号 [{username}] 不存在"}

@app.get("/admin/api/whitelist/expiring")
async def admin_whitelist_expiring(request: Request, days: int = 7):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    role = get_token_role(token)
    sub_name = get_token_sub_name(token)
    added_by = sub_name if role == ROLE_SUB_ADMIN and sub_name else None
    return await db.get_expiring_accounts(days=days, added_by=added_by)

@app.post("/admin/api/whitelist/toggle_persist")
async def admin_whitelist_toggle_persist(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    data = await request.json()
    username = data.get('username', '').strip()
    enabled = bool(data.get('enabled', False))
    if not username:
        return {"success": False, "message": "账号不能为空"}
    try:
        ok = await db.toggle_persistent_login(username, enabled)
        if ok:
            return {"success": True, "message": f"账号 [{username}] 强化登录已{'开启' if enabled else '关闭'}"}
        return {"success": False, "message": f"账号 [{username}] 不存在或状态异常"}
    except Exception as e:
        logger.error(f"[Whitelist] toggle_persist 失败: {e}")
        return {"success": False, "message": f"操作失败: {str(e)}"}


# --- 积分管理 ---

@app.get("/admin/api/credits/config")
async def admin_credits_config():
    return await db.get_credit_config()

@app.post("/admin/api/credits/config")
async def admin_credits_config_update(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    if get_token_role(token) != ROLE_SUPER_ADMIN:
        return {"success": False, "message": "仅总管理员可修改积分定价"}
    data = await request.json()
    plan_type = data.get('plan_type', '').strip()
    plan_name = data.get('plan_name', '').strip()
    credits_cost = int(data.get('credits_cost', 0))
    duration_days = int(data.get('duration_days', 0))
    if not plan_type or not plan_name or credits_cost <= 0 or duration_days <= 0:
        return {"success": False, "message": "参数无效"}
    await db.update_credit_config(plan_type, plan_name, credits_cost, duration_days)
    return {"success": True, "message": f"定价 [{plan_name}] 已保存"}

@app.delete("/admin/api/credits/config/{plan_type}")
async def admin_credits_config_delete(plan_type: str, request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    if get_token_role(token) != ROLE_SUPER_ADMIN:
        return {"success": False, "message": "仅总管理员可删除积分定价"}
    ok = await db.delete_credit_config(plan_type)
    return {"success": ok, "message": "已删除" if ok else "不存在"}

@app.get("/admin/api/credits/overview")
async def admin_credits_overview(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    if get_token_role(token) != ROLE_SUPER_ADMIN:
        return {"success": False, "message": "仅总管理员可查看"}
    return await db.get_all_sub_admin_credits()

@app.get("/admin/api/credits/balance")
async def admin_credits_balance(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    role = get_token_role(token)
    sub_name = get_token_sub_name(token)
    if role == ROLE_SUPER_ADMIN:
        return {"balance": -1, "unlimited": True}
    balance = await db.get_sub_admin_credits(sub_name)
    return {"balance": balance, "unlimited": False}

@app.post("/admin/api/credits/topup")
async def admin_credits_topup(request: Request):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    if get_token_role(token) != ROLE_SUPER_ADMIN:
        return {"success": False, "message": "仅总管理员可充值积分"}
    data = await request.json()
    admin_name = data.get('admin_name', '').strip()
    amount = int(data.get('amount', 0))
    description = data.get('description', '')
    if not admin_name or admin_name not in SUB_ADMINS:
        return {"success": False, "message": f"子管理员 [{admin_name}] 不存在"}
    if amount <= 0:
        return {"success": False, "message": "充值金额必须大于0"}
    try:
        result = await db.topup_credits(admin_name, amount, operator='super_admin',
                                         description=description or f"总管理充值{amount}积分")
        return {"success": True, "message": f"已给 [{admin_name}] 充值 {amount} 积分，余额: {result['balance']}",
                "data": result}
    except Exception as e:
        return {"success": False, "message": f"充值失败: {e}"}

@app.get("/admin/api/credits/transactions")
async def admin_credits_transactions(request: Request, admin_name: str = None,
                                      limit: int = 50, offset: int = 0):
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    role = get_token_role(token)
    sub_name = get_token_sub_name(token)
    if role == ROLE_SUPER_ADMIN:
        query_name = admin_name or None
    else:
        query_name = sub_name
    return await db.get_credit_transactions(admin_name=query_name, limit=limit, offset=offset)


# --- WebSocket ---
@app.websocket("/admin/ws")
async def admin_websocket(websocket: WebSocket):
    await ws_manager.connect(websocket)
    sub_name = None
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                msg_type = msg.get('type')
                if msg_type == 'auth':
                    token = msg.get('token', '')
                    role = get_token_role(token)
                    if role == ROLE_SUB_ADMIN:
                        sub_name = get_token_sub_name(token)
                        if sub_name:
                            ws_manager.register_sub_admin(sub_name, websocket)
                    elif role == ROLE_SUPER_ADMIN:
                        sub_name = '__super__'
                        ws_manager.register_sub_admin(sub_name, websocket)
                elif msg_type == 'heartbeat':
                    if sub_name:
                        ws_manager.heartbeat_sub_admin(sub_name)
            except Exception:
                pass
    except (WebSocketDisconnect, Exception):
        ws_manager.disconnect(websocket)

@app.websocket("/chat/ws")
async def chat_websocket(websocket: WebSocket):
    await websocket.accept()
    username = websocket.query_params.get('username', 'visitor')
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get('type')
            if msg_type == 'online':
                await online_manager.user_online(
                    data.get('username', username), websocket,
                    data.get('page', ''), data.get('userAgent', ''))
                username = data.get('username', username)
                history = online_manager.get_messages(username)
                if history:
                    await websocket.send_json({'type': 'history', 'messages': history})
            elif msg_type == 'heartbeat':
                online_manager.update_heartbeat(username)
                hp = data.get('page', '')
                if hp and username in online_manager.users:
                    online_manager.users[username]['page'] = hp
            elif msg_type == 'user_message':
                content = data.get('content', '')
                if content:
                    online_manager.save_user_message(username, content)
                    await ws_manager.broadcast({'type': 'chat_message', 'data': {
                        'username': username, 'content': content,
                        'time': datetime.now().strftime('%H:%M:%S'), 'is_admin': False}})
            elif msg_type == 'offline':
                online_manager.user_offline(username)
                await ws_manager.broadcast({'type': 'user_offline', 'data': {'username': username}})
                break
    except (WebSocketDisconnect, Exception):
        online_manager.user_offline(username)


# --- 管理后台页面 ---
@app.get("/admin", response_class=HTMLResponse)
@app.get("/admin/", response_class=HTMLResponse)
async def admin_page():
    html_path = os.path.join(os.path.dirname(__file__), "admin.html")
    if os.path.exists(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            content = f.read()
        return HTMLResponse(content=content, headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache", "Expires": "0"
        })
    return "<h1>管理页面未找到</h1>"

@app.get("/chat/widget.js")
async def chat_widget_js():
    js_path = os.path.join(os.path.dirname(__file__), "chat_widget.js")
    if os.path.exists(js_path):
        with open(js_path, "r", encoding="utf-8") as f:
            return Response(content=f.read(), media_type="application/javascript")
    return Response(content="// not found", media_type="application/javascript")

@app.get("/manifest.json")
async def pwa_manifest():
    path = os.path.join(os.path.dirname(__file__), "manifest.json")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return Response(content=f.read(), media_type="application/manifest+json")
    return Response(content="{}", media_type="application/manifest+json")

@app.get("/sw.js")
async def pwa_sw():
    path = os.path.join(os.path.dirname(__file__), "sw.js")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return Response(content=f.read(), media_type="application/javascript",
                          headers={"Service-Worker-Allowed": "/"})
    return Response(content="// not found", media_type="application/javascript")

@app.get("/admin/api/pwa-sw")
async def pwa_sw_api():
    """通过API路径提供SW（绕过CDN对.js文件的拦截）"""
    path = os.path.join(os.path.dirname(__file__), "sw.js")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return Response(content=f.read(), media_type="application/javascript",
                          headers={"Service-Worker-Allowed": "/"})

@app.get("/admin/api/pwa-manifest")
async def pwa_manifest_api():
    """通过API路径提供manifest（绕过CDN拦截）"""
    path = os.path.join(os.path.dirname(__file__), "manifest.json")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            import json
            data = json.loads(f.read())
            # 图标路径换成API路径（绕过CDN）
            data.pop('theme_color', None)  # 不设置theme_color，保持浏览器默认
            data['icons'] = [
                {'src': '/admin/api/pwa-icon/192', 'sizes': '192x192', 'type': 'image/png', 'purpose': 'any'},
                {'src': '/admin/api/pwa-icon/512', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any'},
                {'src': '/admin/api/pwa-icon-maskable/192', 'sizes': '192x192', 'type': 'image/png', 'purpose': 'maskable'},
                {'src': '/admin/api/pwa-icon-maskable/512', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'},
            ]
            return Response(content=json.dumps(data), media_type="application/manifest+json")
    return Response(content="{}", media_type="application/manifest+json")

@app.get("/admin/api/pwa-icon/{size}")
async def pwa_icon_api(size: int):
    """通过API路径提供图标（绕过CDN对.png文件的拦截）"""
    if size not in (192, 512):
        size = 192
    path = os.path.join(os.path.dirname(__file__), f"pwa-icon-{size}.png")
    if os.path.exists(path):
        with open(path, "rb") as f:
            return Response(content=f.read(), media_type="image/png")
    return Response(status_code=404)

@app.get("/admin/api/pwa-icon-maskable/{size}")
async def pwa_icon_maskable_api(size: int):
    """Maskable图标（深色背景+安全区内Logo，适配Android自适应图标）"""
    if size not in (192, 512):
        size = 192
    path = os.path.join(os.path.dirname(__file__), f"pwa-icon-maskable-{size}.png")
    if os.path.exists(path):
        with open(path, "rb") as f:
            return Response(content=f.read(), media_type="image/png")
    return Response(status_code=404)

@app.get("/admin/api/pwa-widget")
async def pwa_widget_api():
    """通过API路径提供widget.js（绕过CDN对.js文件的拦截）"""
    js_path = os.path.join(os.path.dirname(__file__), "chat_widget.js")
    if os.path.exists(js_path):
        with open(js_path, "r", encoding="utf-8") as f:
            return Response(content=f.read(), media_type="application/javascript")
    return Response(content="// not found", media_type="application/javascript")

@app.get("/pwa-icon-{size}.png")
async def pwa_icon(size: int):
    """提供PWA图标（本地PNG文件）"""
    if size not in (192, 512):
        size = 192
    path = os.path.join(os.path.dirname(__file__), f"pwa-icon-{size}.png")
    if os.path.exists(path):
        with open(path, "rb") as f:
            return Response(content=f.read(), media_type="image/png")
    return Response(status_code=404)


# ===== 启动 =====
def main():
    """启动透明代理服务器"""
    print("=" * 60)
    print("  AK 透明代理服务器")
    print("=" * 60)
    print(f"  监听地址: http://{PROXY_HOST}:{PROXY_PORT}")
    print(f"  API目标:  {AKAPI_URL}")
    print(f"  中央监控: {MONITOR_SERVER or '未配置'}")
    print(f"  本地封禁: {'启用' if ENABLE_LOCAL_BAN else '禁用'}")
    print(f"  PostgreSQL: {DB_HOST}:{DB_PORT}/{DB_NAME} (pool={DB_MIN_POOL}-{DB_MAX_POOL})")
    print("=" * 60)
    print()
    print("  使用方式:")
    print(f"  将游戏客户端的API地址改为: http://你的IP:{PROXY_PORT}/RPC/")
    print(f"  或本机使用: http://127.0.0.1:{PROXY_PORT}/RPC/")
    print()
    print(f"  状态页面: http://127.0.0.1:{PROXY_PORT}/")
    print(f"  状态API:  http://127.0.0.1:{PROXY_PORT}/api/status")
    print("=" * 60)
    
    uvicorn.run(app, host=PROXY_HOST, port=PROXY_PORT, log_level="warning")


if __name__ == "__main__":
    main()
