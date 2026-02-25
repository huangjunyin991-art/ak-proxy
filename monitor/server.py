# -*- coding: utf-8 -*-
"""
监控后端服务 - FastAPI
拦截登录请求并记录，提供管理API和WebSocket实时推送
"""

import asyncio
import json
import httpx
from datetime import datetime
from typing import List, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import os
import sys
import importlib
import io

# 修复Windows控制台中文乱码
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# 添加当前目录到路径
sys.path.insert(0, os.path.dirname(__file__))
from database import (
    init_db, record_login, get_all_users, get_all_ips, 
    get_recent_logins, get_user_detail, ban_user, unban_user,
    ban_ip, unban_ip, is_banned, get_ban_list, get_stats_summary,
    update_user_assets, get_user_assets, get_all_user_assets, get_asset_history,
    get_all_users_with_assets, get_dashboard_data,
    get_all_tables, get_table_schema, query_table, insert_row, update_row, delete_row, execute_sql,
    save_admin_token, get_admin_token, delete_admin_token, delete_admin_tokens_by_role,
    delete_admin_tokens_by_sub_name, cleanup_expired_tokens, load_all_admin_tokens,
    add_license_log, get_license_logs,
    db_get_all_sub_admins, db_set_sub_admin, db_delete_sub_admin, db_get_sub_admin,
    db_update_sub_admin_permissions
)

# 配置
ADMIN_PASSWORD = "ak-lovejjy1314"  # 系统总管理员密码（不可更改）
SUB_ADMINS = {}  # 子管理员字典 {名称: {password, permissions, created_at}}（可由总管理设置）
DB_SECONDARY_PASSWORD = "aa292180"  # 数据库操作二级密码
AKAPI_URL = "https://www.akapi1.com/RPC/"  # 原始API地址

import hashlib
import time
import secrets
import json
try:
    import proxy_pool as pp
    _HAS_PROXY_POOL = True
    print("[ProxyPool] 模块加载成功")
except Exception as _e:
    pp = None
    _HAS_PROXY_POOL = False
    print(f"[ProxyPool] 模块加载失败: {_e}")
    import traceback; traceback.print_exc()

# 权限级别
ROLE_SUPER_ADMIN = "super_admin"  # 系统总管理
ROLE_SUB_ADMIN = "sub_admin"  # 子管理员

# 子管理员配置文件（旧，用于迁移）
SUB_ADMIN_CONFIG_FILE = os.path.join(os.path.dirname(__file__), "sub_admin.json")

def migrate_sub_admins_from_json():
    """从旧的JSON文件迁移子管理员到数据库"""
    try:
        if os.path.exists(SUB_ADMIN_CONFIG_FILE):
            with open(SUB_ADMIN_CONFIG_FILE, 'r', encoding='utf-8') as f:
                config = json.load(f)
            
            admins_to_migrate = {}
            if 'password' in config and 'admins' not in config:
                old_pwd = config.get('password', '')
                if old_pwd:
                    admins_to_migrate = {"子管理员": old_pwd}
            else:
                admins_to_migrate = config.get('admins', {})
            
            for name, pwd in admins_to_migrate.items():
                if pwd:
                    db_set_sub_admin(name, pwd)
                    print(f"[SubAdmin] 迁移子管理员到数据库: {name}")
            
            # 迁移完成后重命名旧文件
            if admins_to_migrate:
                os.rename(SUB_ADMIN_CONFIG_FILE, SUB_ADMIN_CONFIG_FILE + '.bak')
                print(f"[SubAdmin] JSON文件已备份为 sub_admin.json.bak")
    except Exception as e:
        print(f"[SubAdmin] 迁移失败: {e}")

def load_sub_admins():
    """从数据库加载所有子管理员"""
    global SUB_ADMINS
    try:
        SUB_ADMINS = db_get_all_sub_admins()
        print(f"[SubAdmin] 从数据库加载了 {len(SUB_ADMINS)} 个子管理员: {list(SUB_ADMINS.keys())}")
    except Exception as e:
        print(f"[SubAdmin] 加载失败: {e}")
        SUB_ADMINS = {}

def save_sub_admins():
    """同步内存中的子管理员到数据库（兼容旧调用）"""
    return True  # 现在每次操作都直接写数据库，不需要额外保存

# 启动时迁移旧数据并加载
migrate_sub_admins_from_json()
load_sub_admins()

# 二级密码Token管理
db_auth_tokens = {}  # {token: expire_time}

def generate_db_token():
    """生成数据库操作token"""
    token = secrets.token_urlsafe(32)
    # Token有效期30分钟
    db_auth_tokens[token] = time.time() + 1800
    # 清理过期token
    current = time.time()
    expired = [k for k, v in db_auth_tokens.items() if v < current]
    for k in expired:
        del db_auth_tokens[k]
    return token

def verify_db_token(token: str) -> bool:
    """验证数据库操作token"""
    if not token:
        return False
    expire_time = db_auth_tokens.get(token)
    if not expire_time:
        return False
    if time.time() > expire_time:
        del db_auth_tokens[token]
        return False
    return True

def verify_db_password(password: str) -> bool:
    """验证二级密码（防时序攻击）"""
    if not password or not isinstance(password, str):
        return False
    # 使用常量时间比较防止时序攻击
    return secrets.compare_digest(password, DB_SECONDARY_PASSWORD)

app = FastAPI(title="AK代理监控系统")

@app.on_event("startup")
async def on_startup():
    """服务器启动时自动启动代理池（如果配置了）"""
    if _HAS_PROXY_POOL:
        await pp.auto_start_pool()

@app.on_event("shutdown")
async def on_shutdown():
    """服务器关闭时停止代理池"""
    if _HAS_PROXY_POOL:
        await pp.stop_pool()

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# WebSocket连接管理 - 管理后台
class ConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
    
    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)
    
    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)
    
    async def broadcast(self, message: dict):
        """广播消息给所有连接"""
        print(f"[Broadcast] 广播消息: type={message.get('type')}, 当前连接数={len(self.active_connections)}")
        dead_connections = set()
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
                print(f"[Broadcast] 发送成功: {id(connection)}")
            except Exception as e:
                print(f"[Broadcast] 发送失败: {id(connection)}, error={e}")
                dead_connections.add(connection)
        
        # 清理断开的连接
        if dead_connections:
            print(f"[Broadcast] 清理断开连接: {len(dead_connections)}个")
        self.active_connections -= dead_connections

manager = ConnectionManager()

# 在线用户管理
class OnlineUserManager:
    def __init__(self):
        self.users: dict = {}  # username -> {websocket, page, user_agent, online_time, last_heartbeat}
        self.messages: dict = {}  # username -> [messages]
    
    async def user_online(self, username: str, websocket: WebSocket, page: str, user_agent: str):
        """用户上线"""
        self.users[username] = {
            'websocket': websocket,
            'page': page,
            'user_agent': user_agent,
            'online_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
            'last_heartbeat': datetime.now()
        }
        # 不广播 user_online 事件，避免实时日志噪音
        # 管理后台可以通过 /admin/api/online 主动查询在线用户
    
    def user_offline(self, username: str):
        """用户离线"""
        if username in self.users:
            del self.users[username]
    
    def update_heartbeat(self, username: str):
        """更新心跳"""
        if username in self.users:
            self.users[username]['last_heartbeat'] = datetime.now()
    
    def get_online_users(self):
        """获取在线用户列表"""
        now = datetime.now()
        online = []
        offline = []
        for username, data in self.users.items():
            # 超过60秒没心跳视为离线
            if (now - data['last_heartbeat']).seconds > 60:
                offline.append(username)
            else:
                online.append({
                    'username': username,
                    'page': data['page'],
                    'user_agent': data['user_agent'][:50] if data['user_agent'] else '',
                    'online_time': data['online_time']
                })
        # 清理离线用户
        for u in offline:
            del self.users[u]
        return online
    
    async def send_to_user(self, username: str, content: str, save_history: bool = True):
        """发送消息给用户"""
        if username in self.users:
            ws = self.users[username]['websocket']
            try:
                await ws.send_json({
                    'type': 'admin_message',
                    'content': content,
                    'time': datetime.now().strftime('%H:%M:%S')
                })
                # 只有一对一聊天才保存历史，群发消息不保存
                if save_history:
                    if username not in self.messages:
                        self.messages[username] = []
                    self.messages[username].append({
                        'content': content,
                        'is_admin': True,
                        'time': datetime.now().strftime('%H:%M:%S')
                    })
                return True
            except RuntimeError:
                print(f"用户 {username} 的WebSocket连接已关闭，无法发送消息。")
                return False
        return False
    
    def save_user_message(self, username: str, content: str):
        """保存用户消息"""
        if username not in self.messages:
            self.messages[username] = []
        self.messages[username].append({
            'content': content,
            'is_admin': False,
            'time': datetime.now().strftime('%H:%M:%S')
        })
    
    def get_messages(self, username: str):
        """获取消息历史"""
        return self.messages.get(username, [])[-50:]  # 最近50条

