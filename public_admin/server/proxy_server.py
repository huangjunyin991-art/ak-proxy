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

import re

import logging

from urllib.parse import parse_qs, urlsplit, urlencode, urlunsplit

from logging.handlers import RotatingFileHandler

from datetime import datetime

from typing import Any, Optional



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



SERVER_DIR = os.path.dirname(__file__)
PUBLIC_ADMIN_DIR = os.path.dirname(SERVER_DIR)
FRONTEND_DIR = os.path.join(PUBLIC_ADMIN_DIR, "frontend")
FRONTEND_HOST_DIR = os.path.join(FRONTEND_DIR, "host")
FRONTEND_PAGES_DIR = os.path.join(FRONTEND_DIR, "pages")
PLUGINS_DIR = os.path.join(PUBLIC_ADMIN_DIR, "plugins")



# 加载配置

sys.path.insert(0, PUBLIC_ADMIN_DIR)

try:

    from .config import *

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


try:

    ADMIN_AK_TRACE_ENABLED

except NameError:

    ADMIN_AK_TRACE_ENABLED = False



# 数据库模块

from . import database_pg as db

from plugins.remote_assist.server import remote_assist

from plugins.remote_voice.server import remote_voice, VoiceSessionStatus

from plugins.remote_voice.server.signal_bus import remote_voice_signal_bus

from plugins.remote_voice.server.types import COUNTED_VOICE_SESSION_STATUSES

from plugins.remote_assist.server.types import AssistConsentStatus, AssistRole

# 出口IP调度模块

from .outbound_dispatcher import dispatcher, ace_sell_dispatcher, OutboundExit

if SOCKS5_EXITS:
    dispatcher.configure_from_list(SOCKS5_EXITS)

dispatcher.MAX_LOGIN_PER_MIN = LOGIN_RATE_PER_EXIT


def _restore_dispatcher_exits_from_disk() -> int:

    from . import singbox_manager as sbm

    config_file = os.path.join(PUBLIC_ADMIN_DIR, "dispatcher_exits.json")

    nodes_to_restore: list[dict[str, Any]] = []

    base_port = 10001

    try:

        if os.path.exists(config_file):

            with open(config_file, "r", encoding="utf-8") as f:

                payload = json.load(f)

            if isinstance(payload, dict):

                raw_nodes = payload.get("nodes")

                raw_base_port = payload.get("base_port")

                if isinstance(raw_nodes, list):

                    nodes_to_restore = [item for item in raw_nodes if isinstance(item, dict)]

                try:

                    base_port = max(1, int(raw_base_port or 10001))

                except Exception:

                    base_port = 10001

        if not nodes_to_restore:

            saved_nodes = sbm.load_saved_nodes()

            if isinstance(saved_nodes, list):

                nodes_to_restore = [item for item in saved_nodes if isinstance(item, dict)]

        if not nodes_to_restore:

            logger.info("[Dispatcher] 启动时未发现可恢复的隧道出口配置")

            return 0

        while len(dispatcher.exits) > 1:

            dispatcher.exits.pop()

        for idx, node in enumerate(nodes_to_restore):

            port = base_port + idx

            name = node.get("display_name") or node.get("name") or f"node_{idx}"

            dispatcher.add_socks5(str(name), port)

        logger.info(f"[Dispatcher] 启动恢复 {len(nodes_to_restore)} 个隧道出口 (base_port={base_port})")

        return len(nodes_to_restore)

    except Exception as e:

        logger.warning(f"[Dispatcher] 启动恢复出口失败: {e}")

        return 0

# 通知模块

from plugins.notification.server.notification_router import create_notification_router

from plugins.notification.server.notification_service import NotificationService

# ===== 日志配置 =====

logger = logging.getLogger("TransparentProxy")

logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))

formatter = logging.Formatter('[%(asctime)s] [%(levelname)s] %(message)s', datefmt='%Y-%m-%d %H:%M:%S')



if LOG_TO_CONSOLE:

    ch = logging.StreamHandler(sys.stdout)

    ch.setFormatter(formatter)

    logger.addHandler(ch)



if LOG_TO_FILE:

    log_path = os.path.join(PUBLIC_ADMIN_DIR, LOG_FILE)

    fh = RotatingFileHandler(

        log_path, maxBytes=10*1024*1024*1024, backupCount=3, encoding='utf-8'

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

                          is_login: bool = False,

                          selected_exit=None,

                          force_direct: bool = False) -> httpx.Response:

    """转发请求到真实API服务器（通过出口调度器选择出口IP）"""

    url = AKAPI_URL + api_path

    # 从nginx传递的头中提取用户真实IP

    real_ip = client_ip or headers.get("x-real-ip", "") or headers.get("x-forwarded-for", "").split(",")[0].strip()

    fwd_headers = {

        "User-Agent": headers.get("user-agent", ""),

        "Content-Type": content_type or "application/json",

        "Accept": headers.get("accept", "*/*"),

    }

    if headers.get("cookie"):

        fwd_headers["Cookie"] = headers.get("cookie", "")

    if real_ip:

        fwd_headers["X-Real-IP"] = real_ip

        fwd_headers["X-Forwarded-For"] = real_ip



    # 通过调度器选择出口

    if force_direct:

        exit_obj = _get_direct_exit()

    else:

        exit_obj = selected_exit or _select_forward_exit(api_path, is_login=is_login)

    logger.debug(f"[Forward] {api_path} -> 出口[{exit_obj.name}]")



    if is_login:

        try:

            result = await dispatcher.forward(

                exit_obj, method, url, fwd_headers,

                content_type=content_type, params=params,

                raw_body=raw_body, timeout=REQUEST_TIMEOUT

            )

            exit_obj.confirm_login()

            return result

        except Exception:

            exit_obj.cancel_login()

            raise

    return await dispatcher.forward(

        exit_obj, method, url, fwd_headers,

        content_type=content_type, params=params,

        raw_body=raw_body, timeout=REQUEST_TIMEOUT

    )



def _select_forward_exit(api_path: str, is_login: bool = False, preferred_exit_name: str = ""):

    preferred = (preferred_exit_name or "").strip()

    if preferred and api_path != "ACE_Sell":

        for ex in getattr(dispatcher, "exits", []):

            if ex.name != preferred:

                continue

            if (ex.healthy or ex.is_direct) and not ex.is_frozen:

                ex.record_request()

                return ex

            logger.warning(f"[ForwardExitFallback] api={api_path} preferred={preferred} reason=unavailable")

            break

    if is_login:

        return dispatcher.pick_login_exit()

    if api_path == "ACE_Sell":

        return ace_sell_dispatcher.acquire()

    return dispatcher.pick_api_exit()


def _get_direct_exit() -> OutboundExit:

    exits = getattr(dispatcher, "exits", []) or []

    if exits:

        return exits[0]

    return OutboundExit("direct", None)


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

    referer = request.headers.get("referer", "")

    

    logger.info(f"[Login] 账号={account}, IP={client_ip}")

    

    # 本地封禁检查（内存集合，启动时已从DB预加载）

    if ENABLE_LOCAL_BAN:

        if account.lower() in stats.banned_accounts or client_ip in stats.banned_ips:

            logger.warning(f"[Login] 封禁拦截: account={account}, IP={client_ip}")

            return JSONResponse({"Error": True, "Msg": "您的账号或IP已被封禁"})

    

    # 白名单检查

    persistent_login = False

    try:

        whitelist_open_to_all = await db.get_whitelist_global_status()

        if whitelist_open_to_all:

            logger.info(f"[Login] 公开访问模式，跳过白名单检查: {account}")

        else:

            auth_info = await db.check_authorized(account)

            if not auth_info:

                logger.info(f"[Login] 白名单拦截(未授权): {account}")

                return JSONResponse({"Error": True, "Msg": "未获得访问权限，请联系上属老师获取权限或使用ak2018，ak928登录！"})

            if auth_info['expire_time'] < datetime.now():

                logger.info(f"[Login] 白名单拦截(已过期): {account}")

                return JSONResponse({"Error": True, "Msg": "您的访问权限已到期，请联系上属老师续期或使用ak2018，ak928登录！"})

            persistent_login = auth_info.get('persistent_login', False)

            logger.info(f"[Login] 白名单生效，允许登录: {account}")

    except Exception as e:

        logger.warning(f"[Login] 白名单检查异常: {e}，按公开访问模式放行")



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

        cached = _cache_ak_auth(account, password, result, response.headers)

        try:

            await db.save_ak_auth_state(

                account,

                userkey=cached.get("userkey", ""),

                cookies=cached.get("cookies", {}),

                login_payload=cached.get("login_result", {}),

                ttl_seconds=_BROWSE_SESSION_TTL,

            )

        except Exception as e:

            logger.warning(f"[Login] AK登录态持久化失败: {e}")

        admin_bs_id, admin_session, admin_bs_source = _resolve_browse_session(

            request,

            preferred_username=account,

            source_order=("cookie",),

        )

        admin_referer = request.headers.get("referer", "")

        if admin_session:

            try:

                await _apply_cached_auth_to_browse_session(admin_session, cached, result, account, password)

                logger.warning(f"[BrowseLoginSession] account={account} bs={admin_bs_id} source={admin_bs_source} referer={admin_referer} cookies={len(admin_session.get('cookies', {}))}")

            except Exception as e:

                logger.warning(f"[BrowseLoginSession] 持久化失败 account={account} bs={admin_bs_id} source={admin_bs_source} referer={admin_referer}: {e}")

    else:

        stats.login_fail += 1

        logger.info(f"[Login] 登录失败: {account}, Msg={result.get('Msg', '')}")

    if "/admin/ak-web/" in referer or "/admin/ak-site/" in referer:

        logger.warning(f"[IframeLoginApi] route=/RPC/Login phase=response account={account} success={int(is_success)} referer={referer} body_head={json.dumps(result, ensure_ascii=False)[:200]}")

    

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

    asyncio.create_task(ws_manager.broadcast({

        "type": "new_login",

        "data": {

            "username": account,

            "ip": client_ip,

            "status": "success" if is_success else "failed",

            "msg": result.get("Msg", ""),

            "time": datetime.now().strftime('%H:%M:%S'),

            "assets": report_data.get("assets"),

        }

    }))

    resp = JSONResponse(result)
    resp = _mirror_upstream_set_cookies(resp, response.headers)

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

            # 公开版本：保存所有用户的资产数据

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

            asyncio.create_task(ws_manager.broadcast({

                "type": "asset_update",

                "data": {

                    "username": username,

                    "time": datetime.now().strftime('%H:%M:%S'),

                    "assets": report_data["assets"],

                }

            }))

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

    referer = request.headers.get("referer", "")

    fetch_dest = request.headers.get("sec-fetch-dest", "")

    accept = request.headers.get("accept", "")

    cookie_bs = (request.cookies.get(_BROWSE_SESSION_COOKIE) or "").strip()

    

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

    trace_rpc_paths = {
        "public_ace",
        "public_ep_sellrecords1",
        "public_ep_sellrecords2",
        "public_ep_sellrecords3",
    }
    normalized_path = path.strip("/").lower()
    if normalized_path in trace_rpc_paths:
        logger.warning(
            f"[RpcInput/{path}] referer={referer} cookie_bs={cookie_bs or '-'} "
            f"key={str(params.get('key') or params.get('Key') or '')[:32]} "
            f"user_id={str(params.get('UserID') or params.get('userid') or params.get('Id') or '')} "
            f"account={params.get('account') or ''} type={params.get('type') or ''} "
            f"content_type={content_type or '-'}"
        )

    logger.debug(f"[RPC/{path}] 转发请求")

    

    try:

        response = await forward_request(

            request.method, path, content_type, params, raw_body, dict(request.headers),

            client_ip=client_ip

        )

        try:

            result = response.json()
            if "/admin/ak-web/" in referer:
                logger.warning(f"[IframeRPCLeak] path={path} status={response.status_code} body_head={json.dumps(result, ensure_ascii=False)[:200]}")

            proxy_response = JSONResponse(content=result, status_code=response.status_code)
            return _mirror_upstream_set_cookies(proxy_response, response.headers)

        except Exception:

            proxy_response = JSONResponse(content=response.text, status_code=response.status_code)
            return _mirror_upstream_set_cookies(proxy_response, response.headers)

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





@app.post("/api/dispatcher/add")

async def api_dispatcher_add(request: Request):

    """添加一个SOCKS5出口"""

    data = await request.json()

    name = data.get("name", "").strip()

    port = data.get("port")

    if not name or not port:

        return {"success": False, "message": "需要 name 和 port"}

    try:

        port = int(port)

    except (ValueError, TypeError):

        return {"success": False, "message": "port 必须为整数"}

    idx = dispatcher.add_socks5(name, port)

    return {"success": True, "index": idx, "message": f"已添加出口 #{idx}: {name}"}





@app.post("/api/dispatcher/remove")

async def api_dispatcher_remove(request: Request):

    """移除一个出口"""

    data = await request.json()

    index = data.get("index")

    if index is None:

        return {"success": False, "message": "需要 index"}

    try:

        index = int(index)

    except (ValueError, TypeError):

        return {"success": False, "message": "index 必须为整数"}

    if dispatcher.remove_exit(index):

        return {"success": True, "message": f"已移除出口 #{index}"}

    return {"success": False, "message": f"无法移除出口 #{index} (不存在或为直连)"}





@app.post("/api/dispatcher/detect_ips")

async def api_dispatcher_detect_ips():

    """手动触发所有出口的IP检测"""

    await dispatcher.detect_all_ips()

    return {"success": True, "message": "IP检测完成", "exits": [

        {"index": i, "name": ex.name, "exit_ip": ex.exit_ip}

        for i, ex in enumerate(dispatcher.exits)

    ]}





@app.post("/api/dispatcher/rate_limit")
async def api_dispatcher_rate_limit(request: Request):
    """设置指定出口的速率限制（req/min），0=不限速"""
    data = await request.json()
    index = data.get("index")
    limit = data.get("limit", 0)
    if index is None:
        return {"success": False, "message": "需要 index"}
    ok = dispatcher.set_rate_limit(int(index), int(limit))
    msg = f"出口 #{index} 限速已设置: {limit or '不限速'}" if limit else f"出口 #{index} 限速已解除"
    return {"success": ok, "message": msg if ok else f"出口 #{index} 不存在"}


@app.post("/api/dispatcher/max_login")
async def api_dispatcher_max_login(request: Request):
    """动态调整每出口每分钟最大登录次数"""
    data = await request.json()
    value = data.get("value", 10)
    ok = dispatcher.set_max_login_per_min(int(value))
    return {"success": ok, "message": f"登录限额已调整为 {value}/min" if ok else "值无效（须≥1）"}


@app.post("/api/dispatcher/start_singbox")
async def api_dispatcher_start_singbox():
    """手动启动 sing-box 服务"""
    from . import singbox_manager as sbm
    try:
        sbm.reload_service()
        return {"success": True, "message": "sing-box 已启动/重载"}
    except Exception as e:
        return {"success": False, "message": f"启动失败: {str(e)}"}


@app.get("/api/dispatcher/events")
async def api_dispatcher_events(exit_name: str = None, status_code: int = None,
                                 hours: int = 24, limit: int = 200):
    """查询403/429风控事件，支持按出口名/状态码/时间范围过滤"""
    try:
        rows = await db.query_exit_events(exit_name=exit_name, status_code=status_code,
                                          hours=hours, limit=limit)
        return {"events": rows, "total": len(rows)}
    except Exception as e:
        return {"events": [], "total": 0, "error": str(e)}


@app.get("/api/dispatcher/logs/{index}")

async def api_dispatcher_exit_logs(index: int):

    """获取指定出口的错误日志"""

    logs = dispatcher.get_exit_logs(index)

    name = dispatcher.exits[index].name if 0 <= index < len(dispatcher.exits) else "unknown"

    return {"index": index, "name": name, "logs": logs}





@app.post("/api/dispatcher/parse_sub")

async def api_dispatcher_parse_sub(request: Request, response: Response):

    """解析订阅: 支持URL自动获取、文本解析或JSON配置提取"""

    from .sub_parser import fetch_subscription, parse_subscription_text
    import json as json_lib

    PUBLIC_ADMIN_PARSE_SUB_SOURCE = "public_admin-parse-sub-v1"

    response.headers["X-AK-Parse-Sub-Source"] = PUBLIC_ADMIN_PARSE_SUB_SOURCE

    try:
        data = await request.json()
    except Exception:
        return {"error": "请求体不是合法 JSON"}

    url = data.get("url", "").strip()
    text = data.get("text", "").strip()
    json_config = data.get("json", "").strip()

    # text 输入框误粘 URL 时自动识别
    if not url and text and (text.startswith("http://") or text.startswith("https://")):
        url, text = text, ""

    try:
        if url:
            result = fetch_subscription(url)
        elif text:
            result = parse_subscription_text(text)
        elif json_config:
            # 从JSON配置中提取节点
            try:
                config = json_lib.loads(json_config)
                outbounds = config.get("outbounds", [])
                nodes = []
                servers = {}
                regions = {}
                for ob in outbounds:
                    if ob.get("type") in ["anytls", "vless", "hysteria2", "vmess", "trojan", "shadowsocks", "ss"]:
                        tag = ob.get("tag", "Unknown")
                        server = ob.get("server", "")
                        port = ob.get("server_port", 0)
                        region_code = "UN"
                        region_label = "未知"
                        tag_lower = tag.lower()
                        if "香港" in tag or "hk" in tag_lower or "hong" in tag_lower:
                            region_code, region_label = "HK", "香港"
                        elif "新加坡" in tag or "sg" in tag_lower or "singapore" in tag_lower:
                            region_code, region_label = "SG", "新加坡"
                        elif "日本" in tag or "jp" in tag_lower or "japan" in tag_lower:
                            region_code, region_label = "JP", "日本"
                        elif "美国" in tag or "us" in tag_lower or "america" in tag_lower:
                            region_code, region_label = "US", "美国"
                        elif "台湾" in tag or "tw" in tag_lower or "taiwan" in tag_lower:
                            region_code, region_label = "TW", "台湾"
                        nodes.append({"name": tag, "type": ob.get("type"), "server": server,
                                      "port": port, "region_code": region_code,
                                      "region_label": region_label, "outbound_config": ob})
                        if server not in servers:
                            servers[server] = []
                        servers[server].append(len(nodes) - 1)
                        if region_code not in regions:
                            regions[region_code] = {"label": region_label, "count": 0}
                        regions[region_code]["count"] += 1
                result = {"format": "singbox_json", "node_count": len(nodes),
                          "unique_servers": len(servers), "nodes": nodes,
                          "servers": servers, "regions": regions}
            except Exception as e:
                return {"error": f"JSON解析失败: {str(e)}"}
        else:
            return {"error": "请输入订阅链接、订阅内容或JSON配置"}
    except Exception as e:
        logger.error(f"[ParseSub] 解析异常: {e}")
        return {"error": f"解析失败: {str(e)}"}

    return result





@app.post("/api/dispatcher/apply_sub")

async def api_dispatcher_apply_sub(request: Request):

    """

    一键应用订阅: 解析 → 生成sing-box配置 → 写盘 → 重载服务 → 注册出口到dispatcher

    前端批量添加时调用此接口，实现热重载生效

    """

    from . import singbox_manager as sbm

    from .sub_parser import fetch_subscription, parse_subscription_text



    data = await request.json()

    url = data.get("url", "").strip()

    text = data.get("text", "").strip()
    
    nodes = data.get("nodes")  # 直接传入的节点列表（来自JSON解析）
    
    servers_dict = data.get("servers")  # 服务器分组

    selected_servers = data.get("selected_servers", [])  # [{server, name}] (旧格式，兼容保留)
    selected_node_indices = data.get("selected_node_indices")  # [int] 按节点索引选择（新格式）

    base_port = int(data.get("base_port", 10001))

    # text 输入框误粘 URL 时自动识别
    if not url and text and (text.startswith("http://") or text.startswith("https://")):
        url, text = text, ""

    # 1) 解析订阅或使用已解析的节点

    if url:

        parsed = fetch_subscription(url)

    elif text:

        parsed = parse_subscription_text(text)
    
    elif nodes and servers_dict:
        # 使用前端已解析的节点（来自JSON配置）
        parsed = {
            "nodes": nodes,
            "servers": servers_dict,
            "format": data.get("format", "direct")
        }

    else:

        return {"success": False, "message": "需要 url、text 或 nodes 参数"}



    if parsed.get("error"):

        return {"success": False, "message": parsed["error"]}



    if not parsed.get("nodes"):

        return {"success": False, "message": "未解析到任何节点"}



    # 2) 筛选节点：每个节点作为独立出口（同一服务器域名下的多端口节点各自占一个 SOCKS5 端口）

    all_nodes = parsed["nodes"]

    servers_map = parsed.get("servers", {})



    if selected_node_indices is not None:

        # 新格式：前端按节点索引选择

        nodes_to_add = []

        for idx in selected_node_indices:

            if 0 <= idx < len(all_nodes):

                node = dict(all_nodes[idx])

                node["display_name"] = node.get("name") or f"{node.get('region_label', '')}节点{len(nodes_to_add)+1}"

                nodes_to_add.append(node)

    elif selected_servers:

        # 旧格式兑容：前端指定了服务器列表，每个服务器取其下所有节点

        selected_set = {s["server"] for s in selected_servers}

        nodes_to_add = []

        names_map = {s["server"]: s["name"] for s in selected_servers}

        for srv in selected_set:

            indices = servers_map.get(srv, [])

            for j, idx in enumerate(indices):

                node = dict(all_nodes[idx])

                base_name = names_map.get(srv, node.get("name", srv))

                node["display_name"] = base_name if len(indices) == 1 else f"{base_name}_{j+1:02d}"

                nodes_to_add.append(node)

    else:

        # 没指定就全部添加，每个节点作为独立出口

        nodes_to_add = []

        for i, node in enumerate(all_nodes):

            node_copy = dict(node)

            node_copy["display_name"] = node.get("name") or f"{node.get('region_label', '')}节点{i+1}"

            nodes_to_add.append(node_copy)



    if not nodes_to_add:

        return {"success": False, "message": "筛选后无有效节点"}



    # 3) 生成 sing-box 配置 + 写盘 + 重载

    apply_result = sbm.apply_nodes(nodes_to_add, base_port)



    # 4) 清除旧的隧道出口 (保留#0直连)，注册新出口到 dispatcher

    while len(dispatcher.exits) > 1:

        dispatcher.exits.pop()



    added_exits = []

    for i, node in enumerate(nodes_to_add):

        port = base_port + i

        name = node.get("display_name", node.get("name", f"node_{i}"))

        idx = dispatcher.add_socks5(name, port)

        added_exits.append({"index": idx, "name": name, "port": port})



    logger.info(f"[Dispatcher] 订阅热重载完成: {len(added_exits)} 个出口已注册")

    
    # 持久化节点配置，重启自动恢复
    try:
        exits_config = {
            "nodes": nodes_to_add,
            "base_port": base_port,
            "timestamp": time.time()
        }
        config_file = os.path.join(PUBLIC_ADMIN_DIR, "dispatcher_exits.json")
        with open(config_file, "w", encoding="utf-8") as f:
            json.dump(exits_config, f, ensure_ascii=False, indent=2)
        logger.info(f"[Dispatcher] 节点配置已保存: {config_file}")
    except Exception as e:
        logger.warning(f"[Dispatcher] 保存节点配置失败: {e}")

    # 更新数据库中的订阅组记录
    if apply_result["success"]:
        try:
            import uuid
            from datetime import datetime as _dt
            await db.clear_all_subscription_groups()
            group_id = str(uuid.uuid4())
            source_type = "url" if url else ("text" if text else "json")
            source_url = url or ""
            group_name = f"订阅导入 {_dt.now().strftime('%m-%d %H:%M')}"
            await db.create_subscription_group(
                group_id=group_id,
                name=group_name,
                source_type=source_type,
                source_url=source_url,
                total_servers=len(nodes_to_add),
                created_by='admin',
                notes=''
            )
            logger.info(f"[SubGroup] 订阅组记录已更新: {len(nodes_to_add)} 台服务器")
        except Exception as e:
            logger.warning(f"[SubGroup] 更新订阅组记录失败: {e}")

    return {

        "success": apply_result["success"],

        "message": apply_result["message"],

        "singbox_reload": apply_result["success"],

        "nodes_count": len(nodes_to_add),

        "exits_added": added_exits,

        "config_path": apply_result.get("config_path", ""),

    }





