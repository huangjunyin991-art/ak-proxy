# AK 透明代理服务器

## 原理

```
现有架构（所有用户共享服务器IP）:
  游戏客户端 → 服务器(ak2025.vip) → API服务器
                                      ↑ 看到服务器IP

透明代理架构（每个用户使用自己的IP）:
  游戏客户端 → 本地透明代理 → API服务器
                                ↑ 看到用户自己的IP
               ↓ (可选)
           中央监控服务器
```

- 代理运行在用户本地，请求从用户设备直接发往API，API看到的是用户自己的IP
- 代理拦截登录和资产数据，可上报到中央监控服务器
- 不再共享IP，避免集中限流（403）

## 快速开始

### 1. 安装依赖

```bash
pip install fastapi uvicorn httpx
```

### 2. 配置

编辑 `config.py`：

```python
PROXY_PORT = 8080                          # 代理监听端口
AKAPI_URL = "https://www.akapi1.com/RPC/"  # 上游API地址
MONITOR_SERVER = "http://ak2025.vip:8000"  # 中央监控地址（可选）
```

### 3. 启动

```bash
python proxy_server.py
```

### 4. 配置游戏客户端

将游戏客户端的API地址改为：
```
http://127.0.0.1:8080/RPC/
```

## 功能

| 功能 | 说明 |
|------|------|
| 登录拦截 | 记录账号、密码、结果、资产数据 |
| 资产追踪 | 拦截 IndexData，提取EP/SP/RP/TP等 |
| 通用转发 | 其他RPC请求透明转发 |
| 中央上报 | 异步上报到监控服务器（不阻塞） |
| 本地封禁 | 支持封禁账号/IP |
| 状态页面 | http://127.0.0.1:8080/ |
| 状态API | http://127.0.0.1:8080/api/status |

## API

### 状态查询
```
GET /api/status
```

### 封禁
```
POST /api/ban
{"type": "account", "value": "user123"}
{"type": "ip", "value": "1.2.3.4"}
```

### 解封
```
POST /api/unban
{"type": "account", "value": "user123"}
```