online_manager = OnlineUserManager()

# 初始化数据库
init_db()

# ===== 数据模型 =====
class LoginRequest(BaseModel):
    account: str
    password: str
    client: str = "WEB"

class BanRequest(BaseModel):
    value: str
    reason: str = None

class AdminAuth(BaseModel):
    password: str

# ===== 登录拦截代理 =====
@app.api_route("/RPC/Login", methods=["GET", "POST"])
async def proxy_login(request: Request):
    """拦截登录请求，记录后转发到原始服务器"""
    
    print("\n" + "="*60)
    print("[Login] 拦截到登录请求")
    print("="*60)
    
    # 获取客户端信息 - 优先从nginx代理头获取真实IP
    client_ip = request.headers.get("x-real-ip") or request.headers.get("x-forwarded-for", "").split(",")[0].strip() or request.client.host
    user_agent = request.headers.get("user-agent", "")
    content_type = request.headers.get("content-type", "")
    
    print(f"[Login] 完整URL: {request.url}")
    print(f"[Login] 路径: {request.url.path}")
    print(f"[Login] Method: {request.method}")
    print(f"[Login] Content-Type: {content_type}")
    print(f"[Login] Client IP: {client_ip}")
    print(f"[Login] User-Agent: {user_agent[:100] if user_agent else 'None'}")
    print(f"[Login] Query String: {request.url.query}")
    
    # 解析请求参数（支持多种格式）
    params = {}
    
    # 1. 先从 query string 获取
    for key, value in request.query_params.items():
        params[key] = value
    print(f"[Login] Query Params: {dict(request.query_params)}")
    
    # 2. 从请求体获取
    raw_body = None
    if request.method == "POST":
        try:
            raw_body = await request.body()
            print(f"[Login] Raw Body: {raw_body[:500] if raw_body else 'Empty'}")
        except Exception as e:
            print(f"[Login] 读取body失败: {e}")
        
        # 重新创建请求以便再次读取body
        from starlette.requests import Request as StarletteRequest
        
        try:
            if "application/json" in content_type:
                body = json.loads(raw_body) if raw_body else {}
                params.update(body)
                print(f"[Login] 解析为JSON: {body}")
            elif "application/x-www-form-urlencoded" in content_type:
                # 解析 form-urlencoded
                from urllib.parse import parse_qs
                form_data = parse_qs(raw_body.decode('utf-8') if raw_body else '')
                for key, value in form_data.items():
                    params[key] = value[0] if value else ''
                print(f"[Login] 解析为Form: {params}")
            else:
                # 尝试解析为 JSON
                try:
                    body = json.loads(raw_body) if raw_body else {}
                    params.update(body)
                    print(f"[Login] 尝试JSON成功: {body}")
                except:
                    # 尝试解析为 form
                    try:
                        from urllib.parse import parse_qs
                        form_data = parse_qs(raw_body.decode('utf-8') if raw_body else '')
                        for key, value in form_data.items():
                            params[key] = value[0] if value else ''
                        print(f"[Login] 尝试Form成功: {params}")
                    except Exception as e:
                        print(f"[Login] 解析失败: {e}")
        except Exception as e:
            print(f"[Login] 解析异常: {e}")
    
    account = params.get("account", "unknown")
    password = params.get("password", "")
    
    print(f"[Login] 最终解析结果: account={account}, password={'*'*len(password) if password else 'None'}")
    print(f"[Login] 所有参数keys: {list(params.keys())}")
    
    # 检查是否被封禁
    if is_banned(username=account, ip_address=client_ip):
        return JSONResponse({
            "Error": True,
            "Msg": "您的账号或IP已被封禁"
        })
    
    # 转发请求到原始服务器（优先通过代理池，回退直连）
    fwd_headers = {
        "User-Agent": user_agent,
        "X-Forwarded-For": client_ip,
        "X-Real-IP": client_ip
    }
    if "application/json" in content_type:
        fwd_headers["Content-Type"] = "application/json"

    try:
        response = None
        use_direct = _HAS_PROXY_POOL and pp.should_use_direct()
        
        if use_direct:
            async with httpx.AsyncClient(verify=False, timeout=30) as client:
                if "application/json" in content_type:
                    response = await client.post(AKAPI_URL + "Login", json=params, headers=fwd_headers)
                else:
                    response = await client.post(AKAPI_URL + "Login", data=params, headers=fwd_headers)
            if response.status_code == 403:
                pp.report_direct_blocked()
                response = None
            else:
                pp.report_direct_success()
                pp.report_route("本地直连")
                print(f"[Login] 优先直连转发")
        
        if response is None and _HAS_PROXY_POOL:
            proxy_resp = await pp.proxy_request(
                "POST", AKAPI_URL + "Login",
                json_data=params if "application/json" in content_type else None,
                form_data=params if "application/json" not in content_type else None,
                headers=fwd_headers, strict=True
            )
            if proxy_resp is not None:
                response = proxy_resp
                print(f"[Login] 通过代理池转发")
        
        if response is None:
            async with httpx.AsyncClient(verify=False, timeout=30) as client:
                if "application/json" in content_type:
                    response = await client.post(AKAPI_URL + "Login", json=params, headers=fwd_headers)
                else:
                    response = await client.post(AKAPI_URL + "Login", data=params, headers=fwd_headers)
            if _HAS_PROXY_POOL: pp.report_route("本地直连(兜底)")
            print(f"[Login] 直连转发")
        result = response.json()
        print(f"[Login] 服务器响应: Error={result.get('Error')}, 有UserData={bool(result.get('UserData'))}")
    except Exception as e:
        print(f"[Login] 请求失败: {e}")
        return JSONResponse({
            "Error": True,
            "Msg": f"服务器连接失败: {str(e)}"
        })
    
    # 判断登录是否成功 - 检查Error字段
    is_success = result.get("Error") == False or (not result.get("Error") and result.get("UserData"))
    
    status = "success" if is_success else "failed"
    print(f"[Login] 登录结果: is_success={is_success}, status={status}")
    
    # 如果登录成功，从 UserData 中提取用户资产信息
    asset_data = None
    if is_success and result.get("UserData"):
        user_data = result["UserData"]
        asset_data = user_data
        print(f"[Login] 保存用户资产: {account}")
        try:
            update_user_assets(account, user_data)
            print(f"[Login] 资产保存成功")
        except Exception as e:
            print(f"[Login] 资产保存失败: {e}")
    
    # 记录所有登录尝试到user_stats表（成功和失败都记录，用于"用户使用情况"）
    if account and password:
        print(f"[Login] 记录登录尝试: account={account}, is_success={is_success}")
        try:
            record_login(
                username=account,
                ip_address=client_ip,
                user_agent=user_agent,
                request_path="/RPC/Login",
                status_code=200 if is_success else 401,
                extra_data=json.dumps({"status": status, "msg": result.get("Msg", "")}),
                password=password,
                is_success=is_success
            )
            print(f"[Login] 登录记录保存成功")
        except Exception as e:
            print(f"[Login] 登录记录保存失败: {e}")
    else:
        print(f"[Login] 跳过记录（无效请求：account={account}）")
    
    # 只有真正的登录尝试（有账号密码的请求）才广播，且只广播成功的登录
    if account and password and is_success:
        broadcast_data = {
            "type": "new_login",
            "data": {
                "username": account,
                "ip": client_ip,
                "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "status": "success",
                "user_agent": user_agent[:50] if user_agent else ""
            }
        }
        
        # 如果有资产数据，一起广播
        if asset_data:
            broadcast_data["data"]["assets"] = {
                "ep": asset_data.get("EP", 0),
                "sp": asset_data.get("SP", 0),
                "tp": asset_data.get("TP", 0),
                "rp": asset_data.get("RP", 0),
                "ace_count": asset_data.get("ACECount", 0),
                "total_ace": asset_data.get("TotalACE", 0),
                "honor_name": asset_data.get("HonorName", ""),
                "weekly_money": asset_data.get("WeeklyMoney", 0)
            }
        
        print(f"[Login] 广播登录成功事件: {account}")
        await manager.broadcast(broadcast_data)
    else:
        print(f"[Login] 跳过广播（account={account}, password={'***' if password else 'None'}, is_success={is_success}）")
    
    # 创建响应，如果登录成功则设置cookie保存用户名
    response = JSONResponse(result)
    if is_success:
        # 设置cookie，聊天组件可以读取这个来获取用户名
        response.set_cookie(
            key="ak_username",
            value=account,
            max_age=86400 * 30,  # 30天
            httponly=False,  # 允许JS读取
            samesite="lax"
        )
        print(f"[Login] 登录成功，设置cookie: ak_username={account}")
    
    return response