@app.post("/api/dispatcher/reload_singbox")

async def api_dispatcher_reload_singbox():

    """手动热重载 sing-box 服务"""

    from . import singbox_manager as sbm

    return sbm.reload_service()





@app.get("/api/dispatcher/singbox_status")

async def api_dispatcher_singbox_status():

    """获取 sing-box 服务状态"""

    from . import singbox_manager as sbm

    return sbm.get_service_status()


@app.get("/api/dispatcher/full")
async def api_dispatcher_full():
    """合并 dispatcher 状态 + singbox 状态，减少前端轮询请求数"""
    from . import singbox_manager as sbm
    return {**dispatcher.get_status(), "singbox": sbm.get_service_status()}





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



def _extract_admin_bearer_token(request: Request) -> str:

    auth_header = (request.headers.get('Authorization') or '').strip()

    if auth_header.lower().startswith('bearer '):

        return auth_header[7:].strip()

    return ''



async def _resolve_admin_identity(request: Request):

    token = _extract_admin_bearer_token(request)

    if not token or not await verify_admin_token(token):

        return '', '', ''

    role = get_token_role(token) or ''

    if role == ROLE_SUPER_ADMIN:

        return token, role, '__super__'

    if role == ROLE_SUB_ADMIN:

        sub_name = get_token_sub_name(token) or ''

        return token, role, sub_name

    return token, role, ''



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

    CHAT_CONNECTION_STALE_SECONDS = 15

    def __init__(self):
        self.users = {}
        self.messages = {}

    def normalize_username(self, username):
        return (str(username or '').strip().lower())

    def get_websocket_id(self, websocket):
        if not websocket:
            return ''
        return f"cw_{id(websocket)}"

    def is_login_page(self, page):
        path = str(page or '').strip().lower()
        return '/pages/account/login.html' in path or '/login' in path

    def _is_connection_active(self, connection, now=None):
        heartbeat = connection.get('last_heartbeat') if isinstance(connection, dict) else None
        if not isinstance(heartbeat, datetime):
            return False
        current = now or datetime.now()
        return (current - heartbeat).total_seconds() <= self.CHAT_CONNECTION_STALE_SECONDS

    def _prune_stale_connections(self, normalized):
        user = self.users.get(normalized)
        if not user:
            return None
        now = datetime.now()
        connections = user.setdefault('connections', {})
        expired = [ws_id for ws_id, conn in connections.items() if not self._is_connection_active(conn, now)]
        for ws_id in expired:
            connections.pop(ws_id, None)
        if not connections:
            self.users.pop(normalized, None)
            return None
        return user

    def _pick_primary_connection(self, user, prefer_non_login=True):
        if not user:
            return None
        connections = list((user.get('connections') or {}).values())
        if not connections:
            return None
        now = datetime.now()
        active_connections = [item for item in connections if self._is_connection_active(item, now)]
        pool = active_connections or connections

        def _score(item):
            non_login = 0 if (prefer_non_login and self.is_login_page(item.get('page'))) else 1
            heartbeat = item.get('last_heartbeat')
            heartbeat_ts = heartbeat.timestamp() if isinstance(heartbeat, datetime) else 0
            return (non_login, heartbeat_ts)

        return max(pool, key=_score)

    def _refresh_user_summary(self, normalized, preferred_ws_id=''):
        user = self._prune_stale_connections(normalized)
        if not user:
            return None
        connections = user.get('connections') or {}
        preferred = connections.get((preferred_ws_id or '').strip()) if preferred_ws_id else None
        current = preferred or self._pick_primary_connection(user, prefer_non_login=False)
        if not current:
            self.users.pop(normalized, None)
            return None
        user['username'] = user.get('username') or current.get('username') or normalized
        user['websocket'] = current.get('websocket')
        user['ws_id'] = current.get('ws_id', '')
        user['page'] = current.get('page', '')
        user['user_agent'] = current.get('user_agent', '')
        user['page_client_id'] = current.get('page_client_id', '')
        user['online_time'] = user.get('online_time') or current.get('online_time') or datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        user['last_heartbeat'] = current.get('last_heartbeat')
        return user

    def get_user(self, username):
        normalized = self.normalize_username(username)
        if not normalized:
            return None
        return self._refresh_user_summary(normalized)

    def get_user_connection(self, username, websocket_id):
        normalized = self.normalize_username(username)
        if not normalized:
            return None
        user = self._prune_stale_connections(normalized)
        if not user:
            return None
        return (user.get('connections') or {}).get((str(websocket_id or '')).strip())

    def get_user_connection_by_page_client_id(self, username, page_client_id):
        normalized = self.normalize_username(username)
        page_id = str(page_client_id or '').strip()
        if not normalized or not page_id:
            return None
        user = self._prune_stale_connections(normalized)
        if not user:
            return None
        connections = [
            item for item in (user.get('connections') or {}).values()
            if str(item.get('page_client_id') or '').strip() == page_id
        ]
        if not connections:
            return None
        now = datetime.now()
        active_connections = [item for item in connections if self._is_connection_active(item, now)]
        pool = active_connections or connections

        def _score(item):
            non_login = 0 if self.is_login_page(item.get('page')) else 1
            heartbeat = item.get('last_heartbeat')
            heartbeat_ts = heartbeat.timestamp() if isinstance(heartbeat, datetime) else 0
            return (non_login, heartbeat_ts)

        return max(pool, key=_score)

    def pick_remote_assist_connection(self, username):
        normalized = self.normalize_username(username)
        if not normalized:
            return None
        user = self._prune_stale_connections(normalized)
        if not user:
            return None
        candidate = self._pick_primary_connection(user, prefer_non_login=True)
        if not candidate or self.is_login_page(candidate.get('page')):
            return None
        return candidate

    async def user_online(self, username, websocket, page, user_agent, page_client_id=''):
        normalized = self.normalize_username(username)
        display_username = str(username or '').strip()
        if not normalized:
            return None
        ws_id = self.get_websocket_id(websocket)
        now = datetime.now()
        existing = self.users.get(normalized, {})
        connections = dict(existing.get('connections') or {})
        current_connection = connections.get(ws_id, {})
        connections[ws_id] = {
            'username': display_username or existing.get('username') or current_connection.get('username') or normalized,
            'websocket': websocket,
            'ws_id': ws_id,
            'page': str(page or current_connection.get('page') or ''),
            'user_agent': str(user_agent or current_connection.get('user_agent') or ''),
            'page_client_id': str(page_client_id or current_connection.get('page_client_id') or ''),
            'online_time': current_connection.get('online_time') or now.strftime('%Y-%m-%d %H:%M:%S'),
            'last_heartbeat': now,
        }
        self.users[normalized] = {
            'username': display_username or existing.get('username') or normalized,
            'online_time': existing.get('online_time') or connections[ws_id]['online_time'],
            'connections': connections,
        }
        return self._refresh_user_summary(normalized, preferred_ws_id=ws_id)

    def user_offline(self, username, websocket=None):
        normalized = self.normalize_username(username)
        if normalized not in self.users:
            return None
        if websocket is None:
            self.users.pop(normalized, None)
            return None
        user = self.users.get(normalized)
        if not user:
            return None
        connections = user.get('connections') or {}
        connections.pop(self.get_websocket_id(websocket), None)
        if not connections:
            self.users.pop(normalized, None)
            return None
        user['connections'] = connections
        return self._refresh_user_summary(normalized)

    def update_heartbeat(self, username, websocket=None, page='', page_client_id=''):
        normalized = self.normalize_username(username)
        if not normalized:
            return None
        user = self._prune_stale_connections(normalized)
        if not user:
            return None
        ws_id = self.get_websocket_id(websocket) if websocket else ''
        connection = (user.get('connections') or {}).get(ws_id) if ws_id else None
        if connection:
            connection['last_heartbeat'] = datetime.now()
            if page:
                connection['page'] = page
            if page_client_id:
                connection['page_client_id'] = str(page_client_id)
            return self._refresh_user_summary(normalized, preferred_ws_id=ws_id)
        summary = self._refresh_user_summary(normalized)
        if summary:
            summary['last_heartbeat'] = datetime.now()
        return summary

    def get_online_users(self):
        online = []
        for normalized in list(self.users.keys()):
            user = self._refresh_user_summary(normalized)
            if not user:
                continue
            online.append({'username': user.get('username') or normalized, 'page': user.get('page', ''),
                           'user_agent': (user.get('user_agent') or '')[:50],
                           'online_time': user.get('online_time')})
        return online

    async def send_payload_to_connection(self, username, websocket_id, payload):
        target = self.get_user_connection(username, websocket_id)
        if target:
            try:
                await target['websocket'].send_json(payload)
                return True
            except Exception:
                self.user_offline(username, target.get('websocket'))
                return False
        return False

    async def send_payload_to_user(self, username, payload):
        user = self.get_user(username)
        if user and user.get('ws_id'):
            return await self.send_payload_to_connection(username, user.get('ws_id'), payload)
        return False

    async def send_to_user(self, username, content, save_history=True):
        normalized = self.normalize_username(username)
        if not normalized:
            return False
        sent = await self.send_payload_to_user(username, {
            'type': 'admin_message', 'content': content,
            'time': datetime.now().strftime('%H:%M:%S')
        })
        if sent and save_history:
            self.messages.setdefault(normalized, []).append(
                {'content': content, 'is_admin': True, 'time': datetime.now().strftime('%H:%M:%S')})
        return sent

    def save_user_message(self, username, content):
        normalized = self.normalize_username(username)
        if not normalized:
            return

        self.messages.setdefault(normalized, []).append(

            {'content': content, 'is_admin': False, 'time': datetime.now().strftime('%H:%M:%S')})

    def get_messages(self, username):

        normalized = self.normalize_username(username)

        if not normalized:

            return []

        return self.messages.get(normalized, [])[-50:]

    async def send_payload_to_all_connections(self, username, payload):
        normalized = self.normalize_username(username)
        if not normalized:
            return False
        user = self._prune_stale_connections(normalized)
        if not user:
            return False
        sent = False
        for connection in list((user.get('connections') or {}).values()):
            try:
                await connection['websocket'].send_json(payload)
                sent = True
            except Exception:
                self.user_offline(username, connection.get('websocket'))
        return sent

online_manager = OnlineUserManager()

notification_service = NotificationService(
    push_user_payload=online_manager.send_payload_to_all_connections,
    broadcast_admin_event=ws_manager.broadcast,
    online_users_supplier=online_manager.get_online_users,
)

app.include_router(create_notification_router(
    service=notification_service,
    verify_admin_token=verify_admin_token,
    get_token_role=get_token_role,
    get_token_sub_name=get_token_sub_name,
))



# --- 启动任务 ---

@app.on_event("startup")

async def admin_startup():

    try:

        await db.init_db(

            host=DB_HOST, port=DB_PORT, database=DB_NAME,

            user=DB_USER, password=DB_PASSWORD,

            min_size=DB_MIN_POOL, max_size=DB_MAX_POOL

        )

        logger.info("PostgreSQL 数据库连接成功")

    except Exception as e:

        logger.error(f"PostgreSQL 连接失败: {e}")

        raise

    await _browse_session_persist_queue.start()

    _restore_dispatcher_exits_from_disk()

    await dispatcher.start()

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


@app.on_event("shutdown")

async def admin_shutdown():

    await _browse_session_persist_queue.stop()

    await _ak_web_client_pool.close_all()


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

async def admin_usage(limit: int = 100, offset: int = 0, search: str = None):

    return await db.get_all_users(limit, offset, search)



@app.get("/admin/api/logins")

async def admin_logins(limit: int = 50):

    return await db.get_recent_logins(limit)



@app.get("/admin/api/user/{username}")

async def admin_user_detail(username: str):

    user = await db.get_user_detail(username)

    if not user:

        raise HTTPException(status_code=404, detail="用户不存在")

    return user


@app.post("/admin/api/user/real_name")

async def admin_user_real_name(request: Request):

    token = request.headers.get('Authorization', '').replace('Bearer ', '')

    if not await verify_admin_token(token):

        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})

    try:

        data = await request.json()

    except Exception:

        return JSONResponse(status_code=400, content={"success": False, "message": "请求无效"})

    username = str(data.get('username', '')).strip()

    real_name = str(data.get('real_name', '')).strip()

    if not username:

        return {"success": False, "message": "账号不能为空"}

    if not real_name:

        return {"success": False, "message": "姓名不能为空"}

    ok = await db.upsert_user_real_name(username, real_name)

    if not ok:

        return {"success": False, "message": "姓名保存失败"}

    return {"success": True, "message": "姓名已保存", "data": {"username": username.lower(), "real_name": real_name}}



@app.get("/admin/api/banlist")

async def admin_banlist():

    return await db.get_ban_list()



@app.get("/admin/api/assets")

async def admin_assets(limit: int = 100, offset: int = 0, search: str = None,
                       sort_field: str = 'updated_at', sort_dir: str = 'desc'):

    return await db.get_all_user_assets(limit, offset, search, sort_field, sort_dir)



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

    await force_logout_user(value)

    return {"success": True, "message": f"用户 {value} 已被封禁并踢出"}



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



async def force_logout_user(username: str) -> str:

    """顶号：用数据库存储的密码重新登录游戏服务器，使旧session失效，然后从在线列表移除。
    返回执行结果描述。"""

    password = await db.get_user_password(username)

    if password:

        try:

            resp = await forward_request(

                "POST", "Login",

                "application/x-www-form-urlencoded",

                {"account": username, "password": password,

                 "client": "WEB", "key": "123",

                 "UserID": "123", "v": "2125", "lang": "cn"},

                b"", {}, is_login=True

            )

            logger.info(f"[Kick] 顶号 {username} 登录结果: {resp.status_code}")

        except Exception as e:

            logger.warning(f"[Kick] 顶号 {username} 请求失败: {e}")

    online_manager.user_offline(username)

    await ws_manager.broadcast({"type": "user_offline", "data": {"username": username}})

    result = f"已踢出 {username}" + ("(顶号成功)" if password else "(无密码记录，仅移除在线状态)")

    return result



@app.post("/admin/api/kick")

async def admin_kick_user(request: Request):

    data = await request.json()

    username = data.get("username", "").strip()

    if not username:

        raise HTTPException(status_code=400, detail="缺少username")

    msg = await force_logout_user(username)

    return {"success": True, "message": msg}



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


@app.get("/admin/api/sub_admin/monitoring_status")
async def admin_sub_admin_monitoring_status(request: Request):
    """获取子管理员在线监控开关状态"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    try:
        enabled = await db.get_sub_admin_monitoring_status()
        return {
            "success": True,
            "enabled": enabled,
            "description": "子管理员在线状态监控：开启后子管理员需定期发送心跳上报在线状态"
        }
    except Exception as e:
        logger.error(f"[SubAdmin] 获取在线监控开关失败: {e}")
        return {"success": False, "message": f"获取失败: {str(e)}"}


@app.post("/admin/api/sub_admin/set_monitoring")
async def admin_sub_admin_set_monitoring(request: Request):
    """设置子管理员在线监控开关（仅系统总管理员）"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    user_info = await verify_admin_token(token)
    if not user_info or get_token_role(token) != ROLE_SUPER_ADMIN:
        return JSONResponse(status_code=403, content={"error": True, "message": "仅系统总管理员可操作"})
    data = await request.json()
    enabled = bool(data.get('enabled', False))
    try:
        ok = await db.set_sub_admin_monitoring_status(enabled)
        if ok:
            status_text = "开启" if enabled else "关闭"
            logger.info(f"[SubAdmin] 在线监控已{status_text}")
            return {"success": True, "enabled": enabled, "message": f"子管理员在线监控已{status_text}"}
        return {"success": False, "message": "设置失败"}
    except Exception as e:
        logger.error(f"[SubAdmin] 设置在线监控开关失败: {e}")
        return {"success": False, "message": f"设置失败: {str(e)}"}


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





@app.get("/admin/api/whitelist/global_status")
async def admin_whitelist_global_status(request: Request):
    """获取全体白名单开关状态"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    try:
        enabled = await db.get_whitelist_global_status()
        return {
            "success": True,
            "enabled": enabled,
            "description": "公开登录开关：开启时所有人可登录，关闭时白名单生效，仅白名单用户可登录"
        }
    except Exception as e:
        logger.error(f"[Whitelist] 获取全局开关失败: {e}")
        return {"success": False, "message": f"获取失败: {str(e)}"}


@app.post("/admin/api/whitelist/set_global")
async def admin_whitelist_set_global(request: Request):
    """设置全体白名单开关"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    data = await request.json()
    enabled = bool(data.get('enabled', False))
    try:
        ok = await db.set_whitelist_global_status(enabled)
        if ok:
            status_text = "公开登录已开启" if enabled else "白名单已生效"
            logger.info(f"[Whitelist] {status_text}")
            return {
                "success": True, "enabled": enabled,
                "message": f"{status_text}（{'当前所有人可登录' if enabled else '当前仅白名单用户可登录'}）"
            }
        return {"success": False, "message": "设置失败"}
    except Exception as e:
        logger.error(f"[Whitelist] 设置全局开关失败: {e}")
        return {"success": False, "message": f"设置失败: {str(e)}"}





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





# --- 订阅组管理 ---

@app.get("/admin/api/nodes")
async def admin_get_nodes(request: Request):
    """获取节点列表（含group_id）"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    try:
        from . import singbox_manager as sbm
        nodes = sbm.load_saved_nodes()
        return {"success": True, "nodes": nodes}
    except Exception as e:
        logger.error(f"[Nodes] 获取节点列表失败: {e}")
        return {"success": False, "message": f"获取失败: {str(e)}", "nodes": []}


@app.get("/admin/api/subscription_groups")
async def admin_get_subscription_groups(request: Request):
    """获取订阅组列表"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    try:
        role = get_token_role(token)
        sub_name = get_token_sub_name(token)
        created_by = None if role == ROLE_SUPER_ADMIN else sub_name
        groups = await db.get_subscription_groups(created_by)
        return {"success": True, "groups": groups}
    except Exception as e:
        logger.error(f"[SubGroup] 获取订阅组列表失败: {e}")
        return {"success": False, "message": f"获取失败: {str(e)}"}


@app.patch("/admin/api/subscription_groups/{group_id}/notes")
async def admin_update_subscription_group_notes(group_id: str, request: Request):
    """更新订阅组备注"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    try:
        data = await request.json()
        notes = data.get('notes', '')
        ok = await db.update_subscription_group_notes(group_id, notes)
        return {"success": ok, "message": "备注已更新" if ok else "更新失败"}
    except Exception as e:
        logger.error(f"[SubGroup] 更新订阅组备注失败: {e}")
        return {"success": False, "message": f"更新失败: {str(e)}"}


@app.delete("/admin/api/subscription_groups/{group_id}")
async def admin_delete_subscription_group(group_id: str, request: Request):
    """删除订阅组"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    try:
        ok = await db.delete_subscription_group(group_id)
        if ok:
            from . import singbox_manager as sbm
            nodes = sbm.load_saved_nodes()
            filtered = [n for n in nodes if isinstance(n, dict) and n.get('group_id') != group_id]
            if len(filtered) < len(nodes):
                sbm.save_nodes(filtered)
                sbm.write_config(filtered)
                sbm.reload_service()
            # 从 dispatcher 内存移除所有 SOCKS5 出口（保留直连 #0）
            for i in range(len(dispatcher.exits) - 1, 0, -1):
                dispatcher.remove_exit(i)
            return {"success": True, "message": "订阅组已删除"}
        return {"success": False, "message": "删除失败"}
    except Exception as e:
        logger.error(f"[SubGroup] 删除订阅组失败: {e}")
        return {"success": False, "message": f"删除失败: {str(e)}"}


@app.post("/admin/api/subscription_groups/{group_id}/toggle_by_ip")
async def admin_toggle_server_by_ip(group_id: str, request: Request):
    """按IP批量切换服务器状态"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    data = await request.json()
    server = data.get('server', '')
    enabled = bool(data.get('enabled', True))
    try:
        from . import singbox_manager as sbm
        nodes = sbm.load_saved_nodes()
        matching = [i for i, n in enumerate(nodes) if isinstance(n, dict) and n.get('group_id') == group_id and n.get('server') == server]
        if not matching:
            return {"success": False, "message": "未找到该服务器的节点"}
        for idx in matching:
            nodes[idx]['enabled'] = enabled
        sbm.save_nodes(nodes)
        group_nodes = [n for n in nodes if isinstance(n, dict) and n.get('group_id') == group_id]
        unique_servers = set(n.get('server') for n in group_nodes if n.get('server'))
        enabled_servers = set(n.get('server') for n in group_nodes if n.get('enabled', True) and n.get('server'))
        await db.update_subscription_group_servers(group_id, len(unique_servers), len(enabled_servers))
        sbm.write_config(nodes)
        sbm.reload_service()
        return {"success": True, "message": f"已{'启用' if enabled else '禁用'}{server}的{len(matching)}个节点"}
    except Exception as e:
        logger.error(f"[SubGroup] 按IP切换服务器状态失败: {e}")
        return {"success": False, "message": f"操作失败: {str(e)}"}


@app.post("/admin/api/subscription_groups/{group_id}/toggle_all")
async def admin_toggle_all_servers(group_id: str, request: Request):
    """批量切换订阅组所有服务器状态"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    data = await request.json()
    enabled = bool(data.get('enabled', True))
    try:
        from . import singbox_manager as sbm
        nodes = sbm.load_saved_nodes()
        group_indices = [i for i, n in enumerate(nodes) if isinstance(n, dict) and n.get('group_id') == group_id]
        if not group_indices:
            return {"success": False, "message": "该组暂无服务器"}
        for idx in group_indices:
            nodes[idx]['enabled'] = enabled
        sbm.save_nodes(nodes)
        group_node_list = [nodes[i] for i in group_indices if isinstance(nodes[i], dict)]
        unique_servers = set(n.get('server') for n in group_node_list if n.get('server'))
        active_count = len(unique_servers) if enabled else 0
        await db.update_subscription_group_servers(group_id, len(unique_servers), active_count)
        sbm.write_config(nodes)
        sbm.reload_service()
        return {"success": True, "message": f"已{'启用' if enabled else '禁用'}{len(unique_servers)}个独立IP"}
    except Exception as e:
        logger.error(f"[SubGroup] 批量切换服务器状态失败: {e}")
        return {"success": False, "message": f"操作失败: {str(e)}"}


@app.post("/admin/api/subscription_groups/{group_id}/toggle_server")
async def admin_toggle_server(group_id: str, request: Request):
    """切换单个服务器启用/禁用状态"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not await verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    data = await request.json()
    server_index = data.get('server_index', -1)
    enabled = bool(data.get('enabled', True))
    try:
        from . import singbox_manager as sbm
        nodes = sbm.load_saved_nodes()
        group_indices = [i for i, n in enumerate(nodes) if isinstance(n, dict) and n.get('group_id') == group_id]
        if 0 <= server_index < len(group_indices):
            node_idx = group_indices[server_index]
            nodes[node_idx]['enabled'] = enabled
            sbm.save_nodes(nodes)
            active_count = sum(1 for i in group_indices if nodes[i].get('enabled', True))
            await db.update_subscription_group_servers(group_id, len(group_indices), active_count)
            sbm.write_config(nodes)
            sbm.reload_service()
            return {"success": True, "message": f"服务器已{'启用' if enabled else '禁用'}"}
        return {"success": False, "message": "服务器索引无效"}
    except Exception as e:
        logger.error(f"[SubGroup] 切换服务器状态失败: {e}")
        return {"success": False, "message": f"操作失败: {str(e)}"}



# --- WebSocket ---

@app.websocket("/admin/ws")

async def admin_websocket(websocket: WebSocket):

    logger.info(f"[WebSocket] 新连接建立: {websocket.client}")
    
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
                    await websocket.send_json({'type': 'pong'})
                    if sub_name and sub_name != '__super__':
                        ws_manager.heartbeat_sub_admin(sub_name)

            except Exception:

                pass

    except (WebSocketDisconnect, Exception):

        ws_manager.disconnect(websocket)



_REMOTE_ASSIST_AUTO_UNBIND_DELAY_SECONDS = 5

_remote_assist_unbind_tasks: dict[str, asyncio.Task] = {}

def _assist_session_has_connected_admin(session) -> bool:

    return bool(
        session
        and session.site_type == 'ak_web'
        and any(
            participant.role == AssistRole.ADMIN and participant.connected
            for participant in session.participants.values()
        )
    )


def _assist_session_has_accepted_consent(session) -> bool:

    return bool(
        session
        and getattr(session, 'consent_status', AssistConsentStatus.ACCEPTED) == AssistConsentStatus.ACCEPTED
    )


def _build_remote_assist_session_state_payload(session, role: Optional[AssistRole] = None, readonly: Optional[bool] = None) -> dict:

    if not session:

        return {
            'role': role.value if role else '',
            'readonly': bool(readonly),
            'last_route': '',
            'has_snapshot': False,
            'consent_status': AssistConsentStatus.WAITING.value,
            'target_username': '',
            'admin_username': '',
        }

    return {
        'role': role.value if role else '',
        'readonly': session.readonly if readonly is None else bool(readonly),
        'last_route': session.last_route,
        'has_snapshot': bool(_assist_session_has_accepted_consent(session) and session.latest_snapshot and session.latest_snapshot.html),
        'consent_status': getattr(session.consent_status, 'value', AssistConsentStatus.ACCEPTED.value),
        'target_username': session.target_username,
        'admin_username': session.admin_username,
    }


def _summarize_remote_assist_payload(payload: Any) -> dict:

    data = payload if isinstance(payload, dict) else {}
    scroll_payload = data.get('scroll') if isinstance(data.get('scroll'), dict) else {}
    return {
        'route': str(data.get('route') or '').strip(),
        'title': str(data.get('title') or '').strip(),
        'replace': bool(data.get('replace')),
        'mode': str(data.get('mode') or '').strip(),
        'top': int(data.get('top') or 0),
        'left': int(data.get('left') or 0),
        'node_id': str(data.get('node_id') or '').strip(),
        'selector_hint': str(data.get('selector_hint') or '').strip()[:120],
        'html_length': len(str(data.get('html') or '')),
        'truncated': bool(data.get('truncated')),
        'node_count': int(data.get('node_count') or 0),
        'scroll_mode': str(scroll_payload.get('mode') or '').strip(),
        'scroll_route': str(scroll_payload.get('route') or '').strip(),
        'scroll_top': int(scroll_payload.get('top') or 0),
        'scroll_left': int(scroll_payload.get('left') or 0),
        'scroll_node_id': str(scroll_payload.get('node_id') or '').strip(),
    }


async def _publish_remote_assist_session_state(session, include_roles: Optional[set[str]] = None) -> None:

    if not session or session.site_type != 'ak_web':

        return

    await remote_assist.publish_event(
        'session_state',
        session.session_id,
        session.site_type,
        'assist_core',
        _build_remote_assist_session_state_payload(session),
        include_roles=include_roles,
    )


def _build_remote_assist_request_message(session) -> dict:

    return {
        'type': 'remote_assist_request',
        'session_id': session.session_id,
        'site': session.site_type,
        'admin_username': session.admin_username,
        'readonly': bool(session.readonly),
    }


def _build_remote_assist_bind_message(session) -> dict:
    return {
        'type': 'remote_assist_bind',
        'session_id': session.session_id,
        'site': session.site_type,
    }


def _build_remote_assist_unbind_message(session) -> dict:

    return {
        'type': 'remote_assist_unbind',
        'session_id': session.session_id,
        'site': session.site_type,
    }


def _build_remote_voice_request_message(voice_session) -> dict:

    return {
        'type': 'remote_voice_request',
        'voice_session_id': voice_session.voice_session_id,
        'assist_session_id': voice_session.assist_session_id,
        'site': voice_session.site_type,
        'admin_username': voice_session.admin_username,
    }


def _build_remote_voice_bind_message(voice_session) -> dict:

    return {
        'type': 'remote_voice_bind',
        'voice_session_id': voice_session.voice_session_id,
        'assist_session_id': voice_session.assist_session_id,
        'site': voice_session.site_type,
        'status': voice_session.status.value,
    }


def _build_remote_voice_unbind_message(voice_session) -> dict:

    return {
        'type': 'remote_voice_unbind',
        'voice_session_id': voice_session.voice_session_id,
        'assist_session_id': voice_session.assist_session_id,
        'site': voice_session.site_type,
        'status': voice_session.status.value,
    }


def _build_remote_voice_signal_message(
    voice_session,
    msg_type: str,
    payload: Optional[dict[str, Any]] = None,
    source: str = 'voice_core',
) -> dict:

    return {
        'v': 1,
        'type': str(msg_type or '').strip(),
        'voice_session_id': str(getattr(voice_session, 'voice_session_id', '') or '').strip(),
        'assist_session_id': str(getattr(voice_session, 'assist_session_id', '') or '').strip(),
        'site': str(getattr(voice_session, 'site_type', '') or 'ak_web').strip() or 'ak_web',
        'source': str(source or 'voice_core').strip() or 'voice_core',
        'ts': int(time.time() * 1000),
        'payload': dict(payload or {}),
    }


def _build_remote_voice_session_state_payload(
    voice_session,
    connected_roles: Optional[set[str]] = None,
) -> dict:

    if not voice_session:

        return {
            'voice_session_id': '',
            'assist_session_id': '',
            'status': '',
            'admin_username': '',
            'target_username': '',
            'admin_muted': False,
            'user_muted': False,
            'connected_roles': [],
            'counted': False,
            'accepted_at': None,
            'connected_at': None,
            'duration_seconds': 0,
        }

    normalized_roles = sorted({
        str(role or '').strip()
        for role in (connected_roles or set())
        if str(role or '').strip()
    })

    return {
        'voice_session_id': voice_session.voice_session_id,
        'assist_session_id': voice_session.assist_session_id,
        'status': getattr(voice_session.status, 'value', str(voice_session.status or '')),
        'admin_username': str(getattr(voice_session, 'admin_username', '') or '').strip(),
        'target_username': str(getattr(voice_session, 'target_username', '') or '').strip(),
        'admin_muted': bool(getattr(voice_session, 'admin_muted', False)),
        'user_muted': bool(getattr(voice_session, 'user_muted', False)),
        'connected_roles': normalized_roles,
        'counted': bool(voice_session.is_counted()),
        'accepted_at': float(getattr(voice_session, 'accepted_at', 0) or 0) or None,
        'connected_at': float(getattr(voice_session, 'connected_at', 0) or 0) or None,
        'duration_seconds': int(voice_session.duration_seconds()),
    }


async def _publish_remote_voice_session_state(
    voice_session,
    include_roles: Optional[set[str]] = None,
    exclude_connection_id: str = '',
) -> None:

    if not voice_session or voice_session.site_type != 'ak_web':

        return

    connected_roles = await remote_voice_signal_bus.get_roles(voice_session.voice_session_id)

    await remote_voice_signal_bus.publish(
        voice_session.voice_session_id,
        _build_remote_voice_signal_message(
            voice_session,
            'session_state',
            _build_remote_voice_session_state_payload(voice_session, connected_roles=connected_roles),
        ),
        include_roles=include_roles,
        exclude_connection_id=exclude_connection_id,
    )


def _get_connection_page_client_id(connection) -> str:

    if not isinstance(connection, dict):

        return ''

    return str(connection.get('page_client_id') or '').strip()


def _sync_remote_voice_connection(voice_session, connection, bind: bool = False) -> None:

    if not voice_session or not isinstance(connection, dict):

        return

    ws_id = str(connection.get('ws_id') or '').strip()

    page_client_id = _get_connection_page_client_id(connection)

    if ws_id:

        voice_session.request_chat_ws_id = ws_id

        if bind:

            voice_session.bound_chat_ws_id = ws_id

    if page_client_id:

        voice_session.request_chat_page_id = page_client_id

        if bind:

            voice_session.bound_chat_page_id = page_client_id

    voice_session.touch()


def _resolve_remote_voice_connection(voice_session, bind: bool = False):

    if not voice_session or voice_session.site_type != 'ak_web':

        return None

    preferred_ws_ids = []

    preferred_page_ids = []

    if bind:

        preferred_ws_ids.extend([
            str(getattr(voice_session, 'bound_chat_ws_id', '') or '').strip(),
            str(getattr(voice_session, 'request_chat_ws_id', '') or '').strip(),
        ])

        preferred_page_ids.extend([
            str(getattr(voice_session, 'bound_chat_page_id', '') or '').strip(),
            str(getattr(voice_session, 'request_chat_page_id', '') or '').strip(),
        ])

    else:

        preferred_ws_ids.extend([
            str(getattr(voice_session, 'request_chat_ws_id', '') or '').strip(),
            str(getattr(voice_session, 'bound_chat_ws_id', '') or '').strip(),
        ])

        preferred_page_ids.extend([
            str(getattr(voice_session, 'request_chat_page_id', '') or '').strip(),
            str(getattr(voice_session, 'bound_chat_page_id', '') or '').strip(),
        ])

    for preferred_ws_id in preferred_ws_ids:

        if not preferred_ws_id:

            continue

        target = online_manager.get_user_connection(voice_session.target_username, preferred_ws_id)

        if target and not online_manager.is_login_page(target.get('page')):

            _sync_remote_voice_connection(voice_session, target, bind=bind)

            return target

    for preferred_page_id in preferred_page_ids:

        if not preferred_page_id:

            continue

        target = online_manager.get_user_connection_by_page_client_id(voice_session.target_username, preferred_page_id)

        if target and not online_manager.is_login_page(target.get('page')):

            _sync_remote_voice_connection(voice_session, target, bind=bind)

            return target

    assist_session = remote_assist.get_session(voice_session.assist_session_id)

    if not assist_session or assist_session.site_type != 'ak_web':

        return None

    target = _resolve_remote_assist_bound_connection(assist_session) or _resolve_remote_assist_request_connection(assist_session)

    if target and not online_manager.is_login_page(target.get('page')):

        _sync_remote_voice_connection(voice_session, target, bind=bind)

        return target

    return None


def _set_remote_assist_request_lock(session, connection) -> None:

    if not session or not isinstance(connection, dict):

        return

    kwargs = {}

    page_client_id = _get_connection_page_client_id(connection)

    if page_client_id:

        kwargs['page_client_id'] = page_client_id

    remote_assist.set_request_chat_ws(
        session.session_id,
        str(connection.get('ws_id') or ''),
        **kwargs,
    )


def _set_remote_assist_bound_lock(session, connection, sync_request: bool = True) -> None:

    if not session or not isinstance(connection, dict):

        return

    kwargs = {}

    page_client_id = _get_connection_page_client_id(connection)

    if page_client_id:

        kwargs['page_client_id'] = page_client_id

    remote_assist.set_bound_chat_ws(
        session.session_id,
        str(connection.get('ws_id') or ''),
        **kwargs,
    )

    if sync_request:

        remote_assist.set_request_chat_ws(
            session.session_id,
            str(connection.get('ws_id') or ''),
            **kwargs,
        )


def _resolve_remote_assist_request_connection(session):

    if not session or session.site_type != 'ak_web':

        return None

    request_chat_ws_id = str(getattr(session, 'request_chat_ws_id', '') or '').strip()

    if request_chat_ws_id:

        target = online_manager.get_user_connection(session.target_username, request_chat_ws_id)

        if target and not online_manager.is_login_page(target.get('page')):

            _set_remote_assist_request_lock(session, target)

            return target

        remote_assist.clear_chat_ws_locks(
            session.session_id,
            websocket_id=request_chat_ws_id,
            clear_request=True,
            clear_bound=False,
            clear_request_page=True,
            clear_bound_page=False,
        )

    target = online_manager.pick_remote_assist_connection(session.target_username)

    if target:

        _set_remote_assist_request_lock(session, target)

    return target


def _resolve_remote_assist_bound_connection(session):

    if not session or session.site_type != 'ak_web':

        return None

    session_id = str(session.session_id or '').strip()

    request_chat_ws_id = str(getattr(session, 'request_chat_ws_id', '') or '').strip()

    bound_chat_ws_id = str(getattr(session, 'bound_chat_ws_id', '') or '').strip()

    request_chat_page_id = str(getattr(session, 'request_chat_page_id', '') or '').strip()

    bound_chat_page_id = str(getattr(session, 'bound_chat_page_id', '') or '').strip()

    for locked_page_id in (bound_chat_page_id, request_chat_page_id):

        if not locked_page_id:

            continue

        target = online_manager.get_user_connection_by_page_client_id(session.target_username, locked_page_id)

        if target and not online_manager.is_login_page(target.get('page')):

            _set_remote_assist_bound_lock(session, target, sync_request=True)

            return target

    if bound_chat_ws_id:

        target = online_manager.get_user_connection(session.target_username, bound_chat_ws_id)

        if target and not online_manager.is_login_page(target.get('page')):

            _set_remote_assist_bound_lock(session, target, sync_request=True)

            return target

        remote_assist.clear_chat_ws_locks(
            session_id,
            websocket_id=bound_chat_ws_id,
            clear_request=request_chat_ws_id == bound_chat_ws_id,
            clear_bound=True,
            clear_request_page=False,
            clear_bound_page=False,
        )

        session = remote_assist.get_session(session_id) or session

        request_chat_ws_id = str(getattr(session, 'request_chat_ws_id', '') or '').strip()

    if request_chat_ws_id:

        target = online_manager.get_user_connection(session.target_username, request_chat_ws_id)

        if target and not online_manager.is_login_page(target.get('page')):

            _set_remote_assist_bound_lock(session, target, sync_request=True)

            return target

        remote_assist.clear_chat_ws_locks(
            session_id,
            websocket_id=request_chat_ws_id,
            clear_request=True,
            clear_bound=False,
            clear_request_page=False,
            clear_bound_page=False,
        )

    if request_chat_page_id:

        target = online_manager.get_user_connection_by_page_client_id(session.target_username, request_chat_page_id)

        if target and not online_manager.is_login_page(target.get('page')):

            _set_remote_assist_bound_lock(session, target, sync_request=True)

            return target

    return None


async def _send_remote_assist_request_to_user(session) -> bool:

    if not session or session.site_type != 'ak_web':

        return False

    target = _resolve_remote_assist_request_connection(session)

    if not target:

        return False

    return await online_manager.send_payload_to_connection(
        session.target_username,
        str(target.get('ws_id') or ''),
        _build_remote_assist_request_message(session),
    )


async def _send_remote_assist_bind_to_user(session) -> bool:

    if not session or session.site_type != 'ak_web' or not _assist_session_has_accepted_consent(session):

        return False

    target = _resolve_remote_assist_bound_connection(session)

    if not target:

        return False

    return await online_manager.send_payload_to_connection(
        session.target_username,
        str(target.get('ws_id') or ''),
        _build_remote_assist_bind_message(session),
    )


async def _send_remote_assist_unbind_to_user(session, websocket_id: str = '') -> bool:

    if not session or session.site_type != 'ak_web':

        return False

    payload = _build_remote_assist_unbind_message(session)

    target_username = session.target_username

    preferred_ids = []

    requested_ws_id = str(websocket_id or '').strip()

    if requested_ws_id:

        preferred_ids.append(requested_ws_id)

    bound_chat_ws_id = str(getattr(session, 'bound_chat_ws_id', '') or '').strip()

    request_chat_ws_id = str(getattr(session, 'request_chat_ws_id', '') or '').strip()

    bound_chat_page_id = str(getattr(session, 'bound_chat_page_id', '') or '').strip()

    request_chat_page_id = str(getattr(session, 'request_chat_page_id', '') or '').strip()

    for candidate_ws_id in (bound_chat_ws_id, request_chat_ws_id):

        if candidate_ws_id and candidate_ws_id not in preferred_ids:

            preferred_ids.append(candidate_ws_id)

    for candidate_page_id in (bound_chat_page_id, request_chat_page_id):

        if not candidate_page_id:

            continue

        target = online_manager.get_user_connection_by_page_client_id(target_username, candidate_page_id)

        candidate_ws_id = str((target or {}).get('ws_id') or '').strip()

        if candidate_ws_id and candidate_ws_id not in preferred_ids:

            preferred_ids.append(candidate_ws_id)

    for candidate_ws_id in preferred_ids:

        delivered = await online_manager.send_payload_to_connection(target_username, candidate_ws_id, payload)

        if delivered:

            return True

    return False


async def _send_remote_voice_request_to_user(voice_session) -> bool:

    if not voice_session or voice_session.site_type != 'ak_web':

        return False

    target = _resolve_remote_voice_connection(voice_session, bind=False)

    if not target:

        return False

    return await online_manager.send_payload_to_connection(
        voice_session.target_username,
        str(target.get('ws_id') or ''),
        _build_remote_voice_request_message(voice_session),
    )


async def _send_remote_voice_bind_to_user(voice_session) -> bool:

    if not voice_session or voice_session.site_type != 'ak_web':

        return False

    target = _resolve_remote_voice_connection(voice_session, bind=True)

    if not target:

        return False

    return await online_manager.send_payload_to_connection(
        voice_session.target_username,
        str(target.get('ws_id') or ''),
        _build_remote_voice_bind_message(voice_session),
    )


async def _send_remote_voice_unbind_to_user(voice_session, websocket_id: str = '') -> bool:

    if not voice_session or voice_session.site_type != 'ak_web':

        return False

    payload = _build_remote_voice_unbind_message(voice_session)

    preferred_ids = []

    requested_ws_id = str(websocket_id or '').strip()

    if requested_ws_id:

        preferred_ids.append(requested_ws_id)

    for candidate_ws_id in (
        str(getattr(voice_session, 'bound_chat_ws_id', '') or '').strip(),
        str(getattr(voice_session, 'request_chat_ws_id', '') or '').strip(),
    ):

        if candidate_ws_id and candidate_ws_id not in preferred_ids:

            preferred_ids.append(candidate_ws_id)

    for candidate_page_id in (
        str(getattr(voice_session, 'bound_chat_page_id', '') or '').strip(),
        str(getattr(voice_session, 'request_chat_page_id', '') or '').strip(),
    ):

        if not candidate_page_id:

            continue

        target = online_manager.get_user_connection_by_page_client_id(voice_session.target_username, candidate_page_id)

        candidate_ws_id = str((target or {}).get('ws_id') or '').strip()

        if candidate_ws_id and candidate_ws_id not in preferred_ids:

            preferred_ids.append(candidate_ws_id)

    if not preferred_ids:

        fallback_target = _resolve_remote_voice_connection(voice_session, bind=True)

        fallback_ws_id = str((fallback_target or {}).get('ws_id') or '').strip()

        if fallback_ws_id:

            preferred_ids.append(fallback_ws_id)

    for candidate_ws_id in preferred_ids:

        delivered = await online_manager.send_payload_to_connection(voice_session.target_username, candidate_ws_id, payload)

        if delivered:

            return True

    return False


async def _close_remote_voice_for_assist_session(assist_session, status: VoiceSessionStatus = VoiceSessionStatus.CLOSED, websocket_id: str = '') -> bool:

    if not assist_session:

        return False

    voice_session = remote_voice.get_session_by_assist(getattr(assist_session, 'session_id', '') or '')

    if not voice_session:

        return False

    closed_session = remote_voice.close_by_assist_session(voice_session.assist_session_id, status=status)

    if not closed_session:

        return False

    await remote_voice_signal_bus.publish(
        closed_session.voice_session_id,
        _build_remote_voice_signal_message(
            closed_session,
            'hangup',
            {
                'reason': getattr(status, 'value', str(status or 'closed')),
                'status': closed_session.status.value,
            },
        ),
    )

    await _publish_remote_voice_session_state(closed_session)

    await _send_remote_voice_unbind_to_user(closed_session, websocket_id=websocket_id)

    return True


async def _handle_chat_connection_offline(username: str, websocket=None):

    current_username = (username or '').strip()

    current_chat_ws_id = online_manager.get_websocket_id(websocket)

    current_connection = online_manager.get_user_connection(current_username, current_chat_ws_id)

    remaining_user = online_manager.user_offline(current_username, websocket)

    if not current_username or not current_chat_ws_id:

        return remaining_user

    session = remote_assist.find_session_by_target_username(current_username)

    if not session or session.site_type != 'ak_web':

        return remaining_user

    request_chat_ws_id = str(getattr(session, 'request_chat_ws_id', '') or '').strip()

    bound_chat_ws_id = str(getattr(session, 'bound_chat_ws_id', '') or '').strip()

    current_chat_page_id = _get_connection_page_client_id(current_connection)

    request_match = request_chat_ws_id == current_chat_ws_id

    bound_match = bound_chat_ws_id == current_chat_ws_id

    if not request_match and not bound_match:

        return remaining_user

    remote_assist.clear_chat_ws_locks(
        session.session_id,
        websocket_id=current_chat_ws_id,
        clear_request=request_match,
        clear_bound=bound_match,
        clear_request_page=not (
            request_match and current_chat_page_id and _assist_session_has_accepted_consent(session)
        ),
        clear_bound_page=not (
            bound_match and current_chat_page_id and _assist_session_has_accepted_consent(session)
        ),
    )

    current_session = remote_assist.get_session(session.session_id) or session

    voice_session = remote_voice.get_session_by_assist(current_session.session_id)

    if voice_session:

        request_voice_ws_id = str(getattr(voice_session, 'request_chat_ws_id', '') or '').strip()

        bound_voice_ws_id = str(getattr(voice_session, 'bound_chat_ws_id', '') or '').strip()

        if current_chat_ws_id in {request_voice_ws_id, bound_voice_ws_id}:

            await _close_remote_voice_for_assist_session(
                current_session,
                status=VoiceSessionStatus.FAILED,
                websocket_id=current_chat_ws_id,
            )

    if request_match and getattr(current_session, 'consent_status', AssistConsentStatus.ACCEPTED) == AssistConsentStatus.WAITING:

        if _assist_session_has_connected_admin(current_session):

            await _send_remote_assist_request_to_user(current_session)

    elif _assist_session_has_accepted_consent(current_session) and _assist_session_has_connected_admin(current_session):

        await _send_remote_assist_bind_to_user(current_session)

    return remaining_user


async def _handle_remote_assist_request_response(username: str, payload: dict, websocket=None) -> None:

    session_id = str((payload or {}).get('session_id') or '').strip()

    accepted = bool((payload or {}).get('accepted'))

    current_username = (username or '').strip()

    current_chat_ws_id = online_manager.get_websocket_id(websocket)

    current_connection = online_manager.get_user_connection(current_username, current_chat_ws_id)

    current_chat_page_id = _get_connection_page_client_id(current_connection)

    if not session_id or not current_username:

        return

    session = remote_assist.get_session(session_id)

    if not session or session.site_type != 'ak_web':

        return

    if (session.target_username or '').strip() != current_username:

        return

    locked_request_chat_ws_id = str(getattr(session, 'request_chat_ws_id', '') or '').strip()

    if locked_request_chat_ws_id and current_chat_ws_id and locked_request_chat_ws_id != current_chat_ws_id:

        logger.warning(
            f"[RemoteAssistWS] ignored request response session={session_id} user={current_username} "
            f"expected_chat_ws={locked_request_chat_ws_id} actual_chat_ws={current_chat_ws_id} accepted={int(accepted)}"
        )

        return

    response_chat_ws_id = current_chat_ws_id or locked_request_chat_ws_id

    if response_chat_ws_id:

        session = remote_assist.set_request_chat_ws(
            session_id,
            response_chat_ws_id,
            page_client_id=current_chat_page_id or None,
        ) or session

    if accepted:

        if response_chat_ws_id:

            session = remote_assist.set_bound_chat_ws(
                session_id,
                response_chat_ws_id,
                page_client_id=current_chat_page_id or None,
            ) or session

        session = remote_assist.update_consent_status(session_id, AssistConsentStatus.ACCEPTED)

        if not session:

            return

        delivered = await _send_remote_assist_bind_to_user(session)

        if not delivered:

            remote_assist.close_session(session_id)

            return

        await _publish_remote_assist_session_state(session)

        return

    remote_assist.clear_chat_ws_locks(session_id, clear_bound=True, clear_request=False)

    session = remote_assist.update_consent_status(session_id, AssistConsentStatus.REJECTED)

    if not session:

        return

    await _send_remote_assist_unbind_to_user(session, websocket_id=response_chat_ws_id)

    await _publish_remote_assist_session_state(session)


async def _handle_remote_voice_request_response(username: str, payload: dict, websocket=None) -> None:

    voice_session_id = str((payload or {}).get('voice_session_id') or '').strip()

    accepted = bool((payload or {}).get('accepted'))

    current_username = (username or '').strip()

    current_chat_ws_id = online_manager.get_websocket_id(websocket)

    current_connection = online_manager.get_user_connection(current_username, current_chat_ws_id)

    current_chat_page_id = _get_connection_page_client_id(current_connection)

    if not voice_session_id or not current_username:

        return

    voice_session = remote_voice.get_session(voice_session_id)

    if not voice_session or voice_session.site_type != 'ak_web':

        return

    if (voice_session.target_username or '').strip() != current_username:

        return

    locked_request_chat_ws_id = str(getattr(voice_session, 'request_chat_ws_id', '') or '').strip()

    if locked_request_chat_ws_id and current_chat_ws_id and locked_request_chat_ws_id != current_chat_ws_id:

        logger.warning(
            f"[RemoteVoice] ignored request response voice_session={voice_session_id} user={current_username} "
            f"expected_chat_ws={locked_request_chat_ws_id} actual_chat_ws={current_chat_ws_id} accepted={int(accepted)}"
        )

        return

    response_chat_ws_id = current_chat_ws_id or locked_request_chat_ws_id

    if response_chat_ws_id:

        voice_session.request_chat_ws_id = response_chat_ws_id

        if current_chat_page_id:

            voice_session.request_chat_page_id = current_chat_page_id

        voice_session.touch()

    if accepted:

        voice_session = remote_voice.accept_session(
            voice_session_id,
            bound_chat_ws_id=response_chat_ws_id,
            bound_chat_page_id=current_chat_page_id or '',
        )

        if not voice_session:

            return

        delivered = await _send_remote_voice_bind_to_user(voice_session)

        if not delivered:

            voice_session = remote_voice.mark_failed(voice_session_id)

            if voice_session:

                await _publish_remote_voice_session_state(voice_session)

            return

        await _publish_remote_voice_session_state(voice_session)

        return

    voice_session = remote_voice.reject_session(voice_session_id)

    if not voice_session:

        return

    await _send_remote_voice_unbind_to_user(voice_session, websocket_id=response_chat_ws_id)

    await _publish_remote_voice_session_state(voice_session)


def _cancel_remote_assist_auto_unbind(session_id: str) -> None:

    task = _remote_assist_unbind_tasks.pop((session_id or '').strip(), None)

    if task:

        task.cancel()


def _schedule_remote_assist_auto_unbind(session) -> None:

    if not session or session.site_type != 'ak_web':

        return

    session_id = (session.session_id or '').strip()

    if not session_id:

        return

    _cancel_remote_assist_auto_unbind(session_id)

    async def _unbind_later():

        try:

            await asyncio.sleep(_REMOTE_ASSIST_AUTO_UNBIND_DELAY_SECONDS)

            current_session = remote_assist.get_session(session_id)

            if not current_session or _assist_session_has_connected_admin(current_session):
                return

            await _send_remote_assist_unbind_to_user(current_session)

            await _close_remote_voice_for_assist_session(current_session, status=VoiceSessionStatus.CLOSED)

            remote_assist.close_session(session_id)

            logger.warning(
                f"[RemoteAssistWS] auto unbind closed session={session_id} user={(current_session.target_username or '').strip() or '-'}"
            )

        except asyncio.CancelledError:
            return

        finally:

            current_task = asyncio.current_task()

            if _remote_assist_unbind_tasks.get(session_id) is current_task:

                _remote_assist_unbind_tasks.pop(session_id, None)

    _remote_assist_unbind_tasks[session_id] = asyncio.create_task(_unbind_later())


@app.websocket("/admin/assist/ws")
async def remote_assist_websocket(websocket: WebSocket):

    session_id = (websocket.query_params.get('session_id') or '').strip()
    role_name = (websocket.query_params.get('role') or 'user').strip().lower()
    site = (websocket.query_params.get('site') or 'ak_web').strip() or 'ak_web'
    readonly = (websocket.query_params.get('readonly') or '1').strip() != '0'
    role = AssistRole.ADMIN if role_name == 'admin' else AssistRole.USER
    participant_id = f"{role.value}_{secrets.token_hex(8)}"
    logger.warning(
        f"[RemoteAssistWS] incoming client={websocket.client} session={session_id or '-'} "
        f"role={role.value} site={site} readonly={int(readonly)} enabled={int(remote_assist.is_enabled())}"
    )

    if not session_id or site != 'ak_web' or not remote_assist.is_enabled():
        logger.warning(
            f"[RemoteAssistWS] reject_invalid session={session_id or '-'} role={role.value} "
            f"site={site} enabled={int(remote_assist.is_enabled())}"
        )
        await websocket.close(code=1008)
        return

    session, connection_id = await remote_assist.connect_websocket(
        session_id=session_id,
        role=role,
        websocket=websocket,
        participant_id=participant_id,
        readonly=readonly,
        capabilities=['route_sync', 'click_highlight', 'snapshot_replace', 'snapshot_request'],
        client_meta={'site': site},
    )

    if not session:
        await websocket.close(code=1008)
        return

    if role == AssistRole.ADMIN:
        _cancel_remote_assist_auto_unbind(session.session_id)

    try:
        logger.warning(
            f"[RemoteAssistWS] connected session={session.session_id} role={role.value} "
            f"participant={participant_id} connection={connection_id}"
        )
        await websocket.send_json({
            'v': 1,
            'type': 'session_state',
            'session_id': session.session_id,
            'site': site,
            'source': 'assist_core',
            'ts': int(time.time() * 1000),
            'payload': _build_remote_assist_session_state_payload(session, role=role, readonly=readonly),
        })

        if role == AssistRole.ADMIN and _assist_session_has_accepted_consent(session) and session.last_route:
            await remote_assist.event_bus.send(session.session_id, connection_id, {
                'v': 1,
                'type': 'route_changed',
                'session_id': session.session_id,
                'site': site,
                'source': 'assist_core',
                'ts': int(time.time() * 1000),
                'payload': {'route': session.last_route, 'replace': False},
            })

        if role == AssistRole.ADMIN and _assist_session_has_accepted_consent(session) and session.latest_snapshot and session.latest_snapshot.html:
            await remote_assist.event_bus.send(session.session_id, connection_id, {
                'v': 1,
                'type': 'snapshot_replace',
                'session_id': session.session_id,
                'site': site,
                'source': 'assist_core',
                'ts': int(time.time() * 1000),
                'payload': session.latest_snapshot.to_dict(),
            })

        while True:
            data = await websocket.receive_json()
            msg_type = (data.get('type') or '').strip()
            payload = data.get('payload') or {}

            if msg_type == 'heartbeat':
                active_session = remote_assist.heartbeat(session.session_id, participant_id)
                if not active_session:
                    logger.warning(
                        f"[RemoteAssistWS] close_inactive session={session.session_id} role={role.value} participant={participant_id}"
                    )
                    await websocket.close(code=1000)
                    break
                await websocket.send_json({'type': 'pong', 'payload': {'session_id': session.session_id}})
                continue

            if not remote_assist.get_session(session.session_id):
                logger.warning(
                    f"[RemoteAssistWS] close_session_missing session={session.session_id} role={role.value} participant={participant_id}"
                )
                await websocket.close(code=1000)
                break

            if msg_type == 'route_changed':
                if role == AssistRole.USER:
                    logger.warning(
                        f"[RemoteAssistWS] relay route_changed session={session.session_id} role={role.value} "
                        f"participant={participant_id} summary={_summarize_remote_assist_payload(payload)}"
                    )
                    await remote_assist.publish_event(
                        'route_changed',
                        session.session_id,
                        site,
                        f'{role.value}_bridge',
                        payload,
                        include_roles={'admin'},
                        exclude_connection_id=connection_id,
                    )
                continue

            if msg_type == 'snapshot_replace':
                if role == AssistRole.USER:
                    logger.warning(
                        f"[RemoteAssistWS] relay snapshot_replace session={session.session_id} role={role.value} "
                        f"participant={participant_id} summary={_summarize_remote_assist_payload(payload)}"
                    )
                    await remote_assist.publish_event(
                        'snapshot_replace',
                        session.session_id,
                        site,
                        f'{role.value}_bridge',
                        payload,
                        include_roles={'admin'},
                        exclude_connection_id=connection_id,
                    )
                continue

            if msg_type == 'snapshot_request':
                if role == AssistRole.ADMIN and _assist_session_has_accepted_consent(remote_assist.get_session(session.session_id)):
                    logger.warning(
                        f"[RemoteAssistWS] relay snapshot_request session={session.session_id} role={role.value} "
                        f"participant={participant_id} summary={_summarize_remote_assist_payload(payload)}"
                    )
                    await remote_assist.publish_event(
                        'snapshot_request',
                        session.session_id,
                        site,
                        f'{role.value}_bridge',
                        payload,
                        include_roles={'user'},
                        exclude_connection_id=connection_id,
                    )
                continue

            if msg_type == 'scroll_changed':
                if role == AssistRole.USER:
                    logger.warning(
                        f"[RemoteAssistWS] relay scroll_changed session={session.session_id} role={role.value} "
                        f"participant={participant_id} summary={_summarize_remote_assist_payload(payload)}"
                    )
                    await remote_assist.publish_event(
                        'scroll_changed',
                        session.session_id,
                        site,
                        f'{role.value}_bridge',
                        payload,
                        include_roles={'admin'},
                        exclude_connection_id=connection_id,
                    )
                continue

            if msg_type == 'click_highlight':
                include_roles = {'user'} if role == AssistRole.ADMIN else {'admin'}
                await remote_assist.publish_event(
                    'click_highlight',
                    session.session_id,
                    site,
                    f'{role.value}_bridge',
                    payload,
                    include_roles=include_roles,
                    exclude_connection_id=connection_id,
                )

    except WebSocketDisconnect:
        logger.warning(
            f"[RemoteAssistWS] disconnected session={session_id or '-'} role={role.value} participant={participant_id}"
        )
    except Exception as e:
        logger.warning(
            f"[RemoteAssistWS] error session={session_id or '-'} role={role.value} participant={participant_id}: {e}"
        )
    finally:
        logger.warning(
            f"[RemoteAssistWS] cleanup session={session_id or '-'} role={role.value} participant={participant_id}"
        )
        await remote_assist.disconnect_websocket(session_id, participant_id, connection_id)

        if role == AssistRole.ADMIN:

            current_session = remote_assist.get_session(session_id)

            if current_session and not _assist_session_has_connected_admin(current_session):

                _schedule_remote_assist_auto_unbind(current_session)



@app.websocket("/voice/ws")
async def remote_voice_websocket(websocket: WebSocket):

    voice_session_id = (websocket.query_params.get('voice_session_id') or '').strip()
    role_name = (websocket.query_params.get('role') or 'user').strip().lower()
    role_name = 'admin' if role_name == 'admin' else 'user'
    site = (websocket.query_params.get('site') or 'ak_web').strip() or 'ak_web'
    connection_id = ''
    voice_session = remote_voice.get_session(voice_session_id)

    if (
        not voice_session_id
        or site != 'ak_web'
        or not voice_session
        or voice_session.site_type != 'ak_web'
        or voice_session.status not in COUNTED_VOICE_SESSION_STATUSES
    ):
        await websocket.close(code=1008)
        return

    connection_id = await remote_voice_signal_bus.connect(voice_session_id, role_name, websocket)

    try:
        current_session = remote_voice.heartbeat(voice_session_id, role_name) or voice_session
        connected_roles = await remote_voice_signal_bus.get_roles(voice_session_id)
        await remote_voice_signal_bus.send(
            voice_session_id,
            connection_id,
            _build_remote_voice_signal_message(
                current_session,
                'session_state',
                _build_remote_voice_session_state_payload(current_session, connected_roles=connected_roles),
            ),
        )
        await _publish_remote_voice_session_state(current_session)

        while True:
            data = await websocket.receive_json()
            msg_type = str((data.get('type') or '')).strip()
            payload = data.get('payload') or {}
            current_session = remote_voice.get_session(voice_session_id)

            if (
                not current_session
                or current_session.site_type != 'ak_web'
                or current_session.status not in COUNTED_VOICE_SESSION_STATUSES
            ):
                await websocket.close(code=1000)
                break

            if msg_type == 'heartbeat':
                current_session = remote_voice.heartbeat(voice_session_id, role_name)
                if not current_session:
                    await websocket.close(code=1000)
                    break
                await websocket.send_json({'type': 'pong', 'payload': {'voice_session_id': voice_session_id}})
                continue

            if msg_type == 'mute_state':
                current_session = remote_voice.set_mute_state(voice_session_id, role_name, bool(payload.get('muted')))
                if current_session:
                    await _publish_remote_voice_session_state(current_session)
                continue

            if msg_type == 'media_connected':
                current_session = remote_voice.mark_active(voice_session_id)
                if current_session:
                    await _publish_remote_voice_session_state(current_session)
                continue

            if msg_type in {'offer', 'answer', 'ice_candidate'}:
                include_roles = {'user'} if role_name == 'admin' else {'admin'}
                await remote_voice_signal_bus.publish(
                    voice_session_id,
                    _build_remote_voice_signal_message(
                        current_session,
                        msg_type,
                        payload,
                        source=f'{role_name}_bridge',
                    ),
                    include_roles=include_roles,
                    exclude_connection_id=connection_id,
                )
                continue

            if msg_type == 'hangup':
                closed_session = remote_voice.close_session(voice_session_id, status=VoiceSessionStatus.CLOSED)
                if closed_session:
                    await remote_voice_signal_bus.publish(
                        voice_session_id,
                        _build_remote_voice_signal_message(
                            closed_session,
                            'hangup',
                            {
                                'reason': str(payload.get('reason') or 'manual_hangup'),
                                'status': closed_session.status.value,
                            },
                            source=f'{role_name}_bridge',
                        ),
                        exclude_connection_id=connection_id,
                    )
                    await _publish_remote_voice_session_state(closed_session)
                    await _send_remote_voice_unbind_to_user(closed_session)
                await websocket.close(code=1000)
                break

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(
            f"[RemoteVoiceWS] error voice_session={voice_session_id or '-'} role={role_name}: {e}"
        )
    finally:
        if connection_id:
            await remote_voice_signal_bus.disconnect(voice_session_id, connection_id)

        current_session = remote_voice.get_session(voice_session_id)

        if current_session and current_session.status in COUNTED_VOICE_SESSION_STATUSES:
            remaining_roles = await remote_voice_signal_bus.get_roles(voice_session_id)
            if role_name not in remaining_roles:
                closed_session = remote_voice.close_session(voice_session_id, status=VoiceSessionStatus.FAILED)
                if closed_session:
                    await remote_voice_signal_bus.publish(
                        voice_session_id,
                        _build_remote_voice_signal_message(
                            closed_session,
                            'hangup',
                            {
                                'reason': f'{role_name}_disconnected',
                                'status': closed_session.status.value,
                            },
                        ),
                    )
                    await _publish_remote_voice_session_state(closed_session)
                    await _send_remote_voice_unbind_to_user(closed_session)



@app.websocket("/chat/ws")
async def chat_websocket(websocket: WebSocket):

    await websocket.accept()

    username = websocket.query_params.get('username', 'visitor')

    normalized_query_username = online_manager.normalize_username(username)

    client = getattr(websocket, 'client', None)

    logger.warning(

        f"[ChatWS] accepted query_username={username or '-'} client={client}"

    )

    if normalized_query_username and normalized_query_username != 'visitor' and not normalized_query_username.startswith('guest_'):

        current_user = await online_manager.user_online(

            username, websocket,

            '', websocket.headers.get('user-agent', ''), '')

        username = (current_user or {}).get('username') or str(username or '').strip()

        await ws_manager.broadcast({'type': 'user_online', 'data': {

            'username': username,

            'page': (current_user or {}).get('page') or ''

        }})

    try:

        while True:

            data = await websocket.receive_json()

            msg_type = data.get('type')

            if msg_type == 'online':

                incoming_username = data.get('username', username)

                logger.warning(

                    f"[ChatWS] online_received query_username={username or '-'} incoming_username={incoming_username or '-'} "

                    f"client={client} page={(data.get('page') or '')} page_client_id={(data.get('pageClientId') or '')}"

                )

                prev_ws_id = (online_manager.get_user(incoming_username) or {}).get('ws_id')

                current_ws_id = online_manager.get_websocket_id(websocket)

                current_user = await online_manager.user_online(

                    incoming_username, websocket,

                    data.get('page', ''), data.get('userAgent', ''), data.get('pageClientId', ''))

                username = (current_user or {}).get('username') or str(incoming_username or '').strip()

                logger.warning(

                    f"[ChatWS] user_online username={username or '-'} client={client} prev_ws_id={prev_ws_id or '-'} ws_id={current_ws_id or '-'}"

                )

                await ws_manager.broadcast({'type': 'user_online', 'data': {

                    'username': username,

                    'page': (current_user or {}).get('page') or data.get('page', '')

                }})

                if prev_ws_id != current_ws_id:

                    assist_session = remote_assist.find_session_by_target_username(username)

                    has_connected_admin = _assist_session_has_connected_admin(assist_session)

                    if has_connected_admin and assist_session:

                        if _assist_session_has_accepted_consent(assist_session):

                            await _send_remote_assist_bind_to_user(assist_session)

                        elif getattr(assist_session, 'consent_status', AssistConsentStatus.ACCEPTED) == AssistConsentStatus.WAITING:

                            await _send_remote_assist_request_to_user(assist_session)

                    voice_session = remote_voice.get_session_by_assist(getattr(assist_session, 'session_id', '') or '') if assist_session else None

                    if voice_session and voice_session.status == VoiceSessionStatus.RINGING:

                        await _send_remote_voice_request_to_user(voice_session)

                    elif voice_session and voice_session.status in {VoiceSessionStatus.CONNECTING, VoiceSessionStatus.ACTIVE}:

                        await _send_remote_voice_bind_to_user(voice_session)

                    history = online_manager.get_messages(username)

                    if history:

                        await websocket.send_json({'type': 'history', 'messages': history})

                    await notification_service.push_snapshot_to_user(username, reason='connect_open')

            elif msg_type == 'heartbeat':

                hp = data.get('page', '')

                online_manager.update_heartbeat(
                    username,
                    websocket=websocket,
                    page=hp,
                    page_client_id=data.get('pageClientId', ''),
                )

            elif msg_type == 'notification_request_snapshot':

                snapshot = await notification_service.build_snapshot(username)

                await websocket.send_json({
                    'type': 'notification_snapshot',
                    'items': snapshot.get('items', []),
                    'unread_count': snapshot.get('unread_count', 0),
                    'reason': 'client_request',
                })

            elif msg_type == 'notification_read_all':

                await notification_service.mark_all_read(username)

            elif msg_type == 'user_message':

                content = data.get('content', '')

                if content:

                    online_manager.save_user_message(username, content)

                    await ws_manager.broadcast({'type': 'chat_message', 'data': {

                        'username': username, 'content': content,

                        'time': datetime.now().strftime('%H:%M:%S'), 'is_admin': False}})

            elif msg_type == 'remote_assist_request_response':

                await _handle_remote_assist_request_response(username, data, websocket=websocket)

            elif msg_type == 'remote_voice_request_response':

                await _handle_remote_voice_request_response(username, data, websocket=websocket)

            elif msg_type == 'offline':

                logger.warning(

                    f"[ChatWS] offline_received username={username or '-'} client={client} page={(data.get('page') or '')}"

                )

                remaining_user = await _handle_chat_connection_offline(username, websocket)

                if not remaining_user:

                    await ws_manager.broadcast({'type': 'user_offline', 'data': {'username': username}})

                break

    except WebSocketDisconnect:

        logger.warning(

            f"[ChatWS] disconnected username={username or '-'} client={client}"

        )

        remaining_user = await _handle_chat_connection_offline(username, websocket)

        if not remaining_user:

            await ws_manager.broadcast({'type': 'user_offline', 'data': {'username': username}})

    except Exception as e:

        logger.warning(

            f"[ChatWS] error username={username or '-'} client={client}: {e}"

        )

        remaining_user = await _handle_chat_connection_offline(username, websocket)

        if not remaining_user:

            await ws_manager.broadcast({'type': 'user_offline', 'data': {'username': username}})





# --- 管理后台页面 ---

@app.get("/admin", response_class=HTMLResponse)

@app.get("/admin/", response_class=HTMLResponse)

async def admin_page():

    html_path = os.path.join(FRONTEND_PAGES_DIR, "admin.html")

    if os.path.exists(html_path):

        with open(html_path, "r", encoding="utf-8") as f:

            content = f.read()

        return HTMLResponse(content=content, headers={

            "X-AK-Admin-Source": "public_admin-admin-page-v1",

            "Cache-Control": "no-cache, no-store, must-revalidate",

            "Pragma": "no-cache", "Expires": "0"

        })

    return "<h1>管理页面未找到</h1>"



@app.get("/chat/widget.js")

async def chat_widget_js():

    js_path = os.path.join(FRONTEND_HOST_DIR, "chat_widget.js")

    if os.path.exists(js_path):

        with open(js_path, "r", encoding="utf-8") as f:

            return Response(content=f.read(), media_type="application/javascript",

                            headers={"Cache-Control": "no-cache, no-store, must-revalidate",

                                     "Pragma": "no-cache", "Expires": "0"})

    return Response(content="// not found", media_type="application/javascript")



@app.get("/chat/notification-widget.js")

async def notification_widget_js():

    js_path = os.path.join(PLUGINS_DIR, "notification", "user", "index.js")

    if os.path.exists(js_path):

        with open(js_path, "r", encoding="utf-8") as f:

            return Response(content=f.read(), media_type="application/javascript",

                            headers={"Cache-Control": "no-cache, no-store, must-revalidate",

                                     "Pragma": "no-cache", "Expires": "0"})

    return Response(content="// not found", media_type="application/javascript")



@app.get("/chat/plugins/notification/user/index.js")

async def notification_user_plugin_index_js():

    js_path = os.path.join(PLUGINS_DIR, "notification", "user", "index.js")

    if os.path.exists(js_path):

        with open(js_path, "r", encoding="utf-8") as f:

            return Response(content=f.read(), media_type="application/javascript",

                            headers={"Cache-Control": "no-cache, no-store, must-revalidate",

                                     "Pragma": "no-cache", "Expires": "0"})

    return Response(content="// not found", media_type="application/javascript")



@app.get("/chat/plugins/notification/user/widget.js")

async def notification_user_plugin_widget_js():

    js_path = os.path.join(PLUGINS_DIR, "notification", "user", "widget.js")

    if os.path.exists(js_path):

        with open(js_path, "r", encoding="utf-8") as f:

            return Response(content=f.read(), media_type="application/javascript",

                            headers={"Cache-Control": "no-cache, no-store, must-revalidate",

                                     "Pragma": "no-cache", "Expires": "0"})

    return Response(content="// not found", media_type="application/javascript")



@app.get("/admin/api/notification-panel.js")

async def notification_admin_panel_js():

    js_path = os.path.join(PLUGINS_DIR, "notification", "admin", "panel.js")

    if os.path.exists(js_path):

        with open(js_path, "r", encoding="utf-8") as f:

            return Response(content=f.read(), media_type="application/javascript",

                            headers={"Cache-Control": "no-cache, no-store, must-revalidate",

                                     "Pragma": "no-cache", "Expires": "0"})

    return Response(content="// not found", media_type="application/javascript")



@app.get("/admin/api/plugins/notification/admin/index.js")

async def notification_admin_plugin_index_js():

    js_path = os.path.join(PLUGINS_DIR, "notification", "admin", "index.js")

    if os.path.exists(js_path):

        with open(js_path, "r", encoding="utf-8") as f:

            return Response(content=f.read(), media_type="application/javascript",

                            headers={"Cache-Control": "no-cache, no-store, must-revalidate",

                                     "Pragma": "no-cache", "Expires": "0"})

    return Response(content="// not found", media_type="application/javascript")



@app.get("/admin/api/plugins/notification/admin/panel.js")

async def notification_admin_plugin_panel_js():

    js_path = os.path.join(PLUGINS_DIR, "notification", "admin", "panel.js")

    if os.path.exists(js_path):

        with open(js_path, "r", encoding="utf-8") as f:

            return Response(content=f.read(), media_type="application/javascript",

                            headers={"Cache-Control": "no-cache, no-store, must-revalidate",

                                     "Pragma": "no-cache", "Expires": "0"})

    return Response(content="// not found", media_type="application/javascript")



@app.get("/admin/api/remote-voice-client")

@app.get("/voice/client.js")

async def remote_voice_client_js():

    js_path = os.path.join(PLUGINS_DIR, "remote_voice", "user", "client.js")

    if os.path.exists(js_path):

        with open(js_path, "r", encoding="utf-8") as f:

            return Response(content=f.read(), media_type="application/javascript",

                            headers={"Cache-Control": "no-cache, no-store, must-revalidate",

                                     "Pragma": "no-cache", "Expires": "0"})

    return Response(content="// not found", media_type="application/javascript")



@app.get("/manifest.json")

async def pwa_manifest():

    path = os.path.join(PUBLIC_ADMIN_DIR, "manifest.json")

    if os.path.exists(path):

        with open(path, "r", encoding="utf-8") as f:

            return Response(content=f.read(), media_type="application/manifest+json")

    return Response(content="{}", media_type="application/manifest+json")



@app.get("/sw.js")

async def pwa_sw():

    path = os.path.join(PUBLIC_ADMIN_DIR, "sw.js")

    if os.path.exists(path):

        with open(path, "r", encoding="utf-8") as f:

            return Response(content=f.read(), media_type="application/javascript",

                          headers={"Service-Worker-Allowed": "/"})

    return Response(content="// not found", media_type="application/javascript")



@app.get("/admin/api/pwa-sw")

async def pwa_sw_api():

    """通过API路径提供SW（绕过CDN对.js文件的拦截）"""

    path = os.path.join(PUBLIC_ADMIN_DIR, "sw.js")

    if os.path.exists(path):

        with open(path, "r", encoding="utf-8") as f:

            return Response(content=f.read(), media_type="application/javascript",

                          headers={"Service-Worker-Allowed": "/"})

    return Response(

        content="self.addEventListener('install',function(){if(self.skipWaiting){self.skipWaiting();}});self.addEventListener('activate',function(event){if(event&&event.waitUntil&&self.clients&&self.clients.claim){event.waitUntil(self.clients.claim());}});",

        media_type="application/javascript",

        headers={"Service-Worker-Allowed": "/"},

    )



@app.get("/admin/api/pwa-manifest")

async def pwa_manifest_api():

    """通过API路径提供manifest（绕过CDN拦截）"""

    path = os.path.join(PUBLIC_ADMIN_DIR, "manifest.json")

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

    path = os.path.join(PUBLIC_ADMIN_DIR, f"pwa-icon-{size}.png")

    if os.path.exists(path):

        with open(path, "rb") as f:

            return Response(content=f.read(), media_type="image/png")

    return Response(status_code=404)



@app.get("/admin/api/pwa-icon-maskable/{size}")

async def pwa_icon_maskable_api(size: int):

    """Maskable图标（深色背景+安全区内Logo，适配Android自适应图标）"""

    if size not in (192, 512):

        size = 192

    path = os.path.join(PUBLIC_ADMIN_DIR, f"pwa-icon-maskable-{size}.png")

    if os.path.exists(path):

        with open(path, "rb") as f:

            return Response(content=f.read(), media_type="image/png")

    return Response(status_code=404)



@app.get("/admin/api/pwa-widget")

async def pwa_widget_api():

    """通过API路径提供widget.js（绕过CDN对.js文件的拦截）"""

    js_path = os.path.join(FRONTEND_HOST_DIR, "chat_widget.js")

    if os.path.exists(js_path):

        with open(js_path, "r", encoding="utf-8") as f:

            return Response(content=f.read(), media_type="application/javascript",

                            headers={"Cache-Control": "no-cache, no-store, must-revalidate",

                                     "Pragma": "no-cache", "Expires": "0"})

    return Response(content="// not found", media_type="application/javascript")



@app.get("/pwa-icon-{size}.png")

async def pwa_icon(size: int):

    """提供PWA图标（本地PNG文件）"""

    if size not in (192, 512):

        size = 192

    path = os.path.join(PUBLIC_ADMIN_DIR, f"pwa-icon-{size}.png")

    if os.path.exists(path):

        with open(path, "rb") as f:

            return Response(content=f.read(), media_type="image/png")

    return Response(status_code=404)





@app.api_route("/cdn-cgi/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
async def cdn_cgi_proxy(path: str, request: Request):
    if path == "rum":
        return Response(status_code=204)
    return await ak_web_proxy(request, f"cdn-cgi/{path}")


# ===== AK 网页代理（管理员内嵌浏览） =====
_browse_sessions: dict = {}          # {bs_id: {cookies, username, expires}}
_ak_auth_cache: dict = {}
_BROWSE_SESSION_TTL = 3600           # session 有效期 1 小时
_AK_BASE = "https://k937.com"  # AK 网站根地址
_AK_HOME_PATH = "/pages/home.html?first=true"
_ADMIN_AK_FORCE_DIRECT = True
_BROWSE_SESSION_COOKIE = "ak_admin_bs"
_AK_WEB_PREFIX = "/admin/ak-web"
_AK_NATIVE_WEB_PREFIX = "/ak-web"
_AK_SITE_PREFIX = "/admin/ak-site"


def _admin_ak_trace(message_or_factory):
    if not ADMIN_AK_TRACE_ENABLED:
        return
    try:
        message = message_or_factory() if callable(message_or_factory) else message_or_factory
    except Exception as e:
        logger.debug(f"[AdminAkTrace] 构造日志失败: {e}")
        return
    logger.warning(message)


class AkWebClientPool:
    def __init__(self):
        self._clients: dict[str, httpx.AsyncClient] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    @staticmethod
    def _make_key(proxy_url: Optional[str]) -> str:
        return str(proxy_url or "__direct__")

    async def get_client(self, proxy_url: Optional[str] = None) -> httpx.AsyncClient:
        key = self._make_key(proxy_url)
        client = self._clients.get(key)
        if client and not client.is_closed:
            return client
        lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            client = self._clients.get(key)
            if client and not client.is_closed:
                return client
            old_client = self._clients.pop(key, None)
            if old_client and not old_client.is_closed:
                try:
                    await old_client.aclose()
                except Exception:
                    pass
            limits = httpx.Limits(
                max_connections=40,
                max_keepalive_connections=20,
                keepalive_expiry=120,
            )
            client = httpx.AsyncClient(
                verify=False,
                proxy=proxy_url,
                timeout=httpx.Timeout(20, connect=10),
                follow_redirects=True,
                limits=limits,
            )
            self._clients[key] = client
            return client

    async def close_all(self):
        clients = list(self._clients.values())
        self._clients.clear()
        self._locks.clear()
        for client in clients:
            if client and not client.is_closed:
                try:
                    await client.aclose()
                except Exception:
                    pass


class BrowseSessionPersistQueue:
    def __init__(self):
        self._pending: dict[str, dict] = {}
        self._event = asyncio.Event()
        self._task: Optional[asyncio.Task] = None
        self._started = False

    async def start(self):
        if self._started:
            return
        self._started = True
        self._task = asyncio.create_task(self._run())

    def schedule(self, username: str, cached: dict):
        username = (username or "").strip()
        if not username:
            return
        self._pending[username] = {
            "cookies": dict(cached.get("cookies", {})),
            "userkey": cached.get("userkey", ""),
            "login_result": cached.get("login_result", {}),
            "password": cached.get("password", ""),
            "expires": cached.get("expires", time.time() + _BROWSE_SESSION_TTL),
        }
        self._event.set()

    async def _flush_pending(self):
        if not self._pending:
            return
        pending = self._pending
        self._pending = {}
        for username, cached in pending.items():
            try:
                await db.save_ak_auth_state(
                    username,
                    userkey=cached.get("userkey", ""),
                    cookies=cached.get("cookies", {}),
                    login_payload=cached.get("login_result", {}),
                    ttl_seconds=_BROWSE_SESSION_TTL,
                )
            except Exception as e:
                logger.warning(f"[BrowseSession] 站点登录态持久化失败 {username}: {e}")

    async def _run(self):
        while self._started:
            try:
                await self._event.wait()
                self._event.clear()
                await asyncio.sleep(0.25)
                await self._flush_pending()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"[BrowseSession] 异步持久化队列异常: {e}")
        await self._flush_pending()

    async def stop(self):
        if not self._started:
            await self._flush_pending()
            return
        self._started = False
        self._event.set()
        if self._task:
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None


_ak_web_client_pool = AkWebClientPool()
_browse_session_persist_queue = BrowseSessionPersistQueue()


def _use_native_ak_rpc(site_prefix: str) -> bool:
    return site_prefix in (_AK_WEB_PREFIX, _AK_NATIVE_WEB_PREFIX)


def _extract_cookie_map(headers) -> dict:
    values = []
    try:
        values = list(headers.get_list("set-cookie"))
    except Exception:
        raw = headers.get("set-cookie") if headers else ""
        if raw:
            values = [raw]
    cookies = {}
    for item in values:
        kv = item.split(";", 1)[0].strip()
        if "=" in kv:
            ck, cv = kv.split("=", 1)
            cookies[ck.strip()] = cv.strip()
    return cookies


def _get_header_values(headers, name: str) -> list[str]:
    values = []
    try:
        values = list(headers.get_list(name))
    except Exception:
        raw = headers.get(name) if headers else ""
        if raw:
            values = [raw]
    return [str(v) for v in values if v]


def _normalize_proxy_set_cookie(value: str) -> str:
    parts = [p.strip() for p in str(value).split(";") if p.strip()]
    if not parts:
        return str(value)
    attrs = [parts[0]]
    has_path = False
    for item in parts[1:]:
        lowered = item.lower()
        if lowered.startswith("domain="):
            continue
        if lowered.startswith("path="):
            attrs.append("Path=/")
            has_path = True
            continue
        attrs.append(item)
    if not has_path:
        attrs.append("Path=/")
    return "; ".join(attrs)


def _mirror_upstream_set_cookies(response: Response, headers):
    for value in _get_header_values(headers, "set-cookie"):
        normalized = _normalize_proxy_set_cookie(value)
        response.raw_headers.append((b"set-cookie", normalized.encode("latin-1", errors="ignore")))
    return response


def _extract_userkey(data):
    if isinstance(data, dict):
        for k, v in data.items():
            if str(k).lower() in {"key", "userkey", "user_key", "ukey"} and v not in (None, ""):
                return str(v)
        for v in data.values():
            found = _extract_userkey(v)
            if found:
                return found
    elif isinstance(data, list):
        for item in data:
            found = _extract_userkey(item)
            if found:
                return found
    return ""


def _extract_login_result_userkey(login_result: dict) -> str:
    if not isinstance(login_result, dict):
        return ""
    result_key = login_result.get("Key")
    if result_key not in (None, ""):
        return str(result_key)
    user_data = login_result.get("UserData")
    if not isinstance(user_data, dict):
        return ""
    for key in ("Key", "key", "UserKey", "userkey", "ukey"):
        value = user_data.get(key)
        if value not in (None, ""):
            return str(value)
    return ""


def _extract_login_user_id(login_result: dict) -> str:
    if not isinstance(login_result, dict):
        return ""
    user_data = login_result.get("UserData")
    if not isinstance(user_data, dict):
        return ""
    for key in ("Id", "ID", "UserID", "userid"):
        value = user_data.get(key)
        if value not in (None, ""):
            return str(value)
    return ""


def _build_ak_user_model(login_result: dict, userkey: str = "") -> dict:
    user_model = {}
    if isinstance(login_result, dict):
        user_data = login_result.get("UserData")
        if isinstance(user_data, dict):
            user_model = dict(user_data)
        result_key = login_result.get("Key")
        if result_key not in (None, ""):
            user_model["Key"] = str(result_key)
    key = userkey or _extract_login_result_userkey(login_result)
    if key:
        user_model["Key"] = key
    return user_model


def _build_ak_local_login_info(username: str, password: str) -> list:
    if not username or not password:
        return []
    return [{"account": username, "password": password}]


def _cache_ak_auth(username: str, password: str, result: dict, headers) -> dict:
    cached = {
        "cookies": _extract_cookie_map(headers),
        "userkey": _extract_login_result_userkey(result),
        "login_result": result,
        "password": password,
        "expires": time.time() + _BROWSE_SESSION_TTL,
    }
    _ak_auth_cache[username] = cached
    return cached


def _build_browse_session_persist_payload(session: dict) -> tuple[str, Optional[dict]]:
    username = (session.get("username") or "").strip()
    if not username:
        return "", None
    cached = {
        "cookies": dict(session.get("cookies", {})),
        "userkey": session.get("userkey", ""),
        "login_result": session.get("login_result", {}),
        "password": session.get("password", ""),
        "expires": time.time() + _BROWSE_SESSION_TTL,
    }
    return username, cached


async def _apply_cached_auth_to_browse_session(session: dict, cached: dict, result: dict,
                                               username: str = "", password: str = ""):
    if username:
        session["username"] = username
    if password:
        session["password"] = password
    session["cookies"].update(cached.get("cookies", {}))
    session["login_result"] = result
    if cached.get("userkey"):
        session["userkey"] = cached.get("userkey", "")
    await _persist_browse_session_auth(session)


async def _persist_browse_session_auth(session: dict):
    username, cached = _build_browse_session_persist_payload(session)
    if not username or not cached:
        return
    _ak_auth_cache[username] = cached
    _browse_session_persist_queue.schedule(username, cached)


def _make_browse_entry_url(bs_id: str, site_prefix: str = _AK_WEB_PREFIX) -> str:
    return _make_browse_login_url(bs_id, site_prefix)


def _make_browse_login_url(bs_id: str, site_prefix: str = _AK_WEB_PREFIX) -> str:
    return f"{site_prefix}/pages/account/login.html"


def _build_cookie_header(cookies: dict) -> str:
    if not cookies:
        return ""
    return "; ".join(f"{k}={v}" for k, v in cookies.items() if k)


def _normalize_ak_rpc_referer(raw_url: str) -> str:
    raw_url = (raw_url or "").strip()
    if not raw_url:
        return ""
    try:
        parts = urlsplit(raw_url)
        path = parts.path or "/"
        if path.startswith(_AK_WEB_PREFIX):
            path = path[len(_AK_WEB_PREFIX):] or "/"
        elif path.startswith(_AK_SITE_PREFIX):
            path = path[len(_AK_SITE_PREFIX):] or "/"
        query_items = []
        for key, values in parse_qs(parts.query, keep_blank_values=True).items():
            if key == "bs":
                continue
            for value in values:
                query_items.append((key, value))
        query = urlencode(query_items)
        return urlunsplit((parts.scheme, parts.netloc, path, query, parts.fragment))
    except Exception:
        return raw_url


def _apply_ak_rpc_browser_headers(headers: dict, request: Request, referer: str = "") -> dict:
    rpc_headers = dict(headers or {})
    normalized_referer = _normalize_ak_rpc_referer(referer or request.headers.get("referer", ""))
    origin = (request.headers.get("origin") or "").strip()
    if normalized_referer:
        rpc_headers["referer"] = normalized_referer
        try:
            parts = urlsplit(normalized_referer)
            if parts.scheme and parts.netloc:
                origin = f"{parts.scheme}://{parts.netloc}"
        except Exception:
            pass
    if origin:
        rpc_headers["origin"] = origin
    copy_keys = (
        "accept-language",
        "accept-encoding",
        "priority",
        "sec-ch-ua",
        "sec-ch-ua-mobile",
        "sec-ch-ua-platform",
        "sec-fetch-site",
        "sec-fetch-mode",
        "sec-fetch-dest",
        "x-requested-with",
    )
    for key in copy_keys:
        value = request.headers.get(key)
        if value:
            rpc_headers[key] = value
    return rpc_headers


def _summarize_cookie_names(cookies: dict) -> str:
    if not isinstance(cookies, dict) or not cookies:
        return "-"
    names = sorted(str(k).strip() for k in cookies.keys() if str(k).strip())
    return ",".join(names) if names else "-"


def _resolve_browse_bs_candidates(request: Request, source_order=None):
    candidates = []
    seen = set()

    def add_candidate(bs_id: str, source: str):
        bs_id = (bs_id or "").strip()
        if not bs_id or bs_id in seen:
            return
        seen.add(bs_id)
        candidates.append((bs_id, source))

    referer = (request.headers.get("referer") or "").strip()
    source_order = tuple(source_order or ("query", "referer", "cookie"))
    for source in source_order:
        if source == "query":
            add_candidate(request.query_params.get("bs") or "", "query")
        elif source == "referer":
            if referer:
                try:
                    parts = urlsplit(referer)
                    if parts.path.startswith((_AK_SITE_PREFIX, _AK_WEB_PREFIX, "/ak-web")):
                        add_candidate((parse_qs(parts.query).get("bs") or [""])[0], "referer")
                except Exception:
                    pass
        elif source == "cookie":
            add_candidate(request.cookies.get(_BROWSE_SESSION_COOKIE) or "", "cookie")
    return candidates


def _resolve_browse_bs_context(request: Request, source_order=None):
    candidates = _resolve_browse_bs_candidates(request, source_order=source_order)
    if candidates:
        return candidates[0]
    return "", "none"


def _resolve_browse_bs_id(request: Request, source_order=None) -> str:
    return _resolve_browse_bs_context(request, source_order=source_order)[0]


def _get_browse_session(bs_id: str):
    session = _browse_sessions.get(bs_id)
    if session and time.time() > session.get("expires", 0):
        _browse_sessions.pop(bs_id, None)
        session = None
    return session


def _resolve_browse_session(request: Request, preferred_username: str = "", source_order=None):
    candidates = _resolve_browse_bs_candidates(request, source_order=source_order)
    session = None
    wanted = (preferred_username or "").strip().lower()
    if wanted:
        for bs_id, bs_source in candidates:
            session = _get_browse_session(bs_id)
            if session and (session.get("username") or "").strip().lower() == wanted:
                return bs_id, session, bs_source
    for bs_id, bs_source in candidates:
        session = _get_browse_session(bs_id)
        if session:
            return bs_id, session, bs_source
    bs_id, bs_source = candidates[0] if candidates else ("", "none")
    return bs_id, session, bs_source


def _set_browse_session_cookie(response: Response, bs_id: str):
    if not bs_id:
        return response
    response.delete_cookie(key=_BROWSE_SESSION_COOKIE, path="/")
    response.delete_cookie(key=_BROWSE_SESSION_COOKIE, path="/admin")
    response.set_cookie(
        key=_BROWSE_SESSION_COOKIE,
        value=bs_id,
        max_age=_BROWSE_SESSION_TTL,
        path="/",
        httponly=True,
        samesite="lax",
    )
    return response


def _apply_no_store_headers(response: Response):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


def _rewrite_site_root_url(url: str, site_prefix: str) -> str:
    if not url or not url.startswith("/"):
        return url
    if url.startswith("//"):
        return url
    if url.startswith(site_prefix) or url.startswith("/admin/ak-rpc") or url.startswith("/admin"):
        return url
    if url.startswith("/RPC"):
        if _use_native_ak_rpc(site_prefix):
            return url
        return "/admin/ak-rpc" + url[4:]
    return site_prefix + url


def _rewrite_site_html_roots(text: str, site_prefix: str) -> str:
    pattern = re.compile(r'(?P<prefix>\b(?:src|href|action|poster)=\s*["\'])(?P<url>/[^"\'>\r\n]*)(?P<suffix>["\'])', re.IGNORECASE)
    return pattern.sub(lambda m: f"{m.group('prefix')}{_rewrite_site_root_url(m.group('url'), site_prefix)}{m.group('suffix')}", text)


def _rewrite_site_css_roots(text: str, site_prefix: str) -> str:
    pattern = re.compile(r'url\((?P<quote>["\']?)(?P<url>/[^)"\']+)(?P=quote)\)', re.IGNORECASE)
    return pattern.sub(lambda m: f"url({m.group('quote')}{_rewrite_site_root_url(m.group('url'), site_prefix)}{m.group('quote')})", text)


def _extract_debug_snippet(text: str, needle: str, radius: int = 120) -> str:
    idx = text.find(needle)
    if idx < 0:
        return ""
    start = max(0, idx - radius)
    end = min(len(text), idx + len(needle) + radius)
    return text[start:end]


def _rewrite_base_js_rpc_roots(text: str) -> tuple[str, bool]:
    rewritten = re.sub(r'https?://[^/"\'\s]+/RPC/', '/admin/ak-rpc/', text, flags=re.IGNORECASE)
    return rewritten, rewritten != text


def _rewrite_base_js_native_rpc_roots(text: str) -> tuple[str, bool]:
    rewritten = re.sub(r'https?://[^/"\'\s]+/RPC/', '/RPC/', text, flags=re.IGNORECASE)
    return rewritten, rewritten != text


def _inject_base_js_no_login_probe(text: str) -> tuple[str, bool]:
    text, rewritten = _rewrite_base_js_rpc_roots(text)
    marker = "[AKBaseNoLogin]"
    if marker in text:
        return text, rewritten
    probe = (
        "(function(){"
        "try{if(window.__akBaseNoLoginProbeInstalled)return;window.__akBaseNoLoginProbeInstalled=true;"
        "function akBaseUserKey(){try{return(window.APP&&APP.USER&&APP.USER.MODEL&&APP.USER.MODEL.Key)||'';}catch(_e){return '';}}"
        "function akBaseBody(body){try{if(body==null)return null;if(typeof body==='string')return body.slice(0,500);if(typeof URLSearchParams!=='undefined'&&body instanceof URLSearchParams)return body.toString().slice(0,500);if(typeof FormData!=='undefined'&&body instanceof FormData){var out=[];body.forEach(function(v,k){out.push([k,typeof v==='string'?v:String(v)]);});return JSON.stringify(out).slice(0,500);}if(typeof body==='object')return JSON.stringify(body).slice(0,500);return String(body).slice(0,500);}catch(_e){try{return String(body).slice(0,500);}catch(__e){return '[unserializable]';}}}"
        "function akBaseHasNoLogin(body){try{if(body==null)return false;var txt=typeof body==='string'?body:String(body),norm=txt.toLowerCase().replace(/\\s+/g,'');if(txt.indexOf('用戶未登錄')>=0)return true;return norm.indexOf('\\\"islogin\\\":false')>=0&&norm.indexOf('\\\"error\\\":true')>=0;}catch(_e){return false;}}"
        "function akBaseEmit(meta){try{if(window.console&&typeof console.warn==='function'){console.warn('[AKBaseNoLogin]',meta);}}catch(_e){}}"
        "function akBaseRw(url){try{var s=String(url||'');if(!s)return s;var x=new URL(s,location.href),p=(x.pathname||'');if(p.indexOf('/RPC/')!==0)return s;return '/admin/ak-rpc/'+p.slice(5)+x.search+x.hash;}catch(_e){var s2=String(url||'');if(s2.indexOf('/RPC/')===0)return '/admin/ak-rpc/'+s2.slice(5);return s2;}}"
        "var xo=XMLHttpRequest.prototype.open,xs=XMLHttpRequest.prototype.send;"
        "XMLHttpRequest.prototype.open=function(method,url){var nextUrl=akBaseRw(url||'');this.__akBaseMethod=method||'GET';this.__akBaseUrl=nextUrl||'';return xo.apply(this,[method,nextUrl].concat([].slice.call(arguments,2)));};"
        "XMLHttpRequest.prototype.send=function(body){try{this.__akBaseBody=akBaseBody(body);}catch(_e){}if(!this.__akBaseNoLoginBound){this.__akBaseNoLoginBound=true;this.addEventListener('loadend',function(){try{var resp=this.responseText||this.response||'';if(!akBaseHasNoLogin(resp))return;akBaseEmit({transport:'xhr',method:this.__akBaseMethod||'',optionUrl:this.__akBaseUrl||'',actualUrl:this.responseURL||'',status:this.status||0,data:this.__akBaseBody||null,userkey:akBaseUserKey(),responseHead:String(resp).slice(0,300),current:location.href});}catch(__e){}});}return xs.apply(this,arguments);};"
        "if(typeof window.fetch==='function'){var of=window.fetch;window.fetch=function(input,init){var method='GET',url='',body=null;try{if(typeof input==='string'){url=input;method=(init&&init.method)||'GET';body=init&&Object.prototype.hasOwnProperty.call(init,'body')?init.body:null;input=url;}else if(input&&typeof input==='object'){url=input.url||'';method=(init&&init.method)||(input.method)||'GET';body=init&&Object.prototype.hasOwnProperty.call(init,'body')?init.body:(Object.prototype.hasOwnProperty.call(input,'_bodyInit')?input._bodyInit:null);if(url!==(input.url||''))input=new Request(url,input);}}catch(_e){}return of.apply(this,[input,init]).then(function(resp){try{resp.clone().text().then(function(txt){if(!akBaseHasNoLogin(txt))return;akBaseEmit({transport:'fetch',method:method||'GET',optionUrl:url||'',actualUrl:(resp&&resp.url)||'',status:(resp&&resp.status)||0,data:akBaseBody(body),userkey:akBaseUserKey(),responseHead:String(txt).slice(0,300),current:location.href});}).catch(function(){});}catch(_e){}return resp;});};}"
        "}catch(__akBaseProbeError){}})();"
    )
    return probe + text, True


async def _load_cached_ak_auth(username: str, password: str = "") -> dict:
    username = (username or "").strip()
    if not username:
        return {}
    cached = _ak_auth_cache.get(username)
    if cached and time.time() < cached.get("expires", 0):
        if password and not cached.get("password"):
            cached["password"] = password
        return cached
    _ak_auth_cache.pop(username, None)
    persisted = None
    try:
        persisted = await db.load_ak_auth_state(username)
    except Exception as e:
        logger.warning(f"[AKAuth] 读取持久化登录态失败 {username}: {e}")
        persisted = None
    if not persisted:
        return {}
    cached = {
        "cookies": dict(persisted.get("cookies", {})),
        "userkey": persisted.get("userkey", ""),
        "login_result": persisted.get("login_result", {}),
        "password": password,
        "expires": time.time() + _BROWSE_SESSION_TTL,
    }
    _ak_auth_cache[username] = cached
    return cached


@app.post("/admin/api/ak_auth/clear")
async def admin_clear_ak_auth(request: Request):
    data = await request.json()
    username = (data.get("username") or "").strip().lower()
    if not username:
        return JSONResponse({"success": False, "message": "缺少用户名"})
    _ak_auth_cache.pop(username, None)
    try:
        await db.clear_ak_auth_state(username)
    except Exception as e:
        return JSONResponse({"success": False, "message": f"清理失败: {str(e)}"})
    return JSONResponse({"success": True})


@app.get("/admin/api/ak_test")
async def admin_ak_test():
    """调试：对比两种httpx调用方式的结果，精确定位302来源"""
    url = f"{_AK_BASE}/pages/account/login.html"
    hdrs = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    results = {}
    # 方式A：c.get() + follow_redirects在构造函数
    try:
        async with httpx.AsyncClient(verify=False, follow_redirects=True, timeout=15) as c:
            r = await c.get(url, headers=hdrs)
        results["A_get_constructor"] = {
            "status": r.status_code, "final_url": str(r.url),
            "content_len": len(r.content),
            "head": r.content[:100].decode("utf-8", errors="replace"),
        }
    except Exception as e:
        results["A_get_constructor"] = {"error": str(e)}
    # 方式B：client.request() + follow_redirects在request()参数（同ak_web_proxy当前代码）
    try:
        async with httpx.AsyncClient(verify=False, timeout=15, cookies={}) as c:
            r = await c.request("GET", url, headers=hdrs, content=None, follow_redirects=True)
        results["B_request_param"] = {
            "status": r.status_code, "final_url": str(r.url),
            "content_len": len(r.content),
            "head": r.content[:100].decode("utf-8", errors="replace"),
        }
    except Exception as e:
        results["B_request_param"] = {"error": str(e)}
    return results


async def _forward_admin_ak_rpc_request(path: str, request: Request, session: dict,
                                        referer: str = "", fetch_dest: str = "", accept: str = ""):
    content_type = request.headers.get("content-type", "")
    raw_body = await request.body() if request.method in ["POST", "PUT"] else b""
    query_params = {k: v for k, v in dict(request.query_params).items() if k != "bs"}
    params = parse_request_params(content_type, query_params, raw_body)
    is_login_path = path.strip("/").lower() == "login"
    normalized_path = path.strip("/").lower()
    protected_paths = {
        "public_ep_sellrecords1",
        "public_ep_sellrecords2",
        "public_ep_sellrecords3",
        "question_get1",
        "check_transactionpassword",
        "check_answer",
        "logout",
    }
    trace_paths = {
        "public_ace",
        "public_ep_sellrecords1",
        "question_get1",
    }
    trace_params_before = dict(params) if normalized_path in trace_paths else None
    auth_replaced = False
    selected_exit = None
    pinned_exit_name = str(session.get("ak_exit_name") or "").strip()
    if _ADMIN_AK_FORCE_DIRECT:
        selected_exit = _get_direct_exit()
        session.pop("ak_exit_name", None)
        _admin_ak_trace(lambda: (
            f"[AdminAkRpcExit/{path}] force_direct=1 preferred={pinned_exit_name or '-'} "
            f"using={selected_exit.name} referer={referer}"
        ))
    else:
        selected_exit = _select_forward_exit(path, is_login=is_login_path, preferred_exit_name=pinned_exit_name)
        _admin_ak_trace(lambda: (
            f"[AdminAkRpcExit/{path}] pinned={int(bool(pinned_exit_name))} preferred={pinned_exit_name or '-'} "
            f"using={selected_exit.name} referer={referer}"
        ))
    if trace_params_before is not None:
        _admin_ak_trace(lambda: (
            f"[AdminAkRpcParams/{path}] phase=incoming referer={referer} "
            f"params={json.dumps(trace_params_before, ensure_ascii=False)}"
        ))
    if normalized_path in protected_paths:
        login_result = session.get("login_result", {})
        if not isinstance(login_result, dict):
            login_result = {}
        user_data = login_result.get("UserData")
        if not isinstance(user_data, dict):
            user_data = {}
        session_userkey = str(session.get("userkey") or _extract_login_result_userkey(login_result) or "").strip()
        session_user_id = str(user_data.get("Id") or user_data.get("ID") or "").strip()
        current_key = str(params.get("key") or "").strip()
        current_user_id = str(params.get("UserID") or params.get("userid") or "").strip()
        if session_userkey and current_key != session_userkey:
            params["key"] = session_userkey
            auth_replaced = True
        if session_user_id and current_user_id != session_user_id:
            params["UserID"] = session_user_id
            params.pop("userid", None)
            auth_replaced = True
        if auth_replaced and request.method in ["POST", "PUT"]:
            if "application/json" in content_type:
                raw_body = json.dumps(params, ensure_ascii=False).encode("utf-8")
            else:
                raw_body = urlencode(params).encode("utf-8")
        _admin_ak_trace(lambda: (
            f"[AdminAkRpcAuth/{path}] replaced={int(auth_replaced)} key={str(params.get('key') or '')[:8]} "
            f"userId={str(params.get('UserID') or params.get('userid') or '')} referer={referer}"
        ))
    if trace_params_before is not None:
        _admin_ak_trace(lambda: (
            f"[AdminAkRpcParams/{path}] phase=forward referer={referer} "
            f"params={json.dumps(params, ensure_ascii=False)}"
        ))
    headers = dict(request.headers)
    headers = _apply_ak_rpc_browser_headers(headers, request, referer=referer)
    _admin_ak_trace(lambda: (
        f"[AdminAkRpcHeaders/{path}] origin={headers.get('origin', '-') or '-'} "
        f"referer={headers.get('referer', '-') or '-'} "
        f"fetch={headers.get('sec-fetch-site', '-') or '-'}/{headers.get('sec-fetch-mode', '-') or '-'}/{headers.get('sec-fetch-dest', '-') or '-'}"
    ))
    cookie_header = _build_cookie_header(session.get("cookies", {}))
    if cookie_header:
        headers["cookie"] = cookie_header

    response = await forward_request(
        request.method, path, content_type, params, raw_body, headers,
        client_ip=request.client.host if request.client else "admin-panel",
        is_login=is_login_path,
        selected_exit=selected_exit,
        force_direct=_ADMIN_AK_FORCE_DIRECT
    )
    set_cookie_values = response.headers.get_list("set-cookie")
    for sc in response.headers.get_list("set-cookie"):
        kv = sc.split(";", 1)[0].strip()
        if "=" in kv:
            ck, cv = kv.split("=", 1)
            session["cookies"][ck.strip()] = cv.strip()
    try:
        result = response.json()
        should_persist = bool(set_cookie_values)
        is_login_success = is_login_path and (result.get("Error") is False or (not result.get("Error") and result.get("UserData")))
        if is_login_success:
            account = (params.get("account") or params.get("username") or session.get("username") or "").strip()
            password = (params.get("password") or session.get("password") or "").strip()
            cached = _cache_ak_auth(account, password, result, response.headers)
            await _apply_cached_auth_to_browse_session(session, cached, result, account, password)
            if selected_exit and not _ADMIN_AK_FORCE_DIRECT:
                session["ak_exit_name"] = selected_exit.name
                _admin_ak_trace(lambda: f"[AdminAkRpcExit/{path}] bind={selected_exit.name} referer={referer}")
            _admin_ak_trace(lambda: (
                f"[AdminAkRpcLoginCookies/{path}] bs={session.get('id', '')} set_cookie_count={len(cached.get('cookies', {}))} "
                f"set_cookie_names={_summarize_cookie_names(cached.get('cookies', {}))} "
                f"session_cookie_count={len(session.get('cookies', {}))} "
                f"session_cookie_names={_summarize_cookie_names(session.get('cookies', {}))}"
            ))
            should_persist = True
        if should_persist:
            await _persist_browse_session_auth(session)
        if is_login_path:
            _admin_ak_trace(lambda: f"[IframeLoginApi] route=/admin/ak-rpc/Login phase=response status={response.status_code} referer={referer} body_head={json.dumps(result, ensure_ascii=False)[:200]}")
        _admin_ak_trace(lambda: f"[AdminAkRpc/{path}] status={response.status_code} dest={fetch_dest} accept={accept} referer={referer} body_head={json.dumps(result, ensure_ascii=False)[:200]}")
        proxy_response = JSONResponse(content=result, status_code=response.status_code)
        return _mirror_upstream_set_cookies(proxy_response, response.headers)
    except Exception:
        if set_cookie_values:
            await _persist_browse_session_auth(session)
        _admin_ak_trace(lambda: f"[AdminAkRpc/{path}] status={response.status_code} dest={fetch_dest} accept={accept} referer={referer} content_type={response.headers.get('content-type','')}")
        proxy_response = Response(content=response.content, status_code=response.status_code,
                        media_type=response.headers.get("content-type", "application/octet-stream"))
        return _mirror_upstream_set_cookies(proxy_response, response.headers)


@app.api_route("/admin/ak-rpc/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def admin_ak_rpc(path: str, request: Request):
    referer = request.headers.get("referer", "")
    fetch_dest = request.headers.get("sec-fetch-dest", "")
    accept = request.headers.get("accept", "")
    cookie_bs = (request.cookies.get(_BROWSE_SESSION_COOKIE) or "").strip()
    preferred_username = ""
    if path.strip("/").lower() == "login":
        content_type = request.headers.get("content-type", "")
        raw_body = await request.body() if request.method in ["POST", "PUT"] else b""
        params = parse_request_params(content_type, dict(request.query_params), raw_body)
        preferred_username = str(params.get("account") or params.get("username") or "").strip()
    bs_id, session, bs_source = _resolve_browse_session(
        request,
        preferred_username=preferred_username,
        source_order=("cookie",),
    )
    if path.strip("/").lower() == "login":
        _admin_ak_trace(lambda: f"[IframeLoginApi] route=/admin/ak-rpc/Login phase=request bs={bs_id} source={bs_source} cookie_bs={cookie_bs} referer={referer}")
    if not session:
        logger.warning(f"[AdminAkRpc/{path}] no_session bs={bs_id} source={bs_source} cookie_bs={cookie_bs} dest={fetch_dest} accept={accept} referer={referer}")
        return JSONResponse({"Error": True, "IsLogin": False, "Msg": "用戶未登錄"})

    try:
        return await _forward_admin_ak_rpc_request(path, request, session, referer, fetch_dest, accept)
    except Exception as e:
        logger.error(f"[AdminAkRpc/{path}] 转发失败: {e}")
        return JSONResponse({"Error": True, "IsLogin": False, "Msg": f"请求失败: {str(e)}"}, status_code=500)


def _create_browse_session(username: str, password: str, extra: Optional[dict] = None):
    bs_id = secrets.token_hex(16)
    session = {
        "id": bs_id,
        "cookies": {},
        "username": username,
        "password": password,
        "userkey": "",
        "login_result": {},
        "expires": time.time() + _BROWSE_SESSION_TTL,
    }
    if extra:
        session.update(dict(extra))
    _browse_sessions[bs_id] = session
    return bs_id, session


@app.post("/admin/api/browse_login")
async def admin_browse_login(request: Request):
    """为后台内嵌网页创建全新浏览 session，始终从登录页进入"""
    data = await request.json()
    username = data.get("username", "").strip()
    if not username:
        return JSONResponse({"success": False, "message": "缺少用户名"})
    password = await db.get_user_password(username)
    if not password:
        return JSONResponse({"success": False, "message": f"用户 {username} 无密码记录"})
    try:
        bs_id, _ = _create_browse_session(username, password)
        return _set_browse_session_cookie(
            JSONResponse({"success": True, "bs_id": bs_id}),
            bs_id,
        )
    except Exception as e:
        return JSONResponse({"success": False, "message": f"登录失败: {str(e)}"})


@app.post("/admin/api/remote_assist/start")
async def admin_remote_assist_start(request: Request):
    token, role, admin_name = await _resolve_admin_identity(request)
    if not token or not role:
        return JSONResponse({"success": False, "message": "未登录或登录已失效"}, status_code=401)
    if not remote_assist.is_enabled() or not remote_assist.supports_site("ak_web"):
        return JSONResponse({"success": False, "message": "远程指导未启用"}, status_code=503)
    data = await request.json()
    username = (data.get("username") or "").strip()
    if not username:
        return JSONResponse({"success": False, "message": "缺少用户名"})
    session = remote_assist.find_session_by_target_username(username)
    if session and not _assist_session_has_connected_admin(session):
        _cancel_remote_assist_auto_unbind(session.session_id)
        remote_assist.close_session(session.session_id)
        session = None
    if session and role != ROLE_SUPER_ADMIN and session.admin_username != (admin_name or role):
        return JSONResponse({"success": False, "message": f"用户 {username} 已有进行中的远程指导"}, status_code=409)
    created_new_session = False
    if not session:
        session = remote_assist.create_session(
            site_type="ak_web",
            target_username=username,
            admin_username=admin_name or role,
            readonly=True,
            consent_status=AssistConsentStatus.WAITING,
            metadata={"admin_role": role},
        )
        created_new_session = bool(session)
    if not session:
        return JSONResponse({"success": False, "message": "创建远程指导会话失败"}, status_code=500)
    if not online_manager.get_user(username):
        if created_new_session:
            remote_assist.close_session(session.session_id)
        return JSONResponse({"success": False, "message": f"用户 {username} 当前不在线，无法发起远程指导"}, status_code=409)
    if not online_manager.pick_remote_assist_connection(username):
        if created_new_session:
            remote_assist.close_session(session.session_id)
        return JSONResponse({"success": False, "message": f"用户 {username} 当前没有可接收远程指导的已登录页面"}, status_code=409)
    response = JSONResponse({
        "success": True,
        "session_id": session.session_id,
        "target_username": username,
        "readonly": True,
        "site": "ak_web",
        "mode": "html_snapshot",
        "consent_status": getattr(session.consent_status, 'value', AssistConsentStatus.ACCEPTED.value),
    })
    delivered = await (_send_remote_assist_bind_to_user(session) if _assist_session_has_accepted_consent(session) else _send_remote_assist_request_to_user(session))
    if not delivered:
        _cancel_remote_assist_auto_unbind(session.session_id)
        remote_assist.close_session(session.session_id)
        failure_message = f"用户 {username} 远程指导请求下发失败，请稍后重试"
        if _assist_session_has_accepted_consent(session):
            failure_message = f"用户 {username} 远程指导绑定失败，请稍后重试"
        return JSONResponse({"success": False, "message": failure_message}, status_code=409)
    return response


@app.post("/admin/api/remote_assist/close")
async def admin_remote_assist_close(request: Request):
    token, role, admin_name = await _resolve_admin_identity(request)
    if not token or not role:
        return JSONResponse({"success": False, "message": "未登录或登录已失效"}, status_code=401)
    data = await request.json()
    session_id = (data.get("session_id") or "").strip()
    if not session_id:
        return JSONResponse({"success": False, "message": "缺少会话ID"})
    session = remote_assist.get_session(session_id)
    if not session:
        return JSONResponse({"success": False, "message": "远程指导会话不存在"}, status_code=404)
    if role != ROLE_SUPER_ADMIN and session.admin_username != (admin_name or role):
        return JSONResponse({"success": False, "message": "无权关闭该远程指导会话"}, status_code=403)
    _cancel_remote_assist_auto_unbind(session.session_id)
    await _send_remote_assist_unbind_to_user(session)
    await _close_remote_voice_for_assist_session(session, status=VoiceSessionStatus.CLOSED)
    remote_assist.close_session(session_id)
    return JSONResponse({"success": True})


@app.get("/admin/api/remote_voice/config")
async def admin_remote_voice_config(request: Request):
    token, role, admin_name = await _resolve_admin_identity(request)
    if not token or not role:
        return JSONResponse({"success": False, "message": "未登录或登录已失效"}, status_code=401)
    return JSONResponse(remote_voice.get_config_snapshot())


@app.post("/admin/api/remote_voice/config")
async def admin_remote_voice_config_update(request: Request):
    token, role, admin_name = await _resolve_admin_identity(request)
    if not token or not role:
        return JSONResponse({"success": False, "message": "未登录或登录已失效"}, status_code=401)
    if role != ROLE_SUPER_ADMIN:
        return JSONResponse({"success": False, "message": "仅系统总管理员可修改实时语音并发上限"}, status_code=403)
    data = await request.json()
    try:
        max_active_sessions = int(data.get("max_active_sessions") or 0)
    except Exception:
        max_active_sessions = 0
    if max_active_sessions < 1:
        return JSONResponse({"success": False, "message": "并发上限必须大于等于 1"}, status_code=400)
    snapshot = remote_voice.update_limit(max_active_sessions, updated_by='super_admin')
    snapshot["message"] = f"实时语音并发上限已更新为 {snapshot['max_active_sessions']} 路"
    return JSONResponse(snapshot)


@app.get("/admin/api/remote_voice/usage")
async def admin_remote_voice_usage(request: Request):
    token, role, admin_name = await _resolve_admin_identity(request)
    if not token or not role:
        return JSONResponse({"success": False, "message": "未登录或登录已失效"}, status_code=401)
    if role != ROLE_SUPER_ADMIN:
        return JSONResponse({"success": False, "message": "仅系统总管理员可查看实时语音账号明细"}, status_code=403)
    return JSONResponse(remote_voice.get_usage_snapshot(include_sessions=True))


@app.get("/admin/api/remote_voice/status")
async def admin_remote_voice_status(request: Request):
    token, role, admin_name = await _resolve_admin_identity(request)
    if not token or not role:
        return JSONResponse({"success": False, "message": "未登录或登录已失效"}, status_code=401)
    assist_session_id = (request.query_params.get("assist_session_id") or "").strip()
    if not assist_session_id:
        return JSONResponse({"success": False, "message": "缺少远程指导会话ID"}, status_code=400)
    assist_session = remote_assist.get_session(assist_session_id)
    if assist_session and role != ROLE_SUPER_ADMIN and assist_session.admin_username != (admin_name or role):
        return JSONResponse({"success": False, "message": "无权查看该实时语音会话状态"}, status_code=403)
    voice_session = remote_voice.get_session_by_assist(assist_session_id)
    if not voice_session:
        return JSONResponse({
            "success": True,
            "assist_session_id": assist_session_id,
            "active": False,
            "voice_session_id": "",
            "status": "",
            "admin_muted": False,
            "user_muted": False,
            "connected_roles": [],
        })
    connected_roles = sorted(await remote_voice_signal_bus.get_roles(voice_session.voice_session_id))
    return JSONResponse({
        "success": True,
        "assist_session_id": assist_session_id,
        "active": voice_session.is_counted(),
        "voice_session_id": voice_session.voice_session_id,
        "status": voice_session.status.value,
        "admin_muted": bool(getattr(voice_session, 'admin_muted', False)),
        "user_muted": bool(getattr(voice_session, 'user_muted', False)),
        "connected_roles": connected_roles,
    })


@app.post("/admin/api/remote_voice/start")
async def admin_remote_voice_start(request: Request):
    token, role, admin_name = await _resolve_admin_identity(request)
    if not token or not role:
        return JSONResponse({"success": False, "message": "未登录或登录已失效"}, status_code=401)
    data = await request.json()
    assist_session_id = (data.get("assist_session_id") or "").strip()
    if not assist_session_id:
        return JSONResponse({"success": False, "message": "缺少远程指导会话ID"}, status_code=400)
    assist_session = remote_assist.get_session(assist_session_id)
    if not assist_session:
        return JSONResponse({"success": False, "message": "远程指导会话不存在"}, status_code=404)
    if role != ROLE_SUPER_ADMIN and assist_session.admin_username != (admin_name or role):
        return JSONResponse({"success": False, "message": "无权发起该实时语音会话"}, status_code=403)
    if not _assist_session_has_accepted_consent(assist_session):
        return JSONResponse({"success": False, "message": "用户尚未接受远程指导，暂无法发起实时语音"}, status_code=409)
    target = _resolve_remote_assist_bound_connection(assist_session) or _resolve_remote_assist_request_connection(assist_session)
    if not target:
        return JSONResponse({"success": False, "message": f"用户 {assist_session.target_username} 当前没有可接收实时语音的页面"}, status_code=409)
    display_admin_name = 'super_admin' if assist_session.admin_username == '__super__' else assist_session.admin_username
    voice_session, created_new, error_code = remote_voice.start_session(
        assist_session_id=assist_session.session_id,
        site_type=assist_session.site_type,
        admin_username=display_admin_name,
        target_username=assist_session.target_username,
        admin_role=role,
        request_chat_ws_id=str(target.get('ws_id') or ''),
        request_chat_page_id=_get_connection_page_client_id(target),
        metadata={"assist_admin_username": assist_session.admin_username},
    )
    if error_code == 'voice_limit_reached':
        snapshot = remote_voice.get_config_snapshot()
        return JSONResponse({
            "success": False,
            "code": "voice_limit_reached",
            "message": "当前实时语音使用人数超过上限，请稍后重试",
            "current_sessions": snapshot.get("current_sessions", 0),
            "max_active_sessions": snapshot.get("max_active_sessions", 0),
        }, status_code=409)
    if not voice_session:
        return JSONResponse({"success": False, "message": "创建实时语音会话失败"}, status_code=500)
    if created_new:
        delivered = await _send_remote_voice_request_to_user(voice_session)
        if not delivered:
            remote_voice.mark_failed(voice_session.voice_session_id)
            return JSONResponse({"success": False, "message": f"用户 {assist_session.target_username} 语音邀请下发失败，请稍后重试"}, status_code=409)
    snapshot = remote_voice.get_config_snapshot()
    return JSONResponse({
        "success": True,
        "message": "已向用户发送语音邀请" if created_new else "当前远程指导已存在实时语音会话",
        "voice_session_id": voice_session.voice_session_id,
        "assist_session_id": voice_session.assist_session_id,
        "status": voice_session.status.value,
        "current_sessions": snapshot.get("current_sessions", 0),
        "max_active_sessions": snapshot.get("max_active_sessions", 0),
    })


@app.post("/admin/api/remote_voice/close")
async def admin_remote_voice_close(request: Request):
    token, role, admin_name = await _resolve_admin_identity(request)
    if not token or not role:
        return JSONResponse({"success": False, "message": "未登录或登录已失效"}, status_code=401)
    data = await request.json()
    voice_session_id = (data.get("voice_session_id") or "").strip()
    assist_session_id = (data.get("assist_session_id") or "").strip()
    voice_session = remote_voice.get_session(voice_session_id) if voice_session_id else remote_voice.get_session_by_assist(assist_session_id)
    if not voice_session:
        return JSONResponse({"success": False, "message": "实时语音会话不存在"}, status_code=404)
    if role != ROLE_SUPER_ADMIN and voice_session.admin_username != (admin_name or role):
        return JSONResponse({"success": False, "message": "无权关闭该实时语音会话"}, status_code=403)
    closed_session = remote_voice.close_session(voice_session.voice_session_id, status=VoiceSessionStatus.CLOSED)
    if not closed_session:
        return JSONResponse({"success": False, "message": "实时语音会话不存在"}, status_code=404)
    await remote_voice_signal_bus.publish(
        closed_session.voice_session_id,
        _build_remote_voice_signal_message(
            closed_session,
            'hangup',
            {
                'reason': 'admin_close',
                'status': closed_session.status.value,
            },
        ),
    )
    await _publish_remote_voice_session_state(closed_session)
    await _send_remote_voice_unbind_to_user(closed_session)
    return JSONResponse({
        "success": True,
        "voice_session_id": closed_session.voice_session_id,
        "status": closed_session.status.value,
    })


def _build_injector(bs_id: str, username: str = "", password: str = "", userkey: str = "", login_result: dict = None,
                    site_prefix: str = _AK_SITE_PREFIX) -> str:
    """生成注入到 HTML 的 JS 拦截器：劫持 fetch/XHR + 自动登录（如在登录页）"""
    safe_user = username.replace("\\", "\\\\").replace("'", "\\'")
    safe_pwd = password.replace("\\", "\\\\").replace("'", "\\'")
    login_result_json = json.dumps(login_result or {}, ensure_ascii=False).replace("</", "<\\/")
    user_model_json = json.dumps(_build_ak_user_model(login_result or {}, userkey), ensure_ascii=False).replace("</", "<\\/")
    local_login_info_json = json.dumps(_build_ak_local_login_info(username, password), ensure_ascii=False).replace("</", "<\\/")
    api_base_storage = AKAPI_URL if AKAPI_URL.endswith("/") else AKAPI_URL + "/"
    ak_list = ",".join(
        f"'{d}'" for d in [_AK_BASE, "https://ak928.vip", "http://ak928.vip",
                           "https://www.ak928.vip", "https://k937.com", "http://k937.com"]
    )
    # AK API 基础 URL，去掉末尾斜杠
    api_base = AKAPI_URL.rstrip("/")
    auto_login = ""
    if safe_user and safe_pwd:
        auto_login = (
            "var _t=0,_iv=setInterval(function(){"
            "if(++_t>100){clearInterval(_iv);return;}"
            "if(typeof _vue!=='undefined'&&_vue&&_vue.form&&!_vue.isLogin){"
            "clearInterval(_iv);"
            "_vue.form.account='" + safe_user + "';"
            "_vue.form.password='" + safe_pwd + "';"
            "setTimeout(function(){"
            "_vue.checkInput&&_vue.checkInput();"
            "try{if(typeof _vue.login==='function'){_vue.login();return;}if(typeof _vue.Login==='function'){_vue.Login();return;}if(typeof _vue.submit==='function'){_vue.submit();return;}if(typeof _vue.onSubmit==='function'){_vue.onSubmit();return;}}catch(_e){}"
            "var _btn=document.querySelector('button[type=submit],.login-btn,.btn-login,.el-button--primary');if(_btn){_btn.click();}"
            "},200);"
            "}"
            "},100);"
        )
    js = (
        "<script>(function(){"
        "if('serviceWorker' in navigator){navigator.serviceWorker.register=function(){return Promise.reject(new Error('SW disabled'));};}"
        "try{var UK=" + json.dumps(userkey or "", ensure_ascii=False) + ";var LR=" + login_result_json + ";var UM=" + user_model_json + ";var LI=" + local_login_info_json + ";var RPC='/admin/ak-rpc/';var P=" + json.dumps(site_prefix, ensure_ascii=False) + ";var B='" + bs_id + "';var LS=[localStorage,sessionStorage];var HA=!!(UK||(UM&&typeof UM==='object'&&(UM.Key||UM.key||UM.Id||UM.id))||(LR&&typeof LR==='object'&&LR.UserData&&typeof LR.UserData==='object'&&(LR.UserData.Id||LR.UserData.ID||LR.UserData.Key||LR.UserData.key)));var BK=['AKapp_base_url','AK_local_login_info'];var AK=['AK_user_model','userkey','UserKey','ak_login_result','UserData'];for(var si=0;si<LS.length;si++){for(var bi=0;bi<BK.length;bi++){try{LS[si].removeItem(BK[bi]);}catch(__e){}}if(HA){for(var ai=0;ai<AK.length;ai++){try{LS[si].removeItem(AK[ai]);}catch(__e){}}}try{LS[si].setItem('AKapp_base_url',RPC);}catch(__e){}try{LS[si].setItem('AK_local_login_info',JSON.stringify(LI||[]));}catch(__e){}if(HA){try{LS[si].setItem('AK_user_model',JSON.stringify(UM&&typeof UM==='object'?UM:{}));}catch(__e){}try{LS[si].setItem('userkey',UK||'');LS[si].setItem('UserKey',UK||'');}catch(__e){}try{LS[si].setItem('ak_login_result',JSON.stringify(LR&&typeof LR==='object'?LR:{}));}catch(__e){}try{LS[si].setItem('UserData',JSON.stringify(LR&&typeof LR==='object'&&LR.UserData&&typeof LR.UserData==='object'?LR.UserData:{}));}catch(__e){}}}if(HA){window.USER_MODEL=UM&&typeof UM==='object'?UM:{};window.userkey=UK||'';if(window.APP&&APP.USER){APP.USER.MODEL=UM&&typeof UM==='object'?Object.assign({},UM):{};}}try{var cur=new URL(location.href);if(cur.pathname.indexOf(P+'/pages/')===0&&cur.searchParams.get('bs')){cur.searchParams.delete('bs');history.replaceState(null,'',cur.pathname+cur.search+cur.hash);}}catch(__e){}}catch(_e){}"
        "try{(function(){if(window.__akBsRouteTrace)return;window.__akBsRouteTrace=1;var LH=location.href;function nu(u,b){try{return new URL(String(u||''),b||location.href);}catch(__e){return null;}}function tr(k,o,n){try{var x=nu(n,o),p=nu(o);if(!x||x.pathname.indexOf(P+'/pages/')!==0)return;var obs=p?(p.searchParams.get('bs')||''):'';var nbs=x.searchParams.get('bs')||'';if(o===n&&obs===nbs)return;console.warn('[AkBsRouteTrace]',{kind:k,oldUrl:String(o||''),newUrl:x.pathname+x.search+x.hash,currentB:B,newBs:nbs,stack:String(new Error().stack||'').slice(0,400)});}catch(__e){}}function sync(k){try{var cur=location.href;if(cur!==LH){tr(k||'href-change',LH,cur);LH=cur;}}catch(__e){}}try{var hp=history.pushState;if(hp&&!hp.__akBsTraceWrapped){var wp=function(){var o=location.href,r=hp.apply(history,arguments);var a=arguments.length>2?String(arguments[2]||location.href):location.href;tr('pushState',o,a);sync('pushState:after');return r;};wp.__akBsTraceWrapped=1;history.pushState=wp;}}catch(__e){}try{var hr=history.replaceState;if(hr&&!hr.__akBsTraceWrapped){var wr=function(){var o=location.href,r=hr.apply(history,arguments);var a=arguments.length>2?String(arguments[2]||location.href):location.href;tr('replaceState',o,a);sync('replaceState:after');return r;};wr.__akBsTraceWrapped=1;history.replaceState=wr;}}catch(__e){}try{var la=location.assign;if(la&&!la.__akBsTraceWrapped){location.assign=function(u){tr('location.assign',location.href,u);return la.call(location,u);};location.assign.__akBsTraceWrapped=1;}}catch(__e){}try{var lr=location.replace;if(lr&&!lr.__akBsTraceWrapped){location.replace=function(u){tr('location.replace',location.href,u);return lr.call(location,u);};location.replace.__akBsTraceWrapped=1;}}catch(__e){}try{window.addEventListener('popstate',function(){setTimeout(function(){sync('popstate');},0);},true);}catch(__e){}window.__akBsRouteTraceTimer=setInterval(function(){sync('interval');},100);})();}catch(_e){}"
        "try{(function(){if(window.__akConfigWatchdog)return;var syncConfig=function(){try{if(window.APP&&APP.CONFIG){APP.CONFIG.BASE_URL='/admin/ak-rpc/';if(Object.prototype.hasOwnProperty.call(APP.CONFIG,'API_URL'))APP.CONFIG.API_URL='/admin/ak-rpc/';if(Object.prototype.hasOwnProperty.call(APP.CONFIG,'BASE_Shunt'))APP.CONFIG.BASE_Shunt='/admin/ak-rpc/';return true;}}catch(__e){}return false;};syncConfig();window.__akConfigWatchdog=setInterval(syncConfig,100);})();}catch(_e){}"
        "try{(function(){if(window.__akUserModelWatchdog)return;var syncUserModel=function(){try{if(!HA)return false;if(window.APP&&APP.USER){APP.USER.MODEL=UM&&typeof UM==='object'?Object.assign({},UM):{};return true;}}catch(__e){}return false;};syncUserModel();window.__akUserModelWatchdog=setInterval(syncUserModel,100);})();}catch(_e){}"
        "try{(function(){if(window.__akRpcRewrite)return;window.__akRpcRewrite=1;function rwRpc(u){try{var x=new URL(String(u||''),location.href),p=(x.pathname||'');if(x.origin!==location.origin)return String(u||'');if(p.indexOf('/admin/ak-rpc/')===0)return x.pathname+x.search+x.hash;if(p.indexOf('/RPC/')!==0)return String(u||'');x.pathname='/admin/ak-rpc/'+p.slice(5);return x.pathname+x.search+x.hash;}catch(__e){var s=String(u||'');if(s.indexOf('/RPC/')===0){return '/admin/ak-rpc/'+s.slice(5);}return s;}}function _needsAuth(u){return (u.indexOf('Public_EP_SellRecords')>=0)||(u.indexOf('Question_Get')>=0)||(u.indexOf('Check_TransactionPassword')>=0)||(u.indexOf('Check_Answer')>=0)||(u.indexOf('Logout')>=0);}function _getAuth(){try{var m=(window.APP&&APP.USER&&APP.USER.MODEL&&typeof APP.USER.MODEL==='object'&&APP.USER.MODEL.Key)?APP.USER.MODEL:(UM&&typeof UM==='object'?UM:{});var k=m.Key||m.key||UK||'';var uid=m.Id||m.id||'';return{key:k?String(k):'',userId:uid?String(uid):''};}catch(__e){return{key:'',userId:''};}}var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){var rw=rwRpc(url);this.__akUrl=rw;this.__akNeedsAuth=_needsAuth(String(url||''))||_needsAuth(rw);return xo.apply(this,[method,rw].concat([].slice.call(arguments,2)));};var xs=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(body){if(this.__akNeedsAuth&&(typeof body==='string'||body==null)){try{var bs2=typeof body==='string'?body:'';var auth=_getAuth();if(auth.key||auth.userId){var parts=bs2?bs2.split('&'):[];var d={};for(var i=0;i<parts.length;i++){var eq=parts[i].indexOf('=');if(eq>=0)d[parts[i].slice(0,eq)]=parts[i].slice(eq+1);}var chg=false;if(auth.key&&(!d['key']||d['key']==='123')){d['key']=encodeURIComponent(auth.key);chg=true;}if(auth.userId&&(!d['UserID']||d['UserID']==='123')){d['UserID']=encodeURIComponent(auth.userId);chg=true;}if(chg){var out=[];for(var kk in d){if(Object.prototype.hasOwnProperty.call(d,kk))out.push(kk+'='+d[kk]);}body=out.join('&');}}}catch(__e){}}return xs.call(this,body);};if(typeof window.fetch==='function'){var of=window.fetch;window.fetch=function(input,init){var url='',method='GET';try{if(typeof input==='string'){url=input;method=(init&&init.method)||'GET';}else if(input&&typeof input==='object'){url=input.url||'';method=(init&&init.method)||(input.method)||'GET';}}catch(__e){}var rw=rwRpc(url||'');if(rw!==url&&typeof input==='string'){input=rw;}else if(rw!==url&&input&&typeof input==='object'){input=new Request(rw,input);}return of.call(this,input,init);};}})();}catch(_e){}"
        "try{(function(){if(window.__akAjaxRewriteWatchdog)return;function needTrace(u){return (u.indexOf('RPC/')>=0)||(u.indexOf('Public_ACE')>=0)||(u.indexOf('Public_EP_SellRecords1')>=0)||(u.indexOf('Public_EP_SellRecords2')>=0)||(u.indexOf('Public_EP_SellRecords3')>=0)||(u.indexOf('Public_StockPrice')>=0)||(u.indexOf('Question_Get1')>=0)||(u.indexOf('Check_TransactionPassword')>=0)||(u.indexOf('Check_Answer')>=0)||(u.indexOf('Logout')>=0);}function needsAuth(u){return (u.indexOf('Public_EP_SellRecords1')>=0)||(u.indexOf('Public_EP_SellRecords2')>=0)||(u.indexOf('Public_EP_SellRecords3')>=0)||(u.indexOf('Question_Get1')>=0)||(u.indexOf('Check_TransactionPassword')>=0)||(u.indexOf('Check_Answer')>=0)||(u.indexOf('Logout')>=0);}function getAuth(){try{var m=(window.APP&&APP.USER&&APP.USER.MODEL&&typeof APP.USER.MODEL==='object')?APP.USER.MODEL:(window.USER_MODEL&&typeof window.USER_MODEL==='object'?window.USER_MODEL:(UM&&typeof UM==='object'?UM:{}));var lr=(LR&&typeof LR==='object')?LR:{};var ud=(lr.UserData&&typeof lr.UserData==='object')?lr.UserData:{};var key=(m.Key||m.key||UK||lr.Key||'');var userId=(m.Id||m.id||ud.Id||'');return {key:key?String(key):'',userId:userId?String(userId):''};}catch(__e){return {key:'',userId:''};}}function rwAjax(u){var s=String(u||'');try{if(/^[A-Za-z][A-Za-z0-9_]*$/.test(s)){return RPC+s;}var x=new URL(s,location.href),p=(x.pathname||'');if(x.origin===location.origin&&p.indexOf('/admin/ak-rpc/')===0){return x.pathname+x.search+x.hash;}if(x.origin===location.origin&&p.indexOf('/RPC/')===0){x.pathname='/admin/ak-rpc/'+p.slice(5);return x.pathname+x.search+x.hash;}}catch(__e){if(s.indexOf('/RPC/')===0){return '/admin/ak-rpc/'+s.slice(5);}}return s;}function wrapAjax(){try{if(!window.APP||!APP.GLOBAL||typeof APP.GLOBAL.ajax!=='function')return false;var cur=APP.GLOBAL.ajax;if(cur&&cur.__akAjaxRewriteWrapped)return true;var wrapped=function(options){if(!options||typeof options!=='object')return cur.apply(this,arguments);var opt=Object.assign({},options),before=opt.url||opt.api||'';var after=rwAjax(before);if(after!==before){opt.url=after;if(opt.api)delete opt.api;}if(needTrace(before)||needTrace(after)){console.warn('[AkAjaxRewrite]',{before:before,after:after});}if(needsAuth(after)){var auth=getAuth();var data=opt.data;if(typeof data==='string'||data==null){var raw=typeof data==='string'?data:'';var parts=raw?raw.split('&'):[];var d={};for(var i=0;i<parts.length;i++){var eq=parts[i].indexOf('=');if(eq>=0)d[parts[i].slice(0,eq)]=parts[i].slice(eq+1);}var chg=false;if(auth.key&&(!d['key']||d['key']==='123')){d['key']=encodeURIComponent(auth.key);chg=true;}if(auth.userId&&(!d['UserID']||d['UserID']==='123')){d['UserID']=encodeURIComponent(auth.userId);chg=true;}if(chg){var arr=[];for(var k in d){if(Object.prototype.hasOwnProperty.call(d,k))arr.push(k+'='+d[k]);}opt.data=arr.join('&');}}}return cur.call(this,opt);};wrapped.__akAjaxRewriteWrapped=1;APP.GLOBAL.ajax=wrapped;return true;}catch(__e){return false;}}wrapAjax();window.__akAjaxRewriteWatchdog=setInterval(wrapAjax,100);})();}catch(_e){}"
        "try{(function(){if(window.__akTabBarJumpWatchdog)return;function normTabUrl(u){try{var s=String(u||'');if(!s||s==='#')return s;var x=new URL(s,location.href),p=(x.pathname||'');if(x.origin!==location.origin)return s;var lp=(p||'').toLowerCase();if(lp.indexOf('/pages/')<0||lp.slice(-5)!=='.html')return s;x.searchParams.delete('bs');return x.pathname+x.search+x.hash;}catch(__e){return String(u||'');}}function getVm(n){try{return (n&&(n.__vue__||(n.__vueParentComponent&&n.__vueParentComponent.proxy)))||null;}catch(__e){return null;}}function wrapVm(vm){try{if(!vm||typeof vm.jump!=='function')return false;var cur=vm.jump;if(cur&&cur.__akTabBarJumpWrapped)return true;var wrapped=function(item){var next=item&&typeof item==='object'?Object.assign({},item):item;if(next&&typeof next==='object'&&next.url)next.url=normTabUrl(next.url);return cur.call(this,next);};wrapped.__akTabBarJumpWrapped=1;vm.jump=wrapped;if(vm.$options&&vm.$options.methods&&typeof vm.$options.methods.jump==='function')vm.$options.methods.jump=wrapped;return true;}catch(__e){return false;}}function ensureTabBarJump(){try{var root=document.getElementById('bottom');if(!root)return false;var nodes=[root].concat([].slice.call(root.querySelectorAll('*'))),hit=false;for(var i=0;i<nodes.length;i++){hit=wrapVm(getVm(nodes[i]))||hit;}return hit;}catch(__e){return false;}}ensureTabBarJump();window.__akTabBarJumpWatchdog=setInterval(ensureTabBarJump,100);})();}catch(_e){}"
        "try{(function(){if(window.__akGotoLoginWatchdog)return;var ensureAkGotoLogin=function(){try{if(!window.APP||!APP.GLOBAL||typeof APP.GLOBAL.gotoLogin!=='function')return false;var cur=APP.GLOBAL.gotoLogin;if(cur&&cur.__akGotoLoginWrapped)return true;var wrapped=function(){window.location=P+'/pages/account/login.html';};wrapped.__akGotoLoginWrapped=1;APP.GLOBAL.gotoLogin=wrapped;return true;}catch(__e){return false;}};ensureAkGotoLogin();window.__akGotoLoginWatchdog=setInterval(ensureAkGotoLogin,100);})();}catch(_e){}"
        "try{(function(){if(window.__akAbsoluteRpcRewrite)return;window.__akAbsoluteRpcRewrite=1;function rwAbs(u){try{var s=String(u||'');if(!s)return s;var x=new URL(s,location.href),p=(x.pathname||'');if(p.indexOf('/RPC/')!==0)return s;return '/admin/ak-rpc/'+p.slice(5)+x.search+x.hash;}catch(__e){var s2=String(u||'');if(s2.indexOf('/RPC/')===0)return '/admin/ak-rpc/'+s2.slice(5);return s2;}}var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){var ru=rwAbs(url);return xo.apply(this,[method,ru].concat([].slice.call(arguments,2)));};if(typeof window.fetch==='function'){var of=window.fetch;window.fetch=function(input,init){var url='';try{if(typeof input==='string'){url=input;}else if(input&&typeof input==='object'){url=input.url||'';}}catch(__e){}var ru=rwAbs(url||'');if(ru!==url&&typeof input==='string'){input=ru;}else if(ru!==url&&input&&typeof input==='object'){input=new Request(ru,input);}return of.call(this,input,init);};}function wrapAjax(){try{if(!window.APP||!APP.GLOBAL||typeof APP.GLOBAL.ajax!=='function')return false;var cur=APP.GLOBAL.ajax;if(cur&&cur.__akAbsoluteRpcWrapped)return true;var wrapped=function(options){if(!options||typeof options!=='object')return cur.apply(this,arguments);var opt=Object.assign({},options),before=opt.url||opt.api||'';var after=rwAbs(before);if(after!==before){opt.url=after;if(opt.api)delete opt.api;}return cur.call(this,opt);};wrapped.__akAbsoluteRpcWrapped=1;APP.GLOBAL.ajax=wrapped;return true;}catch(__e){return false;}}wrapAjax();window.__akAbsoluteRpcTimer=setInterval(wrapAjax,100);})();}catch(_e){}"
        + auto_login +
        "})();</script>"
    )
    return js


def _build_native_rpc_auth_patch(userkey: str = "", user_id: str = "") -> str:
    protected_paths_json = json.dumps([
        "Public_EP_SellRecords1",
        "Public_EP_SellRecords2",
        "Public_EP_SellRecords3",
        "Question_Get1",
        "Check_TransactionPassword",
        "Check_Answer",
        "Logout",
    ], ensure_ascii=False)
    return (
        "try{(function(){if(window.__akNativeRpcAuthWatchdog)return;"
        "var PATHS=" + protected_paths_json + ";"
        "var UK=" + json.dumps(userkey or "", ensure_ascii=False) + ";"
        "var UID=" + json.dumps(user_id or "", ensure_ascii=False) + ";"
        "function bad(v){var s=String(v==null?'':v).trim().toLowerCase();return !s||s==='123'||s==='undefined'||s==='null';}"
        "function auth(){try{var m=(window.APP&&APP.USER&&APP.USER.MODEL&&typeof APP.USER.MODEL==='object')?APP.USER.MODEL:{};return{key:String(UK||m.Key||m.key||''),userId:String(UID||m.Id||m.id||'')};}catch(__e){return{key:String(UK||''),userId:String(UID||'')};}}"
        "function nameOf(u){try{var s=String(u||'');if(/^[A-Za-z][A-Za-z0-9_]*$/.test(s))return s.toLowerCase();var x=new URL(s,location.href),p=(x.pathname||'').replace(/^\\/RPC\\//i,'');if(p.indexOf('/')>=0)p=p.split('/').pop();return String(p||'').toLowerCase();}catch(__e){var s2=String(u||'');var m=s2.match(/([A-Za-z0-9_]+)(?:\\?|$)/);return m?String(m[1]).toLowerCase():s2.toLowerCase();}}"
        "function need(u){var n=nameOf(u);for(var i=0;i<PATHS.length;i++){if(n===String(PATHS[i]).toLowerCase())return true;}return false;}"
        "function fix(d){var a=auth();if(!a.key&&!a.userId)return d;if(d==null)d={};if(typeof d==='string'){try{var ps=new URLSearchParams(d),chg=false;var k=ps.get('key');var uid=ps.get('UserID')||ps.get('userid');if(a.key&&bad(k)){ps.set('key',a.key);chg=true;}if(a.userId&&bad(uid)){ps.set('UserID',a.userId);if(ps.has('userid'))ps.delete('userid');chg=true;}return chg?ps.toString():d;}catch(__e){return d;}}if(typeof URLSearchParams!=='undefined'&&d instanceof URLSearchParams){var chg2=false;var k2=d.get('key');var uid2=d.get('UserID')||d.get('userid');if(a.key&&bad(k2)){d.set('key',a.key);chg2=true;}if(a.userId&&bad(uid2)){d.set('UserID',a.userId);if(d.has('userid'))d.delete('userid');chg2=true;}return d;}if(typeof d!=='object'||Array.isArray(d))return d;var out=Object.assign({},d),chg3=false;var k3=out.key;var uid3=out.UserID!=null?out.UserID:out.userid;if(a.key&&bad(k3)){out.key=a.key;chg3=true;}if(a.userId&&bad(uid3)){out.UserID=a.userId;if(Object.prototype.hasOwnProperty.call(out,'userid'))delete out.userid;chg3=true;}return chg3?out:d;}"
        "function wrap(){try{if(!window.APP||!APP.GLOBAL||typeof APP.GLOBAL.ajax!=='function')return false;var cur=APP.GLOBAL.ajax;if(cur&&cur.__akNativeRpcAuthWrapped)return true;var wrapped=function(options){if(!options||typeof options!=='object')return cur.apply(this,arguments);var before=options.url||options.api||'';if(!need(before))return cur.apply(this,arguments);var opt=Object.assign({},options);if(Object.prototype.hasOwnProperty.call(opt,'data'))opt.data=fix(opt.data);else opt.data=fix({});return cur.call(this,opt);};wrapped.__akNativeRpcAuthWrapped=1;APP.GLOBAL.ajax=wrapped;return true;}catch(__e){return false;}}"
        "wrap();window.__akNativeRpcAuthWatchdog=setInterval(wrap,100);})();}catch(_e){}"
    )


def _build_native_injector(username: str = "", password: str = "", userkey: str = "", login_result: dict = None) -> str:
    safe_user = username.replace("\\", "\\\\").replace("'", "\\'")
    safe_pwd = password.replace("\\", "\\\\").replace("'", "\\'")
    auth_patch = _build_native_rpc_auth_patch(userkey, _extract_login_user_id(login_result or {}))
    auto_login = ""
    if safe_user and safe_pwd:
        auto_login = (
            "var _t=0,_iv=setInterval(function(){"
            "if(++_t>100){clearInterval(_iv);return;}"
            "if(typeof _vue!=='undefined'&&_vue&&_vue.form&&!_vue.isLogin){"
            "clearInterval(_iv);"
            "_vue.form.account='" + safe_user + "';"
            "_vue.form.password='" + safe_pwd + "';"
            "setTimeout(function(){"
            "_vue.checkInput&&_vue.checkInput();"
            "try{if(typeof _vue.login==='function'){_vue.login();return;}if(typeof _vue.Login==='function'){_vue.Login();return;}if(typeof _vue.submit==='function'){_vue.submit();return;}if(typeof _vue.onSubmit==='function'){_vue.onSubmit();return;}}catch(_e){}"
            "var _btn=document.querySelector('button[type=submit],.login-btn,.btn-login,.el-button--primary');if(_btn){_btn.click();}"
            "},200);"
            "}"
            "},100);"
        )
    return (
        "<script>(function(){"
        "if('serviceWorker' in navigator){navigator.serviceWorker.register=function(){return Promise.reject(new Error('SW disabled'));};}"
        + auth_patch
        + auto_login +
        "})();</script>"
    )


def _build_ak_site_forward_headers(request: Request) -> dict:
    user_agent = request.headers.get("user-agent") or (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
    headers = {
        "User-Agent": user_agent,
        "Accept": request.headers.get("accept") or "*/*",
        "Accept-Language": request.headers.get("accept-language") or "zh-CN,zh;q=0.9",
    }
    if request.headers.get("content-type"):
        headers["Content-Type"] = request.headers["content-type"]
    return headers
@app.api_route("/admin/ak-site/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
@app.api_route("/admin/ak-web/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
@app.api_route("/ak-web/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
async def ak_web_proxy(request: Request, path: str):
    """AK 网页透明代理：所有请求通过后端转发，携带缓存 session，注入 JS 拦截器实现 VPN 式体验"""
    request_path = request.url.path
    if request_path.startswith(_AK_SITE_PREFIX):
        site_prefix = _AK_SITE_PREFIX
    elif request_path.startswith(_AK_NATIVE_WEB_PREFIX):
        site_prefix = _AK_NATIVE_WEB_PREFIX
    else:
        site_prefix = _AK_WEB_PREFIX
    _admin_ak_trace(lambda: f"[AkWebProxy/IN] method={request.method} path={request_path} referer={request.headers.get('referer','')}")
    if path.lstrip("/") == "cdn-cgi/rum":
        return Response(status_code=204)
    bs_id, session, bs_source = _resolve_browse_session(
        request, source_order=("cookie",)
    )
    referer = request.headers.get("referer", "")
    fetch_dest = request.headers.get("sec-fetch-dest", "")
    accept = request.headers.get("accept", "")
    cookie_bs = (request.cookies.get(_BROWSE_SESSION_COOKIE) or "").strip()
    cookies = {}
    selected_exit = None
    if session:
        cookies = session["cookies"]
        pinned_exit_name = str(session.get("ak_exit_name") or "").strip()
        if _ADMIN_AK_FORCE_DIRECT:
            selected_exit = _get_direct_exit()
            session.pop("ak_exit_name", None)
            _admin_ak_trace(lambda: (
                f"[AkWebExit/{path}] force_direct=1 preferred={pinned_exit_name or '-'} using={selected_exit.name} "
                f"bs={bs_id} referer={referer}"
            ))
        else:
            selected_exit = _select_forward_exit(path or "web", preferred_exit_name=pinned_exit_name)
            if pinned_exit_name:
                _admin_ak_trace(lambda: (
                    f"[AkWebExit/{path}] pinned=1 preferred={pinned_exit_name} using={selected_exit.name} "
                    f"bs={bs_id} referer={referer}"
                ))
            else:
                session["ak_exit_name"] = selected_exit.name
                _admin_ak_trace(lambda: f"[AkWebExit/{path}] bind={selected_exit.name} bs={bs_id} referer={referer}")

    normalized_path = path.lstrip("/").lower()
    requested_bs = (request.query_params.get("bs") or "").strip()
    debug_body_targets = {
        "content/js/base.js",
        "content/js/pages/home.js",
        "content/js/vue-component.js",
        "assets/css/home.css",
        "assets/css/vue-component.css",
        "assets/css/notice.css",
    }
    if request.method == "GET" and normalized_path.startswith("pages/") and normalized_path.endswith(".html"):
        _admin_ak_trace(lambda: (
            f"[AkPageEntry/{path}] requested_bs={requested_bs or '-'} resolved_bs={bs_id or '-'} "
            f"has_session={int(bool(session))} source={bs_source} cookie_bs={cookie_bs or '-'} referer={referer}"
        ))
    if request.method == "GET" and normalized_path.startswith("pages/") and normalized_path.endswith(".html") and requested_bs:
        canonical_query = [(k, v) for k, v in request.query_params.multi_items() if k != "bs"]
        canonical_url = request.url.path
        if canonical_query:
            canonical_url += "?" + urlencode(canonical_query, doseq=True)
        _admin_ak_trace(lambda: (
            f"[AkPageBsStrip/{path}] requested_bs={requested_bs or '-'} resolved_bs={bs_id or '-'} "
            f"source={bs_source} cookie_bs={cookie_bs} referer={referer} redirect={canonical_url}"
        ))
        response = _apply_no_store_headers(Response(status_code=307, headers={"location": canonical_url}))
        if bs_id:
            _set_browse_session_cookie(response, bs_id)
        return response

    # 构建目标 URL（去掉代理专用参数 bs）
    query_parts = [p for p in str(request.url.query).split("&") if p and not p.startswith("bs=")]
    target_url = f"{_AK_BASE}/{path}" if path else f"{_AK_BASE}/"
    if query_parts:
        target_url += "?" + "&".join(query_parts)

    # 透传浏览器请求头，补充缺失的字段，模拟真实 Chrome 指纹
    fwd_headers = _build_ak_site_forward_headers(request)
    cookie_header = _build_cookie_header(cookies)
    if cookie_header:
        fwd_headers["cookie"] = cookie_header
    else:
        fwd_headers.pop("cookie", None)

    try:
        body = await request.body()
        proxy_url = selected_exit.proxy_url if selected_exit and selected_exit.proxy_url else None
        client = await _ak_web_client_pool.get_client(proxy_url=proxy_url)
        resp = await client.request(
            method=request.method,
            url=target_url,
            headers=fwd_headers,
            content=body or None,
        )
        _admin_ak_trace(lambda: f"[AkWebProxy] target={target_url} httpx_status={resp.status_code} final_url={resp.url}")
        final_url_str = str(resp.url)
        if "/pages/account/login.html" in final_url_str and "/pages/account/login.html" not in target_url:
            history_chain = " -> ".join(str(item.url) for item in resp.history) if resp.history else ""
            logger.warning(f"[AkWebLoginBounce/{path}] bs={bs_id} source={bs_source} cookie_bs={cookie_bs} referer={referer} target={target_url} final_url={final_url_str} history={history_chain}")

        # 同步响应中的 Set-Cookie 到缓存 session，保持 session 刷新
        if session and bs_id:
            for sc in resp.headers.get_list("set-cookie"):
                kv = sc.split(";", 1)[0].strip()
                if "=" in kv:
                    ck, cv = kv.split("=", 1)
                    session["cookies"][ck.strip()] = cv.strip()
            if resp.headers.get_list("set-cookie") and session.get("username"):
                try:
                    await _persist_browse_session_auth(session)
                except Exception as e:
                    logger.warning(f"[AkWebProxy] 站点登录态持久化失败 {session.get('username','')}: {e}")

        # 过滤阻止 iframe 嵌入和影响解压的响应头
        skip_headers = {"x-frame-options", "content-security-policy", "x-xss-protection",
                        "content-encoding", "transfer-encoding", "content-length", "set-cookie"}
        resp_headers = {k: v for k, v in resp.headers.items() if k.lower() not in skip_headers}

        content = resp.content
        content_type = resp.headers.get("content-type", "")
        if fetch_dest == "script" and "application/json" in content_type.lower():
            body_head = content[:200].decode("utf-8", errors="replace")
            logger.warning(f"[AkSiteProxy/{path}] script_json_mismatch bs={bs_id} source={bs_source} cookie_bs={cookie_bs} referer={referer} target={target_url} final_url={resp.url} body_head={body_head}")
        if "application/json" in content_type.lower():
            body_head = content[:300].decode("utf-8", errors="replace")
            lowered_body = body_head.lower()
            normalized_body = lowered_body.replace(" ", "")
            if "用戶未登錄" in body_head or '"islogin":false' in normalized_body or '"error":true' in normalized_body:
                logger.warning(f"[AkSiteJsonLoginReject/{path}] bs={bs_id} source={bs_source} cookie_bs={cookie_bs} referer={referer} dest={fetch_dest} accept={accept} target={target_url} final_url={resp.url} body_head={body_head}")

        if path.lower().endswith("base.js") and any(t in content_type.lower() for t in ("javascript", "ecmascript")):
            text = content.decode("utf-8", errors="replace")
            if _use_native_ak_rpc(site_prefix):
                text, base_js_rewritten = _rewrite_base_js_native_rpc_roots(text)
            else:
                text, base_js_rewritten = _inject_base_js_no_login_probe(text)
            if base_js_rewritten:
                logger.warning(f"[AkBaseJsRewrite/{path}] bs={bs_id} source={bs_source} cookie_bs={cookie_bs} referer={referer} target={target_url} final_url={resp.url}")
                content = text.encode("utf-8")

        if any(t in content_type.lower() for t in ("javascript", "ecmascript")) and normalized_path in debug_body_targets:
            js_text = content.decode("utf-8", errors="replace")
            js_has_old_host = int(any(token in js_text for token in ("ak928.vip", "www.ak928.vip", "404.html")))
            logger.warning(f"[AkJsBody/{path}] bs={bs_id} referer={referer} target={target_url} final_url={resp.url} old_host={js_has_old_host} body_head={js_text[:400]!r}")

        # 对文本内容（HTML/CSS）做 URL 替换 + HTML 注入拦截器
        if any(t in content_type for t in ("text/html", "text/css")):
            text = content.decode("utf-8", errors="replace")
            # 替换 AK 网页绝对 URL 为当前代理路径
            for base in [_AK_BASE, "https://ak928.vip", "http://ak928.vip",
                             "https://www.ak928.vip", "https://k937.com", "http://k937.com"]:
                text = text.replace(base + "/", site_prefix + "/")
                text = text.replace(base + '"', site_prefix + '"')
                text = text.replace(base + "'", site_prefix + "'")
            if "text/html" in content_type:
                html_injected = False
                text = _rewrite_site_html_roots(text, site_prefix)
                text = _rewrite_site_css_roots(text, site_prefix)
                logger.warning(f"[HtmlRewrite/{path}] bs={bs_id} final_url={resp.url} head_sample={text[:400]!r}")
                if normalized_path == "pages/home.html":
                    logger.warning(
                        f"[AkHomeHtmlScan/{path}] bs={bs_id} referer={referer} final_url={resp.url} "
                        f"has_home_css={int('/assets/css/home.css' in text)} "
                        f"has_proxy_home_css={int('/admin/ak-web/assets/css/home.css' in text)} "
                        f"has_message_svg={int('/assets/images/home/message.svg' in text)} "
                        f"has_proxy_message_svg={int('/admin/ak-web/assets/images/home/message.svg' in text)} "
                        f"has_old_host={int(any(token in text for token in ('ak928.vip', 'www.ak928.vip', '404.html')))}"
                    )
                    logger.warning(
                        f"[AkHomeHtmlSnippet/{path}] home_css={_extract_debug_snippet(text, '/admin/ak-web/assets/css/home.css')!r} "
                        f"message_svg={_extract_debug_snippet(text, '/admin/ak-web/assets/images/home/message.svg')!r}"
                    )
            if "text/css" in content_type and normalized_path in debug_body_targets:
                css_has_old_host = int(any(token in text for token in ("ak928.vip", "www.ak928.vip", "404.html")))
                logger.warning(f"[AkCssBody/{path}] bs={bs_id} referer={referer} target={target_url} final_url={resp.url} old_host={css_has_old_host} body_head={text[:400]!r}")
            # HTML：注入 JS 拦截器
            if "text/html" in content_type and bs_id:
                _sess = _browse_sessions.get(bs_id, {})
                inject_user_model = _build_ak_user_model(_sess.get("login_result", {}), _sess.get("userkey", ""))
                inject_model_key = str(inject_user_model.get("Key") or "").strip()
                inject_user_id = str(inject_user_model.get("Id") or inject_user_model.get("ID") or _extract_login_user_id(_sess.get("login_result", {})) or "").strip()
                logger.warning(
                    f"[AkInjectAuth/{path}] bs={bs_id} source={bs_source} cookie_bs={cookie_bs or '-'} "
                    f"username={_sess.get('username', '') or '-'} session_key={str(_sess.get('userkey', '') or '')[:12]} "
                    f"inject_key={inject_model_key[:12]} inject_user_id={inject_user_id or '-'} referer={referer}"
                )
                if _use_native_ak_rpc(site_prefix):
                    injector = _build_native_injector(_sess.get("username", ""), _sess.get("password", ""), _sess.get("userkey", ""), _sess.get("login_result", {}))
                else:
                    injector = _build_injector(bs_id, _sess.get("username", ""), _sess.get("password", ""), _sess.get("userkey", ""), _sess.get("login_result", {}), site_prefix=site_prefix)
                if "<head>" in text:
                    text = text.replace("<head>", "<head>" + injector, 1)
                elif "<head " in text:
                    idx = text.index("<head ")
                    ins = text.index(">", idx) + 1
                    text = text[:ins] + injector + text[ins:]
                elif "<body" in text:
                    text = text.replace("<body", injector + "<body", 1)
                else:
                    text = injector + text
                html_injected = True
                if site_prefix == _AK_WEB_PREFIX and remote_assist.is_enabled():
                    assist_session = None
                    assist_role = ''
                    tagged_assist_session_id = str(_sess.get('assist_session_id') or '').strip()
                    tagged_assist_role = str(_sess.get('assist_role') or '').strip().lower()
                    if tagged_assist_session_id and tagged_assist_role in {'admin', 'user'}:
                        active_session = remote_assist.get_session(tagged_assist_session_id)
                        if active_session and active_session.site_type == 'ak_web':
                            assist_session = active_session
                            assist_role = tagged_assist_role
                            if tagged_assist_role == 'admin':
                                remote_assist.attach_browse_session(active_session.session_id, bs_id)
                    if assist_session and assist_role:
                        assist_script = remote_assist.build_bridge_script(
                            'ak_web',
                            assist_session.session_id,
                            '/admin/assist/ws',
                            assist_role,
                            readonly=(assist_role == 'admin'),
                            extra={'browseSessionId': bs_id},
                        )
                        if assist_script:
                            if '</body>' in text:
                                text = text.replace('</body>', assist_script + '</body>', 1)
                            else:
                                text += assist_script
            if "text/html" in content_type:
                inject_reason = "ok" if html_injected else ("no_bs" if not bs_id else "miss")
                logger.warning(f"[AkHtmlInject/{path}] bs={bs_id or '-'} source={bs_source} cookie_bs={cookie_bs} reason={inject_reason} injected={int(html_injected)} referer={referer} target={target_url} final_url={resp.url} content_type={content_type}")
            content = text.encode("utf-8")

        response = Response(content=content, status_code=resp.status_code,
                            headers=resp_headers, media_type=content_type or "application/octet-stream")
        if "text/html" in content_type and normalized_path.startswith("pages/") and normalized_path.endswith(".html"):
            _apply_no_store_headers(response)
        if bs_id:
            _set_browse_session_cookie(response, bs_id)
        return response
    except Exception as e:
        logger.error(f"[AkWebProxy] {path}: {e}")
        return Response(content=f"代理错误: {str(e)}".encode(), status_code=502)


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