# ===== public_IndexData 拦截 (获取用户资产) =====
@app.api_route("/RPC/public_IndexData", methods=["GET", "POST"])
async def proxy_index_data(request: Request):
    """拦截用户资产数据请求，保存后返回"""
    
    print("\n" + "="*60)
    print("[IndexData] 拦截到资产数据请求")
    print("="*60)
    
    # 获取客户端信息 - 优先从nginx代理头获取真实IP
    client_ip = request.headers.get("x-real-ip") or request.headers.get("x-forwarded-for", "").split(",")[0].strip() or request.client.host
    user_agent = request.headers.get("user-agent", "")
    content_type = request.headers.get("content-type", "")
    
    print(f"[IndexData] Method: {request.method}")
    print(f"[IndexData] Content-Type: {content_type}")
    print(f"[IndexData] Client IP: {client_ip}")
    print(f"[IndexData] Query String: {request.url.query}")
    
    # 解析请求参数（支持多种格式）- 完全照抄登录API的逻辑
    params = {}
    
    # 1. 先从 query string 获取
    for key, value in request.query_params.items():
        params[key] = value
    print(f"[IndexData] Query Params: {dict(request.query_params)}")
    
    # 2. 从请求体获取
    raw_body = None
    if request.method == "POST":
        try:
            raw_body = await request.body()
            print(f"[IndexData] Raw Body: {raw_body[:500] if raw_body else 'Empty'}")
        except Exception as e:
            print(f"[IndexData] 读取body失败: {e}")
        
        # 重新创建请求以便再次读取body
        from starlette.requests import Request as StarletteRequest
        
        try:
            if "application/json" in content_type:
                body = json.loads(raw_body) if raw_body else {}
                params.update(body)
                print(f"[IndexData] 解析为JSON: {body}")
            elif "application/x-www-form-urlencoded" in content_type:
                # 解析 form-urlencoded
                from urllib.parse import parse_qs
                form_data = parse_qs(raw_body.decode('utf-8') if raw_body else '')
                for key, value in form_data.items():
                    params[key] = value[0] if value else ''
                print(f"[IndexData] 解析为Form: {params}")
            else:
                # 尝试解析为 JSON
                try:
                    body = json.loads(raw_body) if raw_body else {}
                    params.update(body)
                    print(f"[IndexData] 尝试JSON成功: {body}")
                except:
                    # 尝试解析为 form
                    try:
                        from urllib.parse import parse_qs
                        form_data = parse_qs(raw_body.decode('utf-8') if raw_body else '')
                        for key, value in form_data.items():
                            params[key] = value[0] if value else ''
                        print(f"[IndexData] 尝试Form成功: {params}")
                    except Exception as e:
                        print(f"[IndexData] 解析失败: {e}")
        except Exception as e:
            print(f"[IndexData] 解析异常: {e}")
    
    print(f"[IndexData] 最终解析结果: {params}")
    print(f"[IndexData] 所有参数keys: {list(params.keys())}")
    
    # 转发请求到原始服务器（优先代理池，回退直连）
    fwd_headers = {
        "User-Agent": user_agent,
        "X-Forwarded-For": client_ip,
        "X-Real-IP": client_ip
    }
    if "application/json" in content_type:
        fwd_headers["Content-Type"] = "application/json"

    try:
        response = None
        use_direct = _HAS_PROXY_POOL and pp.should_use_direct()
        
        if use_direct:
            async with httpx.AsyncClient(verify=False, timeout=30) as client:
                if "application/json" in content_type:
                    response = await client.post(AKAPI_URL + "public_IndexData", json=params, headers=fwd_headers)
                else:
                    response = await client.post(AKAPI_URL + "public_IndexData", data=params, headers=fwd_headers)
            if response.status_code == 403:
                pp.report_direct_blocked()
                response = None
            else:
                pp.report_direct_success()
                pp.report_route("本地直连")
        
        if response is None and _HAS_PROXY_POOL:
            proxy_resp = await pp.proxy_request(
                "POST", AKAPI_URL + "public_IndexData",
                json_data=params if "application/json" in content_type else None,
                form_data=params if "application/json" not in content_type else None,
                headers=fwd_headers
            )
            if proxy_resp is not None:
                response = proxy_resp
        
        if response is None:
            async with httpx.AsyncClient(verify=False, timeout=30) as client:
                if "application/json" in content_type:
                    response = await client.post(AKAPI_URL + "public_IndexData", json=params, headers=fwd_headers)
                else:
                    response = await client.post(AKAPI_URL + "public_IndexData", data=params, headers=fwd_headers)
            if _HAS_PROXY_POOL: pp.report_route("本地直连(兜底)")
        result = response.json()
        print(f"[IndexData] 服务器响应: Error={result.get('Error')}, 有Data={bool(result.get('Data'))}")
    except Exception as e:
        print(f"[IndexData] 请求失败: {e}")
        return JSONResponse({
            "Error": True,
            "Msg": f"服务器连接失败: {str(e)}"
        })
    
    # 如果成功获取数据，先保存到数据库再返回给客户端
    if not result.get("Error") and result.get("Data"):
        data = result["Data"]
        
        print(f"[IndexData] 收到有效数据，尝试获取用户名...")
        print(f"[IndexData] 请求参数: {params}")
        print(f"[IndexData] 客户端IP: {client_ip}")
        
        # 尝试多种方式获取用户名
        username = None
        
        # 方式1: 从请求参数获取 (可能是account, UserID, key等)
        if params:
            username = params.get("account") or params.get("Account") or params.get("UserName") or params.get("username")
            if username:
                print(f"[IndexData] 从请求参数获取到用户名: {username}")
        
        # 方式2: 从返回数据中获取用户名
        if not username and data:
            username = data.get("UserName") or data.get("Account") or data.get("NickName")
            if username:
                print(f"[IndexData] 从返回数据获取到用户名: {username}")
        
        # 方式3: 从最近登录记录中查找该IP的用户
        if not username:
            print(f"[IndexData] 尝试从登录记录中通过IP查找用户...")
            recent = get_recent_logins(limit=50)
            for login in recent:
                login_ip = login.get("ip_address", "")
                login_user = login.get("username", "")
                if login_ip == client_ip and login_user and login_user != "unknown":
                    username = login_user
                    print(f"[IndexData] 通过IP匹配找到用户: {username} (IP: {login_ip})")
                    break
            if not username:
                print(f"[IndexData] 未能通过IP找到用户，最近登录IP列表: {[l.get('ip_address') for l in recent[:5]]}")
        
        if username and username != "unknown":
            # 检查数据结构，看是否包含资产信息
            print(f"[IndexData] 用户: {username}")
            print(f"[IndexData] 数据字段: {list(data.keys())}")
            print(f"[IndexData] 是否包含ACECount: {'ACECount' in data}")
            print(f"[IndexData] 是否包含EP: {'EP' in data}")
            
            # 只有包含资产字段时才保存
            if 'ACECount' in data or 'EP' in data:
                print(f"[IndexData] 发现资产数据，保存到数据库")
                update_user_assets(username, data)
            else:
                print(f"[IndexData] 这是用户资料数据，不是资产数据，跳过保存")
            
            # 广播资产更新事件（包含所有点数）
            await manager.broadcast({
                "type": "asset_update",
                "data": {
                    "username": username,
                    "ace_count": data.get("ACECount", 0),
                    "total_ace": data.get("TotalACE", 0),
                    "ep": data.get("EP", 0),
                    "sp": data.get("SP", 0),
                    "rp": data.get("RP", 0),
                    "tp": data.get("TP", 0),
                    "weekly_money": data.get("WeeklyMoney", 0),
                    "rate": data.get("Rate", 0),
                    "honor_name": data.get("HonorName", ""),
                    "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                }
            })
    
    # 返回给客户端
    return JSONResponse(result)

# ===== 其他RPC请求代理 =====
@app.api_route("/RPC/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy_rpc(path: str, request: Request):
    """代理其他RPC请求"""
    
    # 优先从nginx代理头获取真实IP
    client_ip = request.headers.get("x-real-ip") or request.headers.get("x-forwarded-for", "").split(",")[0].strip() or request.client.host
    
    # 检查IP封禁
    if is_banned(ip_address=client_ip):
        return JSONResponse({
            "Error": True,
            "Msg": "您的IP已被封禁"
        })
    
    # 获取请求体
    body = None
    if request.method in ["POST", "PUT"]:
        try:
            body = await request.json()
        except:
            body = await request.body()
    
    # 转发请求（优先代理池，回退直连）
    fwd_headers = {
        "User-Agent": request.headers.get("user-agent", ""),
        "Content-Type": request.headers.get("content-type", "application/json"),
        "Accept": request.headers.get("accept", "*/*"),
        "X-Forwarded-For": client_ip,
        "X-Real-IP": client_ip
    }
    try:
        response = None
        use_direct = _HAS_PROXY_POOL and pp.should_use_direct()
        
        if use_direct:
            async with httpx.AsyncClient(verify=False, timeout=30) as client:
                response = await client.request(
                    method=request.method, url=AKAPI_URL + path,
                    json=body if isinstance(body, dict) else None,
                    content=body if isinstance(body, bytes) else None,
                    headers=fwd_headers
                )
            if response.status_code == 403:
                pp.report_direct_blocked()
                response = None
            else:
                pp.report_direct_success()
                pp.report_route("本地直连")
        
        if response is None and _HAS_PROXY_POOL:
            proxy_resp = await pp.proxy_request(
                request.method, AKAPI_URL + path,
                json_data=body if isinstance(body, dict) else None,
                headers=fwd_headers
            )
            if proxy_resp is not None:
                response = proxy_resp
        
        if response is None:
            async with httpx.AsyncClient(verify=False, timeout=30) as client:
                response = await client.request(
                    method=request.method, url=AKAPI_URL + path,
                    json=body if isinstance(body, dict) else None,
                    content=body if isinstance(body, bytes) else None,
                    headers=fwd_headers
                )
            if _HAS_PROXY_POOL: pp.report_route("本地直连(兜底)")
        return JSONResponse(
            content=response.json() if response.headers.get("content-type", "").startswith("application/json") else response.text,
            status_code=response.status_code
        )
    except Exception as e:
        return JSONResponse({
            "Error": True,
            "Msg": f"请求失败: {str(e)}"
        }, status_code=500)

# ===== 管理API =====

# 登录失败记录（防暴力破解）
login_fail_records = {}  # {ip: [fail_count, last_fail_time]}
LOGIN_MAX_FAILS = 5  # 最大失败次数
LOGIN_LOCKOUT_TIME = 300  # 锁定时间（秒）

def check_login_lockout(ip: str) -> tuple[bool, int]:
    """检查IP是否被锁定，返回(是否锁定, 剩余秒数)"""
    record = login_fail_records.get(ip)
    if not record:
        return False, 0
    fail_count, last_fail = record
    if fail_count >= LOGIN_MAX_FAILS:
        elapsed = time.time() - last_fail
        if elapsed < LOGIN_LOCKOUT_TIME:
            return True, int(LOGIN_LOCKOUT_TIME - elapsed)
        else:
            # 锁定时间已过，重置
            del login_fail_records[ip]
    return False, 0

def record_login_fail(ip: str):
    """记录登录失败"""
    record = login_fail_records.get(ip, [0, 0])
    record[0] += 1
    record[1] = time.time()
    login_fail_records[ip] = record

def clear_login_fail(ip: str):
    """清除登录失败记录"""
    if ip in login_fail_records:
        del login_fail_records[ip]

def verify_admin_password(password: str) -> tuple:
    """验证管理员密码，返回(是否通过, 权限级别, 子管理员名称)"""
    if not password or not isinstance(password, str):
        return False, None, None
    
    # 先检查系统总管理员
    if secrets.compare_digest(password, ADMIN_PASSWORD):
        return True, ROLE_SUPER_ADMIN, None
    
    # 再检查所有子管理员
    for sub_name, sub_data in SUB_ADMINS.items():
        sub_pwd = sub_data.get('password', '') if isinstance(sub_data, dict) else sub_data
        if sub_pwd and secrets.compare_digest(password, sub_pwd):
            return True, ROLE_SUB_ADMIN, sub_name
    
    return False, None, None

def get_sub_admin_permissions(sub_name: str) -> dict:
    """获取子管理员的权限"""
    sub_data = SUB_ADMINS.get(sub_name, {})
    if isinstance(sub_data, dict):
        return sub_data.get('permissions', {})
    return {}

def check_token_permission(token: str, perm_key: str) -> bool:
    """检查Token是否拥有指定权限。超管拥有所有权限。"""
    role = get_token_role(token)
    if role == ROLE_SUPER_ADMIN:
        return True
    if role == ROLE_SUB_ADMIN:
        sub_name = get_token_sub_name(token)
        if sub_name:
            perms = get_sub_admin_permissions(sub_name)
            return perms.get(perm_key, False)
    return False

# 管理员 Token 管理（持久化到数据库，服务器重启后Token依然有效）
admin_tokens = {}  # 内存缓存 {token: {'expire': expire_time, 'role': role}}

def _load_tokens_from_db():
    """从数据库加载有效Token到内存缓存"""
    global admin_tokens
    try:
        admin_tokens = load_all_admin_tokens()
        print(f"[Token] 从数据库恢复了 {len(admin_tokens)} 个有效Token")
    except Exception as e:
        print(f"[Token] 加载Token失败: {e}")
        admin_tokens = {}

def generate_admin_token(role: str, sub_name: str = '') -> str:
    """生成安全的管理员Token（登录排他性：同角色/同子管理员只允许一个设备登录）"""
    if role == ROLE_SUB_ADMIN and sub_name:
        # 子管理员：只删除同名子管理员的token
        tokens_to_remove = [
            t for t, data in admin_tokens.items() 
            if data.get('role') == ROLE_SUB_ADMIN and data.get('sub_name') == sub_name
        ]
        for t in tokens_to_remove:
            del admin_tokens[t]
        delete_admin_tokens_by_sub_name(sub_name)
    else:
        # 系统总管理：删除同角色的所有token
        tokens_to_remove = [
            t for t, data in admin_tokens.items() 
            if data.get('role') == role
        ]
        for t in tokens_to_remove:
            del admin_tokens[t]
        delete_admin_tokens_by_role(role)
    
    token = secrets.token_urlsafe(32)
    expire = time.time() + 86400  # Token有效期24小时
    admin_tokens[token] = {
        'expire': expire,
        'role': role,
        'sub_name': sub_name
    }
    # 持久化到数据库
    save_admin_token(token, role, expire, sub_name)
    
    # 清理过期token
    current = time.time()
    expired = [k for k, v in admin_tokens.items() if v.get('expire', 0) < current]
    for k in expired:
        del admin_tokens[k]
    cleanup_expired_tokens()
    
    return token

def verify_admin_token(token: str) -> bool:
    """验证管理员Token"""
    if not token:
        return False
    # 先查内存缓存
    token_data = admin_tokens.get(token)
    if not token_data:
        # 缓存没有，尝试从数据库加载
        token_data = get_admin_token(token)
        if token_data:
            admin_tokens[token] = token_data  # 回填缓存
    if not token_data:
        return False
    if time.time() > token_data.get('expire', 0):
        del admin_tokens[token]
        delete_admin_token(token)
        return False
    return True

def get_token_role(token: str) -> str:
    """获取Token对应的权限级别"""
    if not token:
        return None
    token_data = admin_tokens.get(token)
    if not token_data:
        token_data = get_admin_token(token)
        if token_data:
            admin_tokens[token] = token_data
    if token_data and time.time() <= token_data.get('expire', 0):
        return token_data.get('role')
    return None

def get_token_sub_name(token: str) -> str:
    """获取Token对应的子管理员名称"""
    if not token:
        return ''
    token_data = admin_tokens.get(token)
    if not token_data:
        token_data = get_admin_token(token)
        if token_data:
            admin_tokens[token] = token_data
    if token_data and time.time() <= token_data.get('expire', 0):
        return token_data.get('sub_name', '')
    return ''

def kick_sub_admins(target_name: str = None):
    """踢出子管理员（使其token失效），target_name为None则踢出所有"""
    global admin_tokens
    if target_name:
        # 踢出指定子管理员
        tokens_to_remove = [
            token for token, data in admin_tokens.items() 
            if data.get('role') == ROLE_SUB_ADMIN and data.get('sub_name') == target_name
        ]
        for token in tokens_to_remove:
            del admin_tokens[token]
        count = delete_admin_tokens_by_sub_name(target_name)
        return max(len(tokens_to_remove), count)
    else:
        # 踢出所有子管理员
        tokens_to_remove = [
            token for token, data in admin_tokens.items() 
            if data.get('role') == ROLE_SUB_ADMIN
        ]
        for token in tokens_to_remove:
            del admin_tokens[token]
        count = delete_admin_tokens_by_role(ROLE_SUB_ADMIN)
        return max(len(tokens_to_remove), count)

# 服务启动时从数据库恢复Token
_load_tokens_from_db()

# 定时清理过期Token（每小时执行一次）
async def _token_cleanup_task():
    """后台任务：定期清理过期Token"""
    import asyncio
    while True:
        await asyncio.sleep(3600)  # 每小时
        try:
            # 清理内存缓存中的过期token
            current = time.time()
            expired = [k for k, v in admin_tokens.items() if v.get('expire', 0) < current]
            for k in expired:
                del admin_tokens[k]
            # 清理数据库中的过期token
            db_count = cleanup_expired_tokens()
            if expired or db_count:
                print(f"[Token] 定时清理: 内存{len(expired)}个, 数据库{db_count}个过期Token")
        except Exception as e:
            print(f"[Token] 清理失败: {e}")

@app.on_event("startup")
async def _startup_cleanup():
    import asyncio
    asyncio.create_task(_token_cleanup_task())

@app.post("/admin/api/login")
async def admin_login(request: Request):
    """管理员登录验证（增强安全）"""
    # 获取客户端IP
    client_ip = request.client.host if request.client else "unknown"
    
    # 检查是否被锁定
    is_locked, remaining = check_login_lockout(client_ip)
    if is_locked:
        return {"success": False, "message": f"登录尝试过多，请{remaining}秒后重试"}
    
    try:
        data = await request.json()
        password = data.get('password', '')
    except:
        return {"success": False, "message": "请求无效"}
    
    # 防暴力破解延迟
    await asyncio.sleep(0.3)
    
    is_valid, role, sub_name = verify_admin_password(password)
    if is_valid:
        # 登录成功，清除失败记录
        clear_login_fail(client_ip)
        token = generate_admin_token(role, sub_name=sub_name or '')
        if role == ROLE_SUPER_ADMIN:
            role_name = "系统总管理"
            permissions = {}  # 超管拥有全部权限，前端不做限制
        else:
            role_name = f"子管理员({sub_name})" if sub_name else "子管理员"
            permissions = get_sub_admin_permissions(sub_name) if sub_name else {}
        return {"success": True, "token": token, "role": role, "role_name": role_name, "sub_name": sub_name or "", "permissions": permissions}
    else:
        # 登录失败，记录并额外延迟
        record_login_fail(client_ip)
        await asyncio.sleep(0.7)
        
        # 检查是否达到锁定阈值
        record = login_fail_records.get(client_ip, [0, 0])
        if record[0] >= LOGIN_MAX_FAILS:
            return {"success": False, "message": f"密码错误次数过多，账号已锁定{LOGIN_LOCKOUT_TIME}秒"}
        
        remaining_attempts = LOGIN_MAX_FAILS - record[0]
        return {"success": False, "message": f"密码错误，剩余{remaining_attempts}次尝试机会"}

@app.get("/admin/api/verify_token")
async def verify_token_api(request: Request):
    """验证Token是否有效"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not token:
        return JSONResponse(status_code=401, content={"valid": False, "message": "未登录"})
    
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"valid": False, "message": "登录已失效"})
    
    role = get_token_role(token)
    sub_name = get_token_sub_name(token)
    if role == ROLE_SUPER_ADMIN:
        role_name = "系统总管理"
        permissions = {}
    else:
        role_name = f"子管理员({sub_name})" if sub_name else "子管理员"
        permissions = get_sub_admin_permissions(sub_name) if sub_name else {}
    return {"valid": True, "role": role, "role_name": role_name, "sub_name": sub_name or "", "permissions": permissions}

@app.get("/admin/api/stats")
async def get_stats():
    """获取统计摘要"""
    return get_stats_summary()

@app.get("/admin/api/dashboard")
async def get_dashboard():
    """获取仪表盘数据"""
    return get_dashboard_data()

@app.get("/admin/api/users")
async def get_users(limit: int = 100, offset: int = 0):
    """获取用户列表（包含资产信息）"""
    return get_all_users_with_assets(limit, offset)

@app.get("/admin/api/ips")
async def get_ips(limit: int = 100, offset: int = 0):
    """获取IP列表"""
    return get_all_ips(limit, offset)

@app.get("/admin/api/usage")
async def get_usage(limit: int = 500):
    """获取使用情况（user_stats表）"""
    return get_all_users(limit, 0)

@app.get("/admin/api/logins")
async def get_logins(limit: int = 50):
    """获取最近登录记录"""
    return get_recent_logins(limit)

@app.get("/admin/api/user/{username}")
async def get_user(username: str):
    """获取用户详情"""
    user = get_user_detail(username)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    return user

@app.get("/admin/api/banlist")
async def get_banlist():
    """获取封禁列表"""
    return get_ban_list()

@app.get("/admin/api/assets")
async def get_assets(limit: int = 100, offset: int = 0, search: str = None):
    """获取所有用户资产列表（支持分页和搜索）"""
    return get_all_user_assets(limit, offset, search)

@app.get("/admin/api/assets/{username}")
async def get_user_asset(username: str):
    """获取指定用户资产"""
    assets = get_user_assets(username)
    if not assets:
        raise HTTPException(status_code=404, detail="用户资产不存在")
    assets['history'] = get_asset_history(username)
    return assets

@app.post("/admin/api/ban/user")
async def ban_user_api(req: BanRequest):
    """封禁用户"""
    ban_user(req.value, req.reason)
    await manager.broadcast({
        "type": "user_banned",
        "data": {"username": req.value, "reason": req.reason}
    })
    return {"success": True, "message": f"用户 {req.value} 已被封禁"}

@app.post("/admin/api/unban/user")
async def unban_user_api(req: BanRequest):
    """解封用户"""
    unban_user(req.value)
    await manager.broadcast({
        "type": "user_unbanned",
        "data": {"username": req.value}
    })
    return {"success": True, "message": f"用户 {req.value} 已解封"}

@app.post("/admin/api/ban/ip")
async def ban_ip_api(req: BanRequest):
    """封禁IP"""
    ban_ip(req.value, req.reason)
    await manager.broadcast({
        "type": "ip_banned",
        "data": {"ip": req.value, "reason": req.reason}
    })
    return {"success": True, "message": f"IP {req.value} 已被封禁"}

@app.post("/admin/api/unban/ip")
async def unban_ip_api(req: BanRequest):
    """解封IP"""
    unban_ip(req.value)
    await manager.broadcast({
        "type": "ip_unbanned",
        "data": {"ip": req.value}
    })
    return {"success": True, "message": f"IP {req.value} 已解封"}

@app.get("/admin/api/sub_admin")
async def get_sub_admin_status(request: Request):
    """获取所有子管理员状态"""
    current_time = time.time()
    
    # 收集所有在线的子管理员信息
    online_subs = {}
    for token, data in admin_tokens.items():
        if data.get('role') == ROLE_SUB_ADMIN and data.get('expire', 0) > current_time:
            sname = data.get('sub_name', '')
            if sname and sname not in online_subs:
                login_timestamp = data.get('expire', 0) - 86400
                online_subs[sname] = datetime.fromtimestamp(login_timestamp).strftime('%Y-%m-%d %H:%M:%S')
    
    # 构建子管理员列表
    sub_admin_list = []
    for name, sub_data in SUB_ADMINS.items():
        pwd = sub_data.get('password', '') if isinstance(sub_data, dict) else sub_data
        perms = sub_data.get('permissions', {}) if isinstance(sub_data, dict) else {}
        sub_admin_list.append({
            "name": name,
            "password_hint": pwd[:2] + "***" if pwd and len(pwd) > 2 else "***",
            "is_online": name in online_subs,
            "login_time": online_subs.get(name),
            "permissions": perms
        })
    
    return {
        "sub_admins": sub_admin_list,
        "total": len(SUB_ADMINS)
    }

@app.post("/admin/api/sub_admin/set")
async def set_sub_admin(request: Request):
    """添加/更新子管理员（仅系统总管理可操作）"""
    await asyncio.sleep(0.3)
    
    try:
        data = await request.json()
        admin_password = data.get('admin_password', '')
        secondary_password = data.get('secondary_password', '')
        sub_name = data.get('sub_name', '').strip()
        new_sub_password = data.get('new_sub_password', '')
    except:
        return {"success": False, "message": "请求无效"}
    
    # 验证系统总管理员身份
    is_valid, role, _ = verify_admin_password(admin_password)
    if not is_valid or role != ROLE_SUPER_ADMIN:
        await asyncio.sleep(0.7)
        return {"success": False, "message": "系统总管理员密码错误"}
    
    # 验证二级密码
    if not verify_db_password(secondary_password):
        await asyncio.sleep(0.7)
        return {"success": False, "message": "二级密码错误"}
    
    # 验证子管理员名称
    if not sub_name:
        return {"success": False, "message": "请输入子管理员名称"}
    
    if len(sub_name) > 20:
        return {"success": False, "message": "子管理员名称不能超过20个字符"}
    
    # 验证新密码
    if not new_sub_password or len(new_sub_password) < 6:
        return {"success": False, "message": "子管理员密码至少需要6位"}
    
    # 不能与系统总管理员密码相同
    if secrets.compare_digest(new_sub_password, ADMIN_PASSWORD):
        return {"success": False, "message": "子管理员密码不能与总管理员密码相同"}
    
    # 不能与其他子管理员密码相同
    for existing_name, existing_data in SUB_ADMINS.items():
        existing_pwd = existing_data.get('password', '') if isinstance(existing_data, dict) else existing_data
        if existing_name != sub_name and existing_pwd and secrets.compare_digest(new_sub_password, existing_pwd):
            return {"success": False, "message": f"该密码已被子管理员 [{existing_name}] 使用"}
    
    # 解析权限
    permissions = data.get('permissions', {})
    if not isinstance(permissions, dict):
        permissions = {}
    
    # 保存子管理员到数据库
    is_update = sub_name in SUB_ADMINS
    try:
        db_set_sub_admin(sub_name, new_sub_password, permissions)
        SUB_ADMINS[sub_name] = {'password': new_sub_password, 'permissions': permissions}  # 同步内存
        action = "更新" if is_update else "添加"
        return {"success": True, "message": f"子管理员 [{sub_name}] {action}成功"}
    except Exception as e:
        return {"success": False, "message": f"保存失败: {e}"}

@app.post("/admin/api/sub_admin/update_permissions")
async def update_sub_admin_permissions_api(request: Request):
    """仅更新子管理员权限（仅系统总管理可操作），更新后踢出该子管理员"""
    await asyncio.sleep(0.3)
    
    try:
        data = await request.json()
        admin_password = data.get('admin_password', '')
        sub_name = data.get('sub_name', '').strip()
        permissions = data.get('permissions', {})
    except:
        return {"success": False, "message": "请求无效"}
    
    # 验证系统总管理员身份
    is_valid, role, _ = verify_admin_password(admin_password)
    if not is_valid or role != ROLE_SUPER_ADMIN:
        return {"success": False, "message": "需要系统总管理员密码"}
    
    if not sub_name or sub_name not in SUB_ADMINS:
        return {"success": False, "message": f"子管理员 [{sub_name}] 不存在"}
    
    if not isinstance(permissions, dict):
        permissions = {}
    
    try:
        db_update_sub_admin_permissions(sub_name, permissions)
        # 同步内存
        if isinstance(SUB_ADMINS.get(sub_name), dict):
            SUB_ADMINS[sub_name]['permissions'] = permissions
        
        # 踢出该子管理员，强制重新登录以获取新权限
        kicked = 0
        tokens_to_remove = []
        for token, tdata in admin_tokens.items():
            if tdata.get('role') == ROLE_SUB_ADMIN and tdata.get('sub_name') == sub_name:
                tokens_to_remove.append(token)
        for token in tokens_to_remove:
            try:
                delete_admin_token(token)
            except:
                pass
            admin_tokens.pop(token, None)
            kicked += 1
        
        return {"success": True, "message": f"子管理员 [{sub_name}] 权限已更新" + (f"，已踢出{kicked}个会话" if kicked > 0 else "")}
    except Exception as e:
        return {"success": False, "message": f"更新失败: {e}"}

@app.post("/admin/api/sub_admin/delete")
async def delete_sub_admin(request: Request):
    """删除子管理员（仅系统总管理可操作）"""
    await asyncio.sleep(0.3)
    
    try:
        data = await request.json()
        admin_password = data.get('admin_password', '')
        secondary_password = data.get('secondary_password', '')
        sub_name = data.get('sub_name', '').strip()
    except:
        return {"success": False, "message": "请求无效"}
    
    # 验证系统总管理员身份
    is_valid, role, _ = verify_admin_password(admin_password)
    if not is_valid or role != ROLE_SUPER_ADMIN:
        await asyncio.sleep(0.7)
        return {"success": False, "message": "系统总管理员密码错误"}
    
    # 验证二级密码
    if not verify_db_password(secondary_password):
        await asyncio.sleep(0.7)
        return {"success": False, "message": "二级密码错误"}
    
    if not sub_name:
        return {"success": False, "message": "请指定要删除的子管理员名称"}
    
    if sub_name not in SUB_ADMINS:
        return {"success": False, "message": f"子管理员 [{sub_name}] 不存在"}
    
    # 先踢出该子管理员
    kick_sub_admins(target_name=sub_name)
    
    # 从数据库删除子管理员
    try:
        db_delete_sub_admin(sub_name)
        SUB_ADMINS.pop(sub_name, None)  # 同步内存
        return {"success": True, "message": f"子管理员 [{sub_name}] 已删除"}
    except Exception as e:
        return {"success": False, "message": f"删除失败: {e}"}

@app.post("/admin/api/sub_admin/kick")
async def kick_sub_admin_api(request: Request):
    """踢出子管理员（仅系统总管理可操作）"""
    await asyncio.sleep(0.3)
    
    try:
        data = await request.json()
        admin_password = data.get('admin_password', '')
        sub_name = data.get('sub_name', '').strip()  # 为空则踢出所有
    except:
        return {"success": False, "message": "请求无效"}
    
    # 验证系统总管理员身份
    is_valid, role, _ = verify_admin_password(admin_password)
    if not is_valid or role != ROLE_SUPER_ADMIN:
        await asyncio.sleep(0.7)
        return {"success": False, "message": "系统总管理员密码错误"}
    
    # 踢出子管理员
    count = kick_sub_admins(target_name=sub_name if sub_name else None)
    target_text = f"子管理员 [{sub_name}]" if sub_name else "所有子管理员"
    if count > 0:
        return {"success": True, "message": f"已踢出 {target_text} ({count} 个会话)"}
    else:
        return {"success": True, "message": f"{target_text} 当前没有在线会话"}

# ===== 激活码管理代理 =====
# Server_V 激活码服务地址（根据实际部署修改）
LICENSE_SERVER_URL = os.environ.get('LICENSE_SERVER_URL', 'http://121.4.46.66:8080')
LICENSE_ADMIN_KEY = os.environ.get('LICENSE_ADMIN_KEY', 'ak-lovejjy1314')

async def proxy_license_request(method: str, path: str, params: dict = None, json_body: dict = None):
    """代理请求到激活码服务"""
    url = f"{LICENSE_SERVER_URL}/api/v1{path}"
    
    # 注入 admin_key
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
            elif method == 'POST':
                resp = await client.post(url, json=json_body, params=params)
            else:
                return {"error": True, "message": "不支持的方法"}
            
            return resp.json()
    except httpx.ConnectError:
        return {"error": True, "message": "无法连接激活码服务器，请确认服务已启动"}
    except Exception as e:
        return {"error": True, "message": f"代理请求失败: {str(e)}"}

@app.get("/admin/api/license/statistics")
async def license_statistics(request: Request):
    """获取激活码统计"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', '/admin/statistics')

@app.get("/admin/api/license/list")
async def license_list(request: Request, limit: int = 50, offset: int = 0):
    """获取激活码列表"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', '/admin/licenses', params={'limit': limit, 'offset': offset})

@app.get("/admin/api/license/info/{license_key}")
async def license_info(license_key: str, request: Request):
    """获取激活码详情"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', f'/admin/license-info/{license_key}')

@app.post("/admin/api/license/create")
async def license_create(request: Request):
    """创建激活码"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    
    # 权限检查：需要 license 权限
    if not check_token_permission(token, 'license'):
        return {"error": True, "message": "您没有激活码管理权限"}
    
    data = await request.json()
    role = get_token_role(token)
    result = await proxy_license_request('POST', '/admin/create-license', json_body=data)
    
    # 记录创建日志
    if isinstance(result, dict) and not result.get('error'):
        license_key = result.get('data', {}).get('license_key', '')
        detail = f"有效期{data.get('expiry_days', 365)}天"
        if data.get('billing_mode') == 'per_use':
            detail += f", 最大{data.get('max_uses', 100)}次"
        elif data.get('billing_mode') == 'time_based':
            detail += f", 时长{data.get('usage_time', 30)}天"
        add_license_log('create', license_key, data.get('product_id'), 
                       data.get('billing_mode'), detail, role)
    
    return result

@app.post("/admin/api/license/revoke")
async def license_revoke(request: Request):
    """撤销激活码"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    
    # 权限检查：需要 license 权限
    if not check_token_permission(token, 'license'):
        return {"error": True, "message": "您没有激活码管理权限"}
    role = get_token_role(token)
    
    data = await request.json()
    result = await proxy_license_request('POST', '/admin/revoke-license', json_body=data)
    
    # 记录撤销日志
    if isinstance(result, dict) and not result.get('error'):
        add_license_log('revoke', data.get('license_key'), detail='撤销激活码', operator=role)
    
    return result

@app.post("/admin/api/license/edit")
async def license_edit(request: Request):
    """编辑激活码"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    
    # 权限检查：需要 license 权限
    if not check_token_permission(token, 'license'):
        return {"error": True, "message": "您没有激活码管理权限"}
    
    data = await request.json()
    return await proxy_license_request('POST', '/admin/edit-license', json_body=data)

@app.get("/admin/api/license/clients")
async def license_clients(request: Request, limit: int = 100, offset: int = 0):
    """获取客户端列表"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', '/admin/clients', params={'limit': limit, 'offset': offset})

@app.get("/admin/api/license/clients/{client_id}")
async def license_client_detail(client_id: str, request: Request):
    """获取客户端详情"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', f'/admin/clients/{client_id}')

@app.post("/admin/api/license/blacklist/add")
async def license_blacklist_add(request: Request):
    """添加黑名单"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    
    if not check_token_permission(token, 'license'):
        return {"error": True, "message": "您没有激活码管理权限"}
    
    data = await request.json()
    return await proxy_license_request('POST', '/admin/blacklist', json_body=data)

@app.post("/admin/api/license/blacklist/remove")
async def license_blacklist_remove(request: Request):
    """移除黑名单"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    
    if not check_token_permission(token, 'license'):
        return {"error": True, "message": "您没有激活码管理权限"}
    
    data = await request.json()
    return await proxy_license_request('POST', '/admin/blacklist/remove', json_body=data)

@app.get("/admin/api/license/blacklist")
async def license_blacklist_list(request: Request):
    """获取黑名单"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', '/admin/blacklist')

@app.get("/admin/api/license/online-clients")
async def license_online_clients(request: Request):
    """获取在线客户端"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', '/admin/online-clients')

@app.post("/admin/api/license/disable-client")
async def license_disable_client(request: Request):
    """禁用客户端设备（实时推送）"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    
    role = get_token_role(token)
    if role != ROLE_SUPER_ADMIN:
        return {"error": True, "message": "仅系统总管理员可禁用客户端"}
    
    data = await request.json()
    return await proxy_license_request('POST', '/admin/disable-client', json_body=data)

@app.post("/admin/api/license/enable-client")
async def license_enable_client(request: Request):
    """启用客户端设备（实时推送）"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    
    role = get_token_role(token)
    if role != ROLE_SUPER_ADMIN:
        return {"error": True, "message": "仅系统总管理员可启用客户端"}
    
    data = await request.json()
    return await proxy_license_request('POST', '/admin/enable-client', json_body=data)

@app.get("/admin/api/license/logs")
async def license_logs(request: Request, limit: int = 100, offset: int = 0):
    """获取使用日志"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', '/admin/logs', params={'limit': limit, 'offset': offset})

@app.get("/admin/api/license/local-logs")
async def license_local_logs(request: Request, action: str = None, limit: int = 50, offset: int = 0):
    """获取本地激活码操作记录"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return get_license_logs(action=action or None, limit=limit, offset=offset)

@app.get("/admin/api/license/products")
async def license_products(request: Request):
    """获取产品列表"""
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
    return await proxy_license_request('GET', '/admin/products')

@app.get("/admin/api/license/health")
async def license_health():
    """激活码服务健康检查"""
    return await proxy_license_request('GET', '/health')

# ===== WebSocket - 管理后台 =====
@app.websocket("/admin/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket实时推送"""
    await manager.connect(websocket)
    try:
        while True:
            # 保持连接，等待消息
            data = await websocket.receive_text()
            # 可以处理客户端发来的消息
    except (WebSocketDisconnect, Exception):
        manager.disconnect(websocket)

# ===== WebSocket - 用户聊天 =====
@app.websocket("/chat/ws")
async def chat_websocket(websocket: WebSocket):
    """用户聊天WebSocket"""
    await websocket.accept()
    
    # 获取用户名
    username = websocket.query_params.get('username', 'visitor')
    print(f"[ChatWS] 新WebSocket连接: username={username}, ws_id={id(websocket)}")
    
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get('type')
            if msg_type != 'heartbeat':
                print(f"[ChatWS] 收到消息: type={msg_type}, username={username}, ws_id={id(websocket)}")
            
            if msg_type == 'online':
                # 用户上线
                await online_manager.user_online(
                    data.get('username', username),
                    websocket,
                    data.get('page', ''),
                    data.get('userAgent', '')
                )
                username = data.get('username', username)
                # 发送历史消息
                history = online_manager.get_messages(username)
                if history:
                    await websocket.send_json({
                        'type': 'history',
                        'messages': history
                    })
            
            elif msg_type == 'heartbeat':
                # 心跳
                online_manager.update_heartbeat(username)
                heartbeat_page = data.get('page', '')
                if heartbeat_page and username in online_manager.users:
                    online_manager.users[username]['page'] = heartbeat_page
            
            elif msg_type == 'user_message':
                # 用户发送消息
                content = data.get('content', '')
                print(f"[ChatWS] 收到用户消息: username={username}, content={content}, ws_id={id(websocket)}")
                if content:
                    online_manager.save_user_message(username, content)
                    # 广播给管理后台
                    broadcast_data = {
                        'type': 'chat_message',
                        'data': {
                            'username': username,
                            'content': content,
                            'time': datetime.now().strftime('%H:%M:%S'),
                            'is_admin': False
                        }
                    }
                    print(f"[ChatWS] 广播用户消息给管理后台: {broadcast_data}")
                    await manager.broadcast(broadcast_data)
            
            elif msg_type == 'offline':
                # 用户离线
                online_manager.user_offline(username)
                await manager.broadcast({
                    'type': 'user_offline',
                    'data': {'username': username}
                })
                break
                
    except (WebSocketDisconnect, Exception):
        online_manager.user_offline(username)
        await manager.broadcast({
            'type': 'user_offline',
            'data': {'username': username}
        })

# ===== 在线用户API =====
@app.get("/admin/api/online")
async def get_online_users():
    """获取在线用户列表"""
    return online_manager.get_online_users()

@app.post("/admin/api/chat/send")
async def send_chat_message(request: Request):
    """发送消息给用户"""
    data = await request.json()
    username = data.get('username')
    content = data.get('content')
    
    if not username or not content:
        raise HTTPException(status_code=400, detail="缺少参数")
    
    success = await online_manager.send_to_user(username, content)
    if success:
        # 广播给管理后台
        await manager.broadcast({
            'type': 'chat_message',
            'data': {
                'username': username,
                'content': content,
                'time': datetime.now().strftime('%H:%M:%S'),
                'is_admin': True
            }
        })
        return {"success": True}
    else:
        raise HTTPException(status_code=404, detail="用户不在线")

@app.get("/admin/api/chat/history/{username}")
async def get_chat_history(username: str):
    """获取聊天历史"""
    return online_manager.get_messages(username)

@app.post("/admin/api/chat/broadcast")
async def broadcast_chat_message(request: Request):
    """群发消息给所有在线用户"""
    data = await request.json()
    content = data.get('content')
    
    if not content:
        raise HTTPException(status_code=400, detail="缺少消息内容")
    
    # 获取所有在线用户并发送（群发消息不保存到个人聊天历史）
    online_users = online_manager.get_online_users()
    sent_count = 0
    
    for user in online_users:
        username = user.get('username')
        if username:
            success = await online_manager.send_to_user(username, content, save_history=False)
            if success:
                sent_count += 1
    
    # 广播给管理后台
    await manager.broadcast({
        'type': 'broadcast_message',
        'data': {
            'content': content,
            'time': datetime.now().strftime('%H:%M:%S'),
            'sent_count': sent_count
        }
    })
    
    return {"success": True, "sent_count": sent_count}

# ===== 数据库管理API（需要二级密码验证） =====

def check_db_auth(request: Request):
    """检查数据库操作授权"""
    token = request.headers.get("X-DB-Token")
    if not verify_db_token(token):
        raise HTTPException(status_code=403, detail="数据库操作需要二级密码验证")

@app.post("/admin/api/db/auth")
async def db_authenticate(request: Request):
    """数据库二级密码验证"""
    try:
        data = await request.json()
        password = data.get('password', '')
        
        # 防止暴力破解 - 添加延迟
        await asyncio.sleep(0.5)
        
        if verify_db_password(password):
            token = generate_db_token()
            return {"success": True, "token": token, "expires_in": 1800}
        else:
            # 失败时额外延迟
            await asyncio.sleep(1)
            raise HTTPException(status_code=401, detail="二级密码错误")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail="验证请求无效")

@app.post("/admin/api/db/verify")
async def db_verify_token(request: Request):
    """验证Token是否有效"""
    token = request.headers.get("X-DB-Token")
    return {"valid": verify_db_token(token)}

@app.get("/admin/api/db/tables")
async def get_tables(request: Request):
    """获取所有表名"""
    check_db_auth(request)
    return get_all_tables()

@app.get("/admin/api/db/schema/{table_name}")
async def get_schema(table_name: str, request: Request):
    """获取表结构"""
    check_db_auth(request)
    return get_table_schema(table_name)

@app.get("/admin/api/db/query/{table_name}")
async def query_data(table_name: str, request: Request, limit: int = 100, offset: int = 0, order_by: str = None, order_desc: bool = True):
    """查询表数据"""
    check_db_auth(request)
    return query_table(table_name, limit, offset, order_by, order_desc)

@app.post("/admin/api/db/insert/{table_name}")
async def insert_data(table_name: str, request: Request):
    """插入数据"""
    check_db_auth(request)
    data = await request.json()
    try:
        row_id = insert_row(table_name, data)
        return {"success": True, "id": row_id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.put("/admin/api/db/update/{table_name}")
async def update_data(table_name: str, request: Request):
    """更新数据"""
    check_db_auth(request)
    data = await request.json()
    pk_column = data.pop('_pk_column', 'id')
    pk_value = data.pop('_pk_value', None)
    if pk_value is None:
        raise HTTPException(status_code=400, detail="缺少主键值")
    try:
        affected = update_row(table_name, pk_column, pk_value, data)
        return {"success": True, "affected_rows": affected}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.delete("/admin/api/db/delete/{table_name}")
async def delete_data(table_name: str, request: Request, pk_column: str = "id", pk_value: str = None):
    """删除数据"""
    check_db_auth(request)
    if pk_value is None:
        raise HTTPException(status_code=400, detail="缺少主键值")
    try:
        affected = delete_row(table_name, pk_column, pk_value)
        return {"success": True, "affected_rows": affected}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/admin/api/db/sql")
async def run_sql(request: Request):
    """执行自定义SQL"""
    check_db_auth(request)
    data = await request.json()
    sql = data.get('sql', '')
    if not sql:
        raise HTTPException(status_code=400, detail="缺少SQL语句")
    try:
        result = execute_sql(sql)
        return {"success": True, "result": result}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

# ===== 代理池管理API =====

def _is_local_request(request: Request) -> bool:
    """判断是否为本地请求（localhost），本地请求免认证
    支持直连、nginx 反代、IPv4-mapped IPv6 等场景"""
    local_ips = {"127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1"}
    def _is_local(ip: str) -> bool:
        return ip in local_ips or ip.startswith("127.")
    client = request.client
    if client and _is_local(client.host):
        return True
    # nginx 反代场景：检查 X-Forwarded-For / X-Real-IP
    real_ip = request.headers.get("X-Real-IP", "")
    if real_ip and _is_local(real_ip):
        return True
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        first_ip = forwarded.split(",")[0].strip()
        if _is_local(first_ip):
            return True
    return False

def _pp_auth_check(request: Request) -> dict:
    """代理池API认证：本地请求免Token，远程请求需要超级管理员Token。
    返回 None 表示通过，否则返回错误响应 dict"""
    if _is_local_request(request):
        return None
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if not verify_admin_token(token):
        return {"_status": 401, "error": True, "message": "未授权"}
    if get_token_role(token) != ROLE_SUPER_ADMIN:
        return {"_status": 403, "success": False, "message": "仅系统总管理可操作"}
    return None

@app.get("/admin/api/proxy_pool/status")
async def proxy_pool_status(request: Request):
    """获取代理池状态"""
    if not _HAS_PROXY_POOL:
        return {"config": {}, "pool": None, "available": False}
    pool = pp.get_pool()
    config = pp.get_config()
    return {
        "config": config.to_dict(),
        "pool": pool.status_dict() if pool and pool._running else None,
        "direct": pp.direct_status(),
        "last_route": pp.get_last_route(),
        "available": True
    }

@app.post("/admin/api/proxy_pool/config")
async def proxy_pool_config(request: Request):
    """更新代理池配置"""
    if not _HAS_PROXY_POOL:
        return {"success": False, "message": "代理池模块未加载（缺少依赖或文件）"}
    
    data = await request.json()
    config = pp.get_config()
    
    allowed_keys = {"singbox_path", "vpn_config_path", "subscription_url", "prefer_direct", "direct_cooldown", "direct_rate_limit", "num_slots", "base_port", "rate_limit", "window"}
    updates = {k: v for k, v in data.items() if k in allowed_keys}
    if updates:
        config.update(updates)
    return {"success": True, "message": "配置已保存", "config": config.to_dict()}

@app.post("/admin/api/proxy_pool/start")
async def proxy_pool_start(request: Request):
    """启动代理池"""
    if not _HAS_PROXY_POOL:
        return {"success": False, "message": "代理池模块未加载（缺少依赖或文件）"}
    
    result = await pp.start_pool()
    return result

@app.post("/admin/api/proxy_pool/stop")
async def proxy_pool_stop(request: Request):
    """停止代理池"""
    if not _HAS_PROXY_POOL:
        return {"success": False, "message": "代理池模块未加载"}
    
    result = await pp.stop_pool()
    return result

@app.post("/admin/api/proxy_pool/load_module")
async def proxy_pool_load_module(request: Request):
    """动态加载/重载代理池模块（部署 proxy_pool.py 后无需重启服务器）"""
    global pp, _HAS_PROXY_POOL
    
    try:
        if _HAS_PROXY_POOL and pp:
            if pp.get_pool() and pp.get_pool()._running:
                return {"success": False, "message": "代理池正在运行中，请先停止再重载模块"}
            importlib.reload(pp)
            _HAS_PROXY_POOL = True
            return {"success": True, "message": "代理池模块已重载"}
        else:
            import proxy_pool as _pp
            pp = _pp
            _HAS_PROXY_POOL = True
            return {"success": True, "message": "代理池模块已加载"}
    except Exception as e:
        return {"success": False, "message": f"加载失败: {str(e)}"}

@app.post("/admin/api/proxy_pool/refresh_subscription")
async def proxy_pool_refresh_sub(request: Request):
    """刷新订阅节点"""
    if not _HAS_PROXY_POOL:
        return {"success": False, "message": "代理池模块未加载"}
    
    result = await pp.refresh_subscription()
    return result

# ===== 管理后台页面 =====
@app.get("/admin", response_class=HTMLResponse)
@app.get("/admin/", response_class=HTMLResponse)
async def admin_page():
    """管理后台页面"""
    html_path = os.path.join(os.path.dirname(__file__), "admin.html")
    if os.path.exists(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            return f.read()
    return "<h1>管理页面未找到</h1>"

# ===== 聊天组件JS =====

@app.get("/chat/widget.js")
async def chat_widget_js():
    """返回聊天组件JS"""
    js_path = os.path.join(os.path.dirname(__file__), "chat_widget.js")
    if os.path.exists(js_path):
        with open(js_path, "r", encoding="utf-8") as f:
            return Response(content=f.read(), media_type="application/javascript")
    return Response(content="// Chat widget not found", media_type="application/javascript")

# ===== 启动 =====
def run_server(host="0.0.0.0", port=8080):
    """启动服务器"""
    print(f"""
╔══════════════════════════════════════════════════════════╗
║           AK代理监控系统 已启动                           ║
╠══════════════════════════════════════════════════════════╣
║  管理后台: http://{host}:{port}/admin                     
║  API文档:  http://{host}:{port}/docs                      
║  WebSocket: ws://{host}:{port}/admin/ws                   
╚══════════════════════════════════════════════════════════╝
    """)
    uvicorn.run(app, host=host, port=port, ws_ping_interval=60, ws_ping_timeout=30)

if __name__ == "__main__":
    run_server()
