# -*- coding: utf-8 -*-
"""
AK 服务器管理面板 - 科技感交互界面
远程编辑nginx/后端配置文件，控制启停重启，支持热重载
"""

import os
import sys
import subprocess
import secrets
import time
import json
import hashlib
from datetime import datetime
from pathlib import Path
from collections import defaultdict

from fastapi import FastAPI, Request, Form, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware
import uvicorn

sys.path.insert(0, os.path.dirname(__file__))
try:
    from config import DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_MIN_POOL, DB_MAX_POOL
except ImportError:
    DB_HOST, DB_PORT, DB_NAME = "127.0.0.1", 5432, "ak_proxy"
    DB_USER, DB_PASSWORD = "ak_proxy", "ak2026db"
    DB_MIN_POOL, DB_MAX_POOL = 5, 20
import database_pg as db

# ===== 配置 =====
# 密码使用SHA256哈希存储，默认密码: ak-lovejjy1314
# 修改密码: python3 -c "import hashlib;print(hashlib.sha256('新密码'.encode()).hexdigest())"
ADMIN_PASSWORD_HASH = hashlib.sha256("ak-lovejjy1314".encode()).hexdigest()
PANEL_PORT = 9090
SECRET_KEY = secrets.token_hex(32)
BASE_PATH = "/akadmin"  # URL前缀，通过 https://ak2026.vip/akadmin 访问

# 登录安全：失败次数限制
_login_attempts = defaultdict(list)  # ip -> [timestamp, ...]
MAX_LOGIN_ATTEMPTS = 5
LOCKOUT_SECONDS = 60

# 日志配置
LOG_CONFIG = {
    "max_size_bytes": 1 * 1024 * 1024 * 1024,  # 1GB
    "retention_days": 30,
    "check_interval": 3600,  # 每小时检查一次
}
LOG_FILES = {
    "proxy": {"label": "透明代理日志", "path": os.path.expanduser("~/ak-proxy/transparent_proxy/proxy.log"), "sudo": False},
    "nginx_access": {"label": "Nginx 访问日志 (ak2026)", "path": "/var/log/nginx/ak2026_access.log", "sudo": True},
    "nginx_error": {"label": "Nginx 错误日志 (ak2026)", "path": "/var/log/nginx/ak2026_error.log", "sudo": True},
    "nginx_access_default": {"label": "Nginx 默认访问日志", "path": "/var/log/nginx/access.log", "sudo": True},
    "nginx_error_default": {"label": "Nginx 默认错误日志", "path": "/var/log/nginx/error.log", "sudo": True},
    "syslog": {"label": "系统日志", "path": "/var/log/syslog", "sudo": True},
}
_last_log_cleanup = 0

# 可编辑文件 - 分组管理
FILE_GROUPS = {
    "Nginx": {
        "nginx_conf": {"label": "Nginx 配置 (nginx.conf)", "path": "/etc/nginx/nginx.conf", "sudo": True, "lang": "nginx"},
    },
    "透明代理": {
        "proxy_config": {"label": "代理配置 (config.py)", "path": os.path.expanduser("~/ak-proxy/transparent_proxy/config.py"), "sudo": False, "lang": "python"},
        "proxy_server": {"label": "代理主程序 (proxy_server.py)", "path": os.path.expanduser("~/ak-proxy/transparent_proxy/proxy_server.py"), "sudo": False, "lang": "python"},
        "proxy_database": {"label": "数据库模块 (database_pg.py)", "path": os.path.expanduser("~/ak-proxy/transparent_proxy/database_pg.py"), "sudo": False, "lang": "python"},
        "proxy_widget": {"label": "注入脚本 (chat_widget.js)", "path": os.path.expanduser("~/ak-proxy/transparent_proxy/chat_widget.js"), "sudo": False, "lang": "javascript"},
        "proxy_admin_html": {"label": "管理后台 (admin.html)", "path": os.path.expanduser("~/ak-proxy/transparent_proxy/admin.html"), "sudo": False, "lang": "html"},
        "admin_panel": {"label": "管理面板 (admin_panel.py)", "path": os.path.expanduser("~/ak-proxy/transparent_proxy/admin_panel.py"), "sudo": False, "lang": "python"},
    },
}

app = FastAPI(title="AK服务器管理面板")
app.add_middleware(SessionMiddleware, secret_key=SECRET_KEY)


@app.on_event("startup")
async def panel_startup():
    try:
        await db.init_db(
            host=DB_HOST, port=DB_PORT, database=DB_NAME,
            user=DB_USER, password=DB_PASSWORD,
            min_size=3, max_size=10  # 管理面板最多10个同时在线
        )
    except Exception as e:
        print(f"[管理面板] PostgreSQL连接失败: {e}（数据库管理功能不可用）")


@app.on_event("shutdown")
async def panel_shutdown():
    await db.close_db()


def check_auth(request: Request) -> bool:
    return request.session.get("authenticated") == True


def run_cmd(cmd: str, sudo: bool = False) -> dict:
    if sudo:
        cmd = f"sudo {cmd}"
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
        return {"success": result.returncode == 0, "stdout": result.stdout, "stderr": result.stderr}
    except Exception as e:
        return {"success": False, "stdout": "", "stderr": str(e)}


def get_system_info() -> dict:
    uptime = run_cmd("uptime -p")
    mem = run_cmd("free -h | grep Mem | awk '{print $3\"/\"$2}'")
    disk = run_cmd("df -h / | tail -1 | awk '{print $3\"/\"$2\" (\"$5\")\"}'")
    cpu = run_cmd("grep 'cpu ' /proc/stat | awk '{usage=($2+$4)*100/($2+$4+$5); printf \"%.1f\", usage}'")
    load = run_cmd("cut -d' ' -f1-3 /proc/loadavg")
    return {
        "uptime": uptime["stdout"].strip() if uptime["success"] else "N/A",
        "memory": mem["stdout"].strip() if mem["success"] else "N/A",
        "disk": disk["stdout"].strip() if disk["success"] else "N/A",
        "cpu": cpu["stdout"].strip() if cpu["success"] else "N/A",
        "load": load["stdout"].strip() if load["success"] else "N/A",
    }


def get_services_status() -> dict:
    nginx = run_cmd("systemctl is-active nginx")
    proxy = run_cmd("pgrep -f 'python3.*proxy_server.py'")
    panel = run_cmd("pgrep -f 'python3.*admin_panel.py'")
    return {
        "nginx": nginx["stdout"].strip() == "active",
        "proxy": proxy["success"] and proxy["stdout"].strip() != "",
        "panel": panel["success"] and panel["stdout"].strip() != "",
        "nginx_pid": run_cmd("pgrep -o nginx")["stdout"].strip(),
        "proxy_pid": proxy["stdout"].strip().split('\n')[0] if proxy["success"] else "",
    }


def log_cleanup():
    """清理超过30天或超过1GB的日志"""
    global _last_log_cleanup
    now = time.time()
    if now - _last_log_cleanup < LOG_CONFIG["check_interval"]:
        return
    _last_log_cleanup = now
    max_age = LOG_CONFIG["retention_days"] * 86400
    max_size = LOG_CONFIG["max_size_bytes"]
    for key, info in LOG_FILES.items():
        path = info["path"]
        try:
            if info["sudo"]:
                # 检查大小
                r = run_cmd(f"stat -c%s {path} 2>/dev/null", sudo=True)
                if r["success"]:
                    size = int(r["stdout"].strip())
                    if size > max_size:
                        run_cmd(f"truncate -s 0 {path}", sudo=True)
                # 清理rotated日志 (*.log.1, *.log.2.gz 等)
                run_cmd(f"find {os.path.dirname(path)} -name '{os.path.basename(path)}.*' -mtime +{LOG_CONFIG['retention_days']} -delete", sudo=True)
            else:
                if os.path.exists(path):
                    size = os.path.getsize(path)
                    if size > max_size:
                        with open(path, 'w') as f:
                            f.write(f"[日志已清理] 文件超过{max_size//1024//1024//1024}GB上限，已自动清空\n")
                # 清理同目录下的旧rotated日志
                log_dir = os.path.dirname(path)
                base = os.path.basename(path)
                if os.path.isdir(log_dir):
                    for fname in os.listdir(log_dir):
                        if fname.startswith(base + "."):
                            fpath = os.path.join(log_dir, fname)
                            if now - os.path.getmtime(fpath) > max_age:
                                os.remove(fpath)
        except Exception:
            pass


def read_log_tail(key: str, lines: int = 200) -> dict:
    """读取日志文件最后N行"""
    info = LOG_FILES.get(key)
    if not info:
        return {"success": False, "content": "未知日志", "size": "0", "modified": ""}
    path = info["path"]
    try:
        if info["sudo"]:
            r = run_cmd(f"tail -n {lines} {path}", sudo=True)
            content = r["stdout"] if r["success"] else f"读取失败: {r['stderr']}"
            sr = run_cmd(f"stat -c '%s %Y' {path} 2>/dev/null", sudo=True)
        else:
            if os.path.exists(path):
                r = run_cmd(f"tail -n {lines} {path}")
                content = r["stdout"] if r["success"] else ""
            else:
                content = "日志文件不存在"
            sr = run_cmd(f"stat -c '%s %Y' {path} 2>/dev/null")

        size_str = "0B"
        mod_str = ""
        if sr["success"] and sr["stdout"].strip():
            parts = sr["stdout"].strip().split()
            if len(parts) >= 2:
                sz = int(parts[0])
                if sz > 1024*1024*1024:
                    size_str = f"{sz/1024/1024/1024:.1f}GB"
                elif sz > 1024*1024:
                    size_str = f"{sz/1024/1024:.1f}MB"
                elif sz > 1024:
                    size_str = f"{sz/1024:.1f}KB"
                else:
                    size_str = f"{sz}B"
                mod_str = datetime.fromtimestamp(int(parts[1])).strftime("%Y-%m-%d %H:%M:%S")

        return {"success": True, "content": content, "size": size_str, "modified": mod_str}
    except Exception as e:
        return {"success": False, "content": str(e), "size": "0", "modified": ""}


# ===== HTML 模板 =====
def get_panel_html():
    file_tree_items = ""
    for group, files in FILE_GROUPS.items():
        file_tree_items += f'<div class="file-group">{group}</div>'
        for key, info in files.items():
            icon = "📄" if info["lang"] == "nginx" else "🐍"
            file_tree_items += f'<div class="file-item" data-key="{key}" onclick="loadFile(\'{key}\')">{icon} {info["label"]}</div>'

    log_tree_items = '<div class="file-group">日志文件</div>'
    for key, info in LOG_FILES.items():
        log_tree_items += f'<div class="file-item log-item" data-log="{key}" onclick="viewLog(\'{key}\')">📋 {info["label"]}</div>'

    return """<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AK 服务器控制台</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/theme/material-darker.min.css">
<style>
:root{--bg:#0a0e17;--bg2:#0f1420;--bg3:#141c2b;--border:#1e2940;--cyan:#00e5ff;--green:#00ff88;--red:#ff4757;--yellow:#ffd740;--purple:#b388ff;--text:#c8d6e5;--text2:#7f8fa6}
*{margin:0;padding:0;box-sizing:border-box}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes glow{0%,100%{box-shadow:0 0 5px var(--cyan)33}50%{box-shadow:0 0 20px var(--cyan)66}}
@keyframes scanline{0%{top:-100%}100%{top:200%}}
body{background:var(--bg);color:var(--text);font-family:'Consolas','SF Mono','Menlo',monospace;overflow:hidden;height:100vh}

/* Top bar */
.topbar{height:48px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 20px;position:relative;overflow:hidden}
.topbar::after{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--cyan),transparent)}
.topbar .logo{color:var(--cyan);font-size:16px;font-weight:bold;letter-spacing:2px}
.topbar .logo span{color:var(--green)}
.topbar .info{margin-left:auto;display:flex;gap:20px;font-size:12px;color:var(--text2)}
.topbar .info .val{color:var(--cyan)}
.clock{color:var(--yellow);font-size:13px;margin-left:20px;font-weight:bold}

/* Layout */
.container{display:flex;height:calc(100vh - 48px)}
.sidebar{width:280px;background:var(--bg2);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}

/* Sidebar */
.sidebar-section{padding:12px 16px;border-bottom:1px solid var(--border)}
.sidebar-title{font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:2px;margin-bottom:10px}

/* Status indicators */
.svc-row{display:flex;align-items:center;gap:8px;padding:6px 0}
.svc-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.svc-dot.on{background:var(--green);box-shadow:0 0 8px var(--green)}
.svc-dot.off{background:var(--red);animation:pulse 2s infinite}
.svc-name{font-size:13px;flex:1}
.svc-pid{font-size:11px;color:var(--text2)}

/* Control buttons */
.ctrl-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px}
.ctrl-btn{padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:11px;cursor:pointer;text-align:center;transition:all .2s;font-family:inherit}
.ctrl-btn:hover{border-color:var(--cyan);color:var(--cyan);background:var(--cyan)11}
.ctrl-btn.danger:hover{border-color:var(--red);color:var(--red);background:var(--red)11}
.ctrl-btn.success:hover{border-color:var(--green);color:var(--green);background:var(--green)11}
.ctrl-btn:active{transform:scale(.95)}

/* File tree */
.file-group{font-size:11px;color:var(--text2);padding:8px 16px 4px;text-transform:uppercase;letter-spacing:1px}
.file-item{padding:7px 16px 7px 24px;font-size:13px;cursor:pointer;transition:all .15s;border-left:2px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.file-item:hover{background:var(--cyan)11;color:var(--cyan)}
.file-item.active{background:var(--cyan)18;color:var(--cyan);border-left-color:var(--cyan)}

/* Editor area */
.editor-header{height:40px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 16px;gap:10px}
.editor-header .filepath{font-size:12px;color:var(--text2);flex:1;overflow:hidden;text-overflow:ellipsis}
.editor-header .lang-badge{font-size:10px;padding:2px 8px;border-radius:10px;background:var(--purple)22;color:var(--purple);border:1px solid var(--purple)44}
.editor-actions{display:flex;gap:6px}
.editor-actions button{padding:6px 14px;border:1px solid var(--border);border-radius:5px;background:var(--bg);color:var(--text);font-size:12px;cursor:pointer;font-family:inherit;transition:all .15s}
.save-btn{border-color:var(--green)66!important;color:var(--green)!important}
.save-btn:hover{background:var(--green)22!important}
.reload-btn:hover{border-color:var(--cyan);color:var(--cyan)}

/* Checkboxes */
.auto-opts{display:flex;gap:14px;align-items:center;margin-left:8px}
.auto-opts label{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text2);cursor:pointer;user-select:none;transition:color .2s}
.auto-opts label:hover{color:var(--cyan)}
.auto-opts input[type=checkbox]{appearance:none;width:14px;height:14px;border:1px solid var(--border);border-radius:3px;background:var(--bg);cursor:pointer;position:relative;transition:all .2s;flex-shrink:0}
.auto-opts input[type=checkbox]:checked{background:var(--cyan);border-color:var(--cyan)}
.auto-opts input[type=checkbox]:checked::after{content:'\2713';position:absolute;top:-1px;left:2px;font-size:11px;color:var(--bg);font-weight:bold}
.shortcut-hint{font-size:10px;color:var(--text2);opacity:.6;padding:2px 6px;border:1px solid var(--border);border-radius:3px;margin-left:4px}

.editor-wrap{flex:1;overflow:hidden;min-height:0}
.CodeMirror{height:100%!important;font-size:13px!important;line-height:1.6!important}

/* Terminal */
.terminal{height:180px;background:#000;border-top:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.terminal-header{height:28px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 12px;font-size:11px;color:var(--text2)}
.terminal-header .dot{width:6px;height:6px;border-radius:50%;margin-right:4px}
.terminal-body{flex:1;padding:8px 12px;overflow-y:auto;font-size:12px;line-height:1.6;white-space:pre-wrap;color:var(--green)}
.terminal-body.error{color:var(--red)}

/* Toast notification */
.toast{position:fixed;top:60px;right:20px;padding:12px 20px;border-radius:8px;font-size:13px;z-index:999;transform:translateX(120%);transition:transform .3s;max-width:400px}
.toast.show{transform:translateX(0)}
.toast.success{background:var(--green)22;color:var(--green);border:1px solid var(--green)44}
.toast.error{background:var(--red)22;color:var(--red);border:1px solid var(--red)44}

/* Status bar */
.statusbar{height:24px;background:var(--bg2);border-top:1px solid var(--border);display:flex;align-items:center;padding:0 12px;font-size:11px;color:var(--text2);gap:15px}
.statusbar .indicator{display:flex;align-items:center;gap:4px}
.statusbar .dot-mini{width:6px;height:6px;border-radius:50%;display:inline-block}

/* Scrollbar */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--text2)}

/* Log viewer */
.log-viewer{display:none;flex-direction:column;flex:1;overflow:hidden}
.log-viewer.active{display:flex}
.log-viewer-header{height:40px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 16px;gap:10px}
.log-viewer-header .log-title{font-size:13px;color:var(--cyan);flex:1}
.log-viewer-header .log-info{font-size:11px;color:var(--text2)}
.log-viewer-body{flex:1;overflow-y:auto;padding:12px;font-size:12px;line-height:1.6;white-space:pre-wrap;background:#000;color:var(--green);font-family:'Consolas',monospace}
.log-viewer-body .log-line-err{color:var(--red)}
.log-viewer-body .log-line-warn{color:var(--yellow)}
.log-viewer-footer{background:var(--bg2);border-top:1px solid var(--border);padding:6px 12px}
.log-footer-row{display:flex;align-items:center;gap:8px;margin:2px 0}
.log-footer-btn{padding:4px 12px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-size:11px;cursor:pointer;font-family:inherit;transition:all .15s}
.log-footer-btn:hover{border-color:var(--cyan);color:var(--cyan)}
.log-footer-btn.active{border-color:var(--green);color:var(--green);background:var(--green)11}
.log-lines-select{padding:4px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-size:11px;font-family:inherit}
.log-search{padding:4px 10px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font-size:11px;width:180px;font-family:inherit;outline:none}
.log-search:focus{border-color:var(--cyan)}
.editor-panel{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
.editor-panel.hidden{display:none}
.log-item.active{background:var(--yellow)18;color:var(--yellow);border-left-color:var(--yellow)}

/* Mobile */
@media(max-width:768px){.sidebar{width:200px}.terminal{height:120px}}
</style>
</head><body>

<div class="topbar">
<div class="logo">⬡ AK <span>控制台</span></div>
<div class="info">
<span>CPU: <span class="val" id="sys-cpu">-</span>%</span>
<span>MEM: <span class="val" id="sys-mem">-</span></span>
<span>DISK: <span class="val" id="sys-disk">-</span></span>
<span>运行: <span class="val" id="sys-uptime">-</span></span>
</div>
<div class="clock" id="clock"></div>
</div>

<div class="container">
<div class="sidebar">
<div class="sidebar-section">
<div class="sidebar-title">⚡ 服务状态</div>
<div class="svc-row"><div class="svc-dot" id="dot-nginx"></div><span class="svc-name">Nginx</span><span class="svc-pid" id="pid-nginx"></span></div>
<div class="svc-row"><div class="svc-dot" id="dot-proxy"></div><span class="svc-name">透明代理</span><span class="svc-pid" id="pid-proxy"></span></div>

<div class="sidebar-title" style="margin-top:12px">🎛 Nginx 控制</div>
<div class="ctrl-grid">
<button class="ctrl-btn success" onclick="action('nginx_reload')">⟳ 重载</button>
<button class="ctrl-btn" onclick="action('nginx_test')">✓ 测试</button>
<button class="ctrl-btn" onclick="action('nginx_restart')">⟲ 重启</button>
<button class="ctrl-btn danger" onclick="action('nginx_stop')">■ 停止</button>
</div>

<div class="sidebar-title" style="margin-top:12px">🔄 代理控制</div>
<div class="ctrl-grid">
<button class="ctrl-btn success" onclick="action('proxy_start')">▶ 启动</button>
<button class="ctrl-btn" onclick="action('proxy_restart')">⟲ 重启</button>
<button class="ctrl-btn danger" onclick="action('proxy_stop')">■ 停止</button>
<button class="ctrl-btn" onclick="action('proxy_log')">📋 日志</button>
</div>
</div>

<div class="sidebar-section" style="flex:1;overflow-y:auto;padding:0">
<div style="padding:8px 16px 4px"><span class="sidebar-title">📁 配置文件</span></div>
""" + file_tree_items + """
""" + log_tree_items + """
</div>
</div>

<div class="main">
<!-- 编辑器面板 -->
<div class="editor-panel" id="editor-panel">
<div class="editor-header">
<span class="filepath" id="editor-filepath">选择左侧文件开始编辑...</span>
<span class="lang-badge" id="editor-lang" style="display:none"></span>
<div class="auto-opts">
<label title="保存后自动重载Nginx配置"><input type="checkbox" id="chk-nginx-reload"> 保存后重载Nginx</label>
<label title="保存后自动重启代理服务"><input type="checkbox" id="chk-proxy-restart"> 保存后重启代理</label>
</div>
<div class="editor-actions">
<button class="reload-btn" onclick="reloadFile()">↻ 重载</button>
<button class="save-btn" onclick="smartSave()">💾 保存 <span class="shortcut-hint">Ctrl+S</span></button>
</div>
</div>
<div class="editor-wrap">
<textarea id="code-editor"></textarea>
</div>
</div>

<!-- 日志查看器 -->
<div class="log-viewer" id="log-viewer">
<div class="log-viewer-header">
<span class="log-title" id="log-title">📋 日志查看器</span>
<span class="log-info" id="log-info"></span>
<button class="log-footer-btn" onclick="switchToEditor()">← 返回编辑器</button>
</div>
<div class="log-viewer-body" id="log-content"></div>
<div class="log-viewer-footer">
<div class="log-footer-row">
<button class="log-footer-btn" id="btn-auto-refresh" onclick="toggleAutoRefresh()">▶ 实时刷新</button>
<button class="log-footer-btn" onclick="refreshLog()">↻ 刷新</button>
<button class="log-footer-btn" onclick="clearLog()" style="color:var(--red);border-color:var(--red)44">✖ 清空</button>
<select class="log-lines-select" id="log-lines" onchange="refreshLog()">
<option value="200" selected>200行</option>
<option value="500">500行</option>
<option value="1000">1000行</option>
<option value="3000">3000行</option>
<option value="5000">5000行</option>
</select>
<input class="log-search" id="log-search" placeholder="🔍 关键词搜索..." oninput="filterLog()" style="width:150px">
<label class="auto-opts" style="margin:0;gap:3px"><input type="checkbox" id="chk-exact-date" onchange="toggleDateMode()"><span style="font-size:11px">指定日期</span></label>
<span style="font-size:11px;color:var(--text2)" id="date-label">日期:</span>
<input type="date" class="log-search" id="log-date-from" style="width:130px" onchange="filterLog()">
<span style="font-size:11px;color:var(--text2)" id="date-sep">~</span>
<input type="date" class="log-search" id="log-date-to" style="width:130px" onchange="filterLog()">
<span style="margin-left:auto;font-size:11px;color:var(--text2)" id="log-count"></span>
</div>
<div class="log-footer-row">
<span style="font-size:11px;color:var(--text2)">级别:</span>
<label class="auto-opts" style="margin:0;gap:3px"><input type="checkbox" id="lvl-error" checked onchange="filterLog()"><span style="color:var(--red);font-size:11px">ERROR</span></label>
<label class="auto-opts" style="margin:0;gap:3px"><input type="checkbox" id="lvl-warn" checked onchange="filterLog()"><span style="color:var(--yellow);font-size:11px">WARN</span></label>
<label class="auto-opts" style="margin:0;gap:3px"><input type="checkbox" id="lvl-info" checked onchange="filterLog()"><span style="color:var(--green);font-size:11px">INFO</span></label>
<label class="auto-opts" style="margin:0;gap:3px"><input type="checkbox" id="lvl-debug" onchange="filterLog()"><span style="color:var(--text2);font-size:11px">DEBUG</span></label>
<label class="auto-opts" style="margin:0;gap:3px"><input type="checkbox" id="lvl-other" checked onchange="filterLog()"><span style="color:var(--cyan);font-size:11px">其他</span></label>
<button class="log-footer-btn" onclick="resetFilters()" style="margin-left:auto">↺ 重置筛选</button>
</div>
</div>
</div>

<div class="terminal">
<div class="terminal-header">
<div class="dot" style="background:var(--green)"></div>
<div class="dot" style="background:var(--yellow);margin-right:8px"></div>
TERMINAL OUTPUT
</div>
<div class="terminal-body" id="terminal">Ready.</div>
</div>
</div>
</div>

<div class="statusbar">
<span class="indicator"><span class="dot-mini" style="background:var(--green)"></span> Connected</span>
<span id="status-msg">就绪</span>
<span style="margin-left:auto" id="uptime-info"></span>
</div>

<div class="toast" id="toast"></div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/codemirror.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/python/python.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/mode/nginx/nginx.min.js"></script>
<script>
const BASE = '/akadmin';
let editor, currentFile = '', currentLang = '';

// Init CodeMirror
editor = CodeMirror.fromTextArea(document.getElementById('code-editor'), {
    theme: 'material-darker',
    lineNumbers: true,
    lineWrapping: false,
    tabSize: 4,
    indentWithTabs: false,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    scrollbarStyle: 'native'
});

// Ctrl+S shortcut (only in editor, prevent browser save dialog globally)
editor.setOption('extraKeys', {'Ctrl-S': function(cm){smartSave()}, 'Cmd-S': function(cm){smartSave()}});
document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); }
});

// Clock
function updateClock() {
    const d = new Date();
    document.getElementById('clock').textContent = d.toLocaleTimeString('zh-CN', {hour12: false});
}
setInterval(updateClock, 1000);
updateClock();

// Refresh status
async function refreshStatus() {
    try {
        const r = await fetch(BASE + '/api/status');
        const d = await r.json();
        // Services
        setDot('dot-nginx', d.services.nginx);
        setDot('dot-proxy', d.services.proxy);
        document.getElementById('pid-nginx').textContent = d.services.nginx ? 'PID:' + d.services.nginx_pid : '';
        document.getElementById('pid-proxy').textContent = d.services.proxy ? 'PID:' + d.services.proxy_pid : '';
        // System
        document.getElementById('sys-cpu').textContent = d.system.cpu || '-';
        document.getElementById('sys-mem').textContent = d.system.memory || '-';
        document.getElementById('sys-disk').textContent = d.system.disk || '-';
        document.getElementById('sys-uptime').textContent = d.system.uptime || '-';
    } catch(e) {}
}
function setDot(id, on) {
    document.getElementById(id).className = 'svc-dot ' + (on ? 'on' : 'off');
}
setInterval(refreshStatus, 5000);
refreshStatus();

// Load file
async function loadFile(key) {
    if (!key) return;
    currentFile = key;
    // Switch to editor if viewing logs
    document.getElementById('editor-panel').classList.remove('hidden');
    document.getElementById('log-viewer').classList.remove('active');
    stopAutoRefresh();
    document.querySelectorAll('.file-item').forEach(el => {
        el.classList.remove('active');
        if (el.dataset.key === key) el.classList.add('active');
    });
    document.querySelectorAll('.log-item').forEach(el => el.classList.remove('active'));
    termWrite('加载文件: ' + key + '...');
    try {
        const r = await fetch(BASE + '/api/file?name=' + key);
        const d = await r.json();
        editor.setValue(d.content || '');
        editor.setOption('mode', d.lang === 'python' ? 'python' : 'nginx');
        document.getElementById('editor-filepath').textContent = d.path;
        document.getElementById('editor-lang').textContent = d.lang;
        document.getElementById('editor-lang').style.display = '';
        currentLang = d.lang;
        termWrite('文件已加载: ' + d.path, true);
        document.getElementById('status-msg').textContent = '编辑中: ' + d.path;
    } catch(e) {
        termWrite('加载失败: ' + e, false);
    }
}

function reloadFile() { if (currentFile) loadFile(currentFile); }

// Save file
async function saveFile() {
    if (!currentFile) { toast('请先选择文件', 'error'); return; }
    const content = editor.getValue();
    termWrite('保存文件: ' + currentFile + '...');
    try {
        const r = await fetch(BASE + '/api/file', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name: currentFile, content: content})});
        const d = await r.json();
        if (d.success) { toast('文件已保存 ✓', 'success'); termWrite(d.message, true); }
        else { toast('保存失败: ' + d.message, 'error'); termWrite(d.message, false); }
    } catch(e) { toast('保存失败', 'error'); termWrite('错误: ' + e, false); }
}

// Smart save: save + auto reload/restart based on checkboxes
async function smartSave() {
    await saveFile();
    const autoNginx = document.getElementById('chk-nginx-reload').checked;
    const autoProxy = document.getElementById('chk-proxy-restart').checked;
    if (autoNginx && currentFile.startsWith('nginx')) {
        termWrite('\u2192 \u81ea\u52a8\u6d4b\u8bd5Nginx\u914d\u7f6e...', undefined);
        const testR = await fetch(BASE + '/api/action', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'nginx_test'})});
        const testD = await testR.json();
        termWrite((testD.stdout||'') + (testD.stderr||''), testD.success);
        if (testD.success) {
            termWrite('\u2192 \u81ea\u52a8\u91cd\u8f7dNginx...', undefined);
            await action('nginx_reload');
        } else {
            toast('Nginx\u914d\u7f6e\u6709\u8bef\uff0c\u672a\u91cd\u8f7d', 'error');
        }
    }
    if (autoProxy && (currentFile.startsWith('proxy') || currentFile === 'admin_panel') && !currentFile.endsWith('widget') && !currentFile.endsWith('admin_html')) {
        termWrite('\u2192 \u81ea\u52a8\u91cd\u542f\u4ee3\u7406\u670d\u52a1...', undefined);
        await action('proxy_restart');
    }
}

// Action
async function action(act) {
    termWrite('执行: ' + act + '...');
    document.getElementById('status-msg').textContent = '执行: ' + act;
    try {
        const r = await fetch(BASE + '/api/action', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action: act})});
        const d = await r.json();
        const output = (d.stdout || '') + (d.stderr || '');
        termWrite(output || (d.success ? '成功' : '失败'), d.success);
        toast(d.success ? act + ' 成功 ✓' : act + ' 失败 ✗', d.success ? 'success' : 'error');
        document.getElementById('status-msg').textContent = act + (d.success ? ' 成功' : ' 失败');
        setTimeout(refreshStatus, 1000);
    } catch(e) { termWrite('请求失败: ' + e, false); }
}

// Terminal
function termWrite(text, success) {
    const t = document.getElementById('terminal');
    const time = new Date().toLocaleTimeString('zh-CN', {hour12:false});
    const color = success === true ? 'var(--green)' : success === false ? 'var(--red)' : 'var(--text2)';
    t.innerHTML += '<div style="color:' + color + '">[' + time + '] ' + escHtml(text) + '</div>';
    t.scrollTop = t.scrollHeight;
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ===== Log Viewer =====
let currentLog = '', logAutoRefreshTimer = null, logRawContent = '';

function switchToEditor() {
    document.getElementById('editor-panel').classList.remove('hidden');
    document.getElementById('log-viewer').classList.remove('active');
    stopAutoRefresh();
    document.querySelectorAll('.log-item').forEach(el => el.classList.remove('active'));
    document.getElementById('status-msg').textContent = currentFile ? '编辑中' : '就绪';
}

async function viewLog(key) {
    currentLog = key;
    // Switch panels
    document.getElementById('editor-panel').classList.add('hidden');
    document.getElementById('log-viewer').classList.add('active');
    // Highlight sidebar
    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.log-item').forEach(el => el.classList.toggle('active', el.dataset.log === key));
    document.getElementById('status-msg').textContent = '查看日志: ' + key;
    await refreshLog();
}

async function refreshLog() {
    if (!currentLog) return;
    const lines = document.getElementById('log-lines').value;
    try {
        const r = await fetch(BASE + '/api/logs/view?name=' + currentLog + '&lines=' + lines);
        const d = await r.json();
        logRawContent = d.content || '';
        document.getElementById('log-title').textContent = '📋 ' + currentLog;
        document.getElementById('log-info').textContent = '大小: ' + (d.size||'') + '  更新: ' + (d.modified||'');
        renderLogContent(logRawContent);
    } catch(e) {
        document.getElementById('log-content').textContent = '加载失败: ' + e;
    }
}

function getLogLevel(line) {
    const l = line.toLowerCase();
    if (l.includes('[error]') || l.includes('error') || l.includes('fail') || l.includes('exception') || l.includes('critical')) return 'error';
    if (l.includes('[warn') || l.includes('warn') || l.includes('timeout')) return 'warn';
    if (l.includes('[info]') || l.includes('[notice]')) return 'info';
    if (l.includes('[debug]')) return 'debug';
    return 'other';
}

function extractDate(line) {
    // Match common date formats: [2025-02-27 ...] or 27/Feb/2025 or 2025-02-27T...
    const m = line.match(/(\\d{4}-\\d{2}-\\d{2})/);
    if (m) return m[1];
    const m2 = line.match(/(\\d{2})\\/([A-Za-z]+)\\/(\\d{4})/);
    if (m2) {
        const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
        const mon = months[m2[2].toLowerCase().substring(0,3)] || '01';
        return m2[3] + '-' + mon + '-' + m2[1];
    }
    return null;
}

function renderLogContent(content) {
    const search = document.getElementById('log-search').value.toLowerCase();
    const exactDate = document.getElementById('chk-exact-date').checked;
    const dateFrom = document.getElementById('log-date-from').value;
    const dateTo = exactDate ? dateFrom : document.getElementById('log-date-to').value;
    const showError = document.getElementById('lvl-error').checked;
    const showWarn = document.getElementById('lvl-warn').checked;
    const showInfo = document.getElementById('lvl-info').checked;
    const showDebug = document.getElementById('lvl-debug').checked;
    const showOther = document.getElementById('lvl-other').checked;

    const container = document.getElementById('log-content');
    const lines = content.split('\\n');
    let filtered = [];

    for (const line of lines) {
        if (!line.trim()) continue;
        // Keyword filter
        if (search && !line.toLowerCase().includes(search)) continue;
        // Date filter
        if (dateFrom || dateTo) {
            const d = extractDate(line);
            if (d) {
                if (dateFrom && d < dateFrom) continue;
                if (dateTo && d > dateTo) continue;
            }
        }
        // Level filter
        const lvl = getLogLevel(line);
        if (lvl === 'error' && !showError) continue;
        if (lvl === 'warn' && !showWarn) continue;
        if (lvl === 'info' && !showInfo) continue;
        if (lvl === 'debug' && !showDebug) continue;
        if (lvl === 'other' && !showOther) continue;
        filtered.push({line, lvl});
    }

    const hasFilter = search || dateFrom || dateTo || !showError || !showWarn || !showInfo || !showDebug || !showOther;
    document.getElementById('log-count').textContent = (hasFilter ? filtered.length + '/' : '') + lines.length + ' \\u884c';

    let html = '';
    for (const {line, lvl} of filtered) {
        if (lvl === 'error') html += '<div class="log-line-err">' + escHtml(line) + '</div>';
        else if (lvl === 'warn') html += '<div class="log-line-warn">' + escHtml(line) + '</div>';
        else html += escHtml(line) + '\\n';
    }
    container.innerHTML = html;
    container.scrollTop = container.scrollHeight;
}

function filterLog() { renderLogContent(logRawContent); }

function toggleDateMode() {
    const exact = document.getElementById('chk-exact-date').checked;
    document.getElementById('date-sep').style.display = exact ? 'none' : '';
    document.getElementById('log-date-to').style.display = exact ? 'none' : '';
    document.getElementById('date-label').textContent = exact ? '日期:' : '范围:';
    if (exact) {
        document.getElementById('log-date-to').value = '';
    }
    filterLog();
}

function resetFilters() {
    document.getElementById('log-search').value = '';
    document.getElementById('log-date-from').value = '';
    document.getElementById('log-date-to').value = '';
    document.getElementById('chk-exact-date').checked = false;
    document.getElementById('date-sep').style.display = '';
    document.getElementById('log-date-to').style.display = '';
    document.getElementById('date-label').textContent = '\u8303\u56f4:';
    document.getElementById('lvl-error').checked = true;
    document.getElementById('lvl-warn').checked = true;
    document.getElementById('lvl-info').checked = true;
    document.getElementById('lvl-debug').checked = false;
    document.getElementById('lvl-other').checked = true;
    filterLog();
}

function toggleAutoRefresh() {
    if (logAutoRefreshTimer) { stopAutoRefresh(); }
    else { startAutoRefresh(); }
}

function startAutoRefresh() {
    const btn = document.getElementById('btn-auto-refresh');
    btn.classList.add('active');
    btn.textContent = '■ 停止刷新';
    refreshLog();
    logAutoRefreshTimer = setInterval(refreshLog, 2000);
}

function stopAutoRefresh() {
    const btn = document.getElementById('btn-auto-refresh');
    btn.classList.remove('active');
    btn.textContent = '▶ 实时刷新';
    if (logAutoRefreshTimer) { clearInterval(logAutoRefreshTimer); logAutoRefreshTimer = null; }
}

async function clearLog() {
    if (!currentLog) return;
    if (!confirm('确定清空此日志文件？')) return;
    try {
        const r = await fetch(BASE + '/api/logs/clear', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name: currentLog})});
        const d = await r.json();
        toast(d.message, d.success ? 'success' : 'error');
        if (d.success) refreshLog();
    } catch(e) { toast('清空失败', 'error'); }
}

// Toast
function toast(msg, type) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast ' + type + ' show';
    setTimeout(() => t.classList.remove('show'), 3000);
}
</script>
</body></html>"""


# ===== 登录页 =====
LOGIN_HTML = """<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AK 服务器控制台</title>
<style>
:root{--bg:#0a0e17;--bg2:#0f1420;--cyan:#00e5ff;--green:#00ff88;--border:#1e2940;--text:#c8d6e5;--text2:#7f8fa6}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);color:var(--text);font-family:'Consolas','SF Mono',monospace;display:flex;justify-content:center;align-items:center;min-height:100vh;overflow:hidden}
@keyframes gridMove{0%{background-position:0 0}100%{background-position:50px 50px}}
@keyframes breathe{0%,100%{opacity:.6;box-shadow:0 0 30px rgba(0,229,255,.1)}50%{opacity:1;box-shadow:0 0 60px rgba(0,229,255,.25)}}
@keyframes scanline{0%{top:-2px}100%{top:calc(100% + 2px)}}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(30,41,64,.15) 1px,transparent 1px),linear-gradient(90deg,rgba(30,41,64,.15) 1px,transparent 1px);background-size:50px 50px;animation:gridMove 4s linear infinite;pointer-events:none}
.login{background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:48px 40px;width:400px;text-align:center;position:relative;z-index:1;animation:breathe 4s ease-in-out infinite}
.login::before{content:'';position:absolute;top:-1px;left:15%;right:15%;height:2px;background:linear-gradient(90deg,transparent,var(--cyan),transparent);border-radius:2px}
.login::after{content:'';position:absolute;width:2px;height:20px;background:var(--cyan);top:30%;left:-1px;animation:scanline 3s linear infinite;opacity:.5}
.logo{font-size:26px;font-weight:bold;color:var(--cyan);letter-spacing:3px;margin-bottom:6px}
.logo span{color:var(--green)}
.sub{color:var(--text2);font-size:12px;margin-bottom:32px;letter-spacing:2px}
.input-group{position:relative;margin-bottom:20px}
.input-group label{display:block;text-align:left;font-size:11px;color:var(--cyan);margin-bottom:6px;letter-spacing:1px;text-transform:uppercase}
input{width:100%;padding:14px 16px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font-size:15px;font-family:inherit;outline:none;transition:all .3s;letter-spacing:2px}
input:focus{border-color:var(--cyan);box-shadow:0 0 0 3px rgba(0,229,255,.1),inset 0 0 20px rgba(0,229,255,.03)}
input::placeholder{color:#3d5066;letter-spacing:1px}
button{width:100%;padding:14px;margin-top:4px;border:1px solid var(--cyan);border-radius:8px;background:transparent;color:var(--cyan);font-size:14px;font-weight:bold;cursor:pointer;font-family:inherit;letter-spacing:3px;transition:all .3s;text-transform:uppercase}
button:hover{background:rgba(0,229,255,.1);box-shadow:0 0 20px rgba(0,229,255,.2)}
button:active{transform:scale(.98)}
.status{display:flex;justify-content:center;gap:16px;margin-top:24px;font-size:11px;color:var(--text2)}
.status .dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);margin-right:4px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.err{color:#ff4757;font-size:12px;margin-top:14px;padding:10px;background:rgba(255,71,87,.1);border:1px solid rgba(255,71,87,.3);border-radius:6px}
</style></head><body>
<div class="login">
<div class="logo">AK <span>控制台</span></div>
<div class="sub">服 务 器 管 理 系 统</div>
<form method="POST" action="/akadmin/login">
<div class="input-group">
<label>管理密码</label>
<input type="password" name="password" placeholder="输入密码以验证身份" autofocus autocomplete="off">
</div>
<button type="submit">安 全 登 录</button>
</form>
<div class="status"><span><span class="dot"></span>系统运行中</span><span>AK2026</span></div>
</div></body></html>"""


@app.get(f"{BASE_PATH}/login", response_class=HTMLResponse)
async def login_page():
    return LOGIN_HTML


@app.post(f"{BASE_PATH}/login")
async def do_login(request: Request, password: str = Form(...)):
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    # 清理过期记录
    _login_attempts[client_ip] = [t for t in _login_attempts[client_ip] if now - t < LOCKOUT_SECONDS]
    # 检查是否被锁定
    if len(_login_attempts[client_ip]) >= MAX_LOGIN_ATTEMPTS:
        remain = int(LOCKOUT_SECONDS - (now - _login_attempts[client_ip][0]))
        return HTMLResponse(LOGIN_HTML.replace('</form>', f'<div class="err">登录尝试次数过多，请{remain}秒后重试</div></form>'))
    # 验证密码（哈希比较）
    if hashlib.sha256(password.encode()).hexdigest() == ADMIN_PASSWORD_HASH:
        request.session["authenticated"] = True
        _login_attempts.pop(client_ip, None)
        return RedirectResponse(url=f"{BASE_PATH}/panel", status_code=303)
    _login_attempts[client_ip].append(now)
    attempts_left = MAX_LOGIN_ATTEMPTS - len(_login_attempts[client_ip])
    return HTMLResponse(LOGIN_HTML.replace('</form>', f'<div class="err">密码错误，还剩{attempts_left}次尝试机会</div></form>'))


@app.get(f"{BASE_PATH}/panel", response_class=HTMLResponse)
async def panel(request: Request):
    if not check_auth(request):
        return RedirectResponse(url=f"{BASE_PATH}/login")
    return get_panel_html()


# ===== API =====
@app.get(f"{BASE_PATH}/api/status")
async def api_status(request: Request):
    if not check_auth(request):
        raise HTTPException(status_code=401)
    return {"services": get_services_status(), "system": get_system_info()}


@app.get(f"{BASE_PATH}/api/file")
async def get_file(request: Request, name: str):
    if not check_auth(request):
        raise HTTPException(status_code=401)
    # find file info
    info = None
    for group in FILE_GROUPS.values():
        if name in group:
            info = group[name]
            break
    if not info:
        return JSONResponse({"error": "文件不存在"}, status_code=400)
    try:
        if info["sudo"]:
            result = run_cmd(f"cat {info['path']}", sudo=True)
            content = result["stdout"] if result["success"] else f"读取失败: {result['stderr']}"
        else:
            with open(info["path"], 'r', encoding='utf-8') as f:
                content = f.read()
        return {"content": content, "path": info["path"], "lang": info["lang"]}
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@app.post(f"{BASE_PATH}/api/file")
async def save_file(request: Request):
    if not check_auth(request):
        raise HTTPException(status_code=401)
    data = await request.json()
    name = data.get("name")
    content = data.get("content", "")
    info = None
    for group in FILE_GROUPS.values():
        if name in group:
            info = group[name]
            break
    if not info:
        return {"success": False, "message": "文件不存在"}
    is_nginx = name.startswith("nginx_")
    backup_path = info['path'] + '.bak' if is_nginx else None
    try:
        if is_nginx:
            run_cmd(f"cp {info['path']} {backup_path}", sudo=True)
        if info["sudo"]:
            tmp = "/tmp/_panel_edit_tmp"
            with open(tmp, 'w', encoding='utf-8') as f:
                f.write(content)
            result = run_cmd(f"cp {tmp} {info['path']}", sudo=True)
            if not result["success"]:
                if is_nginx and backup_path:
                    run_cmd(f"cp {backup_path} {info['path']}", sudo=True)
                return {"success": False, "message": f"写入失败: {result['stderr']}"}
        else:
            with open(info["path"], 'w', encoding='utf-8') as f:
                f.write(content)
        if is_nginx:
            test = run_cmd("nginx -t", sudo=True)
            if not test["success"]:
                run_cmd(f"cp {backup_path} {info['path']}", sudo=True)
                return {"success": False, "message": f"Nginx配置测试失败，已自动回滚:\n{test['stderr']}"}
        return {"success": True, "message": f"已保存: {info['path']}"}
    except Exception as e:
        if is_nginx and backup_path:
            run_cmd(f"cp {backup_path} {info['path']}", sudo=True)
        return {"success": False, "message": str(e)}


def _proxy_kill():
    """杀掉proxy_server进程（用pgrep精确匹配，避免误杀）"""
    r = run_cmd("pgrep -f 'python3.*proxy_server\\.py'")
    if r["success"] and r["stdout"].strip():
        pids = r["stdout"].strip().split('\n')
        for pid in pids:
            run_cmd(f"kill {pid.strip()}", sudo=True)
        return True, f"已停止 PID: {','.join(pids)}"
    return False, "未找到运行中的proxy_server"

def _proxy_start():
    """启动proxy_server，等待几秒验证是否成功"""
    home = os.path.expanduser("~")
    cwd = f"{home}/ak-proxy/transparent_proxy"
    python = f"{home}/ak-proxy/venv/bin/python3"
    log = "/tmp/proxy_server.log"
    proc = subprocess.Popen(
        [python, "proxy_server.py"],
        cwd=cwd, stdout=open(log, 'w'), stderr=subprocess.STDOUT,
        start_new_session=True
    )
    # 等待3秒检查进程是否存活
    time.sleep(3)
    ret = proc.poll()
    if ret is not None:
        # 进程已退出，读取错误日志
        err_msg = ""
        try:
            with open(log, 'r') as f:
                err_msg = f.read()[-2000:]  # 最后2000字符
        except Exception:
            pass
        return False, f"启动失败 (退出码: {ret})\n{err_msg}"
    return True, f"已启动 PID: {proc.pid}"

@app.post(f"{BASE_PATH}/api/action")
async def do_action(request: Request):
    if not check_auth(request):
        raise HTTPException(status_code=401)
    data = await request.json()
    act = data.get("action")

    # proxy操作用Python处理，避免pkill自杀问题
    if act == "proxy_stop":
        ok, msg = _proxy_kill()
        return {"success": ok, "stdout": msg, "stderr": ""}
    elif act == "proxy_start":
        ok, msg = _proxy_start()
        return {"success": ok, "stdout": msg, "stderr": ""}
    elif act == "proxy_restart":
        _proxy_kill()
        time.sleep(2)
        ok, msg = _proxy_start()
        return {"success": ok, "stdout": msg, "stderr": ""}

    home = os.path.expanduser("~")
    actions = {
        "nginx_test": ("nginx -t", True),
        "nginx_reload": ("systemctl reload nginx", True),
        "nginx_restart": ("systemctl restart nginx", True),
        "nginx_stop": ("systemctl stop nginx", True),
        "proxy_log": (f"tail -20 {home}/ak-proxy/transparent_proxy/proxy.log 2>/dev/null || echo '暂无日志'", False),
    }

    if act not in actions:
        return {"success": False, "stdout": "", "stderr": "未知操作: " + str(act)}

    cmd, sudo = actions[act]
    result = run_cmd(cmd, sudo=sudo)
    return result


@app.get(f"{BASE_PATH}/api/logs/list")
async def api_logs_list(request: Request):
    if not check_auth(request):
        raise HTTPException(status_code=401)
    log_cleanup()
    result = {}
    for key, info in LOG_FILES.items():
        try:
            if info["sudo"]:
                sr = run_cmd(f"stat -c '%s' {info['path']} 2>/dev/null", sudo=True)
                size = int(sr["stdout"].strip()) if sr["success"] and sr["stdout"].strip() else 0
            else:
                size = os.path.getsize(info["path"]) if os.path.exists(info["path"]) else 0
            if size > 1024*1024*1024:
                size_str = f"{size/1024/1024/1024:.1f}GB"
            elif size > 1024*1024:
                size_str = f"{size/1024/1024:.1f}MB"
            elif size > 1024:
                size_str = f"{size/1024:.1f}KB"
            else:
                size_str = f"{size}B"
            result[key] = {"label": info["label"], "path": info["path"], "size": size_str, "exists": size > 0}
        except Exception:
            result[key] = {"label": info["label"], "path": info["path"], "size": "N/A", "exists": False}
    return result


@app.get(f"{BASE_PATH}/api/logs/view")
async def api_logs_view(request: Request, name: str, lines: int = 200):
    if not check_auth(request):
        raise HTTPException(status_code=401)
    if lines > 5000:
        lines = 5000
    return read_log_tail(name, lines)


@app.post(f"{BASE_PATH}/api/logs/clear")
async def api_logs_clear(request: Request):
    if not check_auth(request):
        raise HTTPException(status_code=401)
    data = await request.json()
    name = data.get("name")
    info = LOG_FILES.get(name)
    if not info:
        return {"success": False, "message": "未知日志"}
    try:
        if info["sudo"]:
            r = run_cmd(f"truncate -s 0 {info['path']}", sudo=True)
            return {"success": r["success"], "message": "已清空" if r["success"] else r["stderr"]}
        else:
            with open(info["path"], 'w') as f:
                f.write("")
            return {"success": True, "message": "已清空"}
    except Exception as e:
        return {"success": False, "message": str(e)}


@app.get(f"{BASE_PATH}/api/db/size")
async def api_db_size(request: Request):
    """查看数据库各表存储占用"""
    if not check_auth(request):
        raise HTTPException(status_code=401)
    try:
        size_info = await db.get_db_size()
        row_counts = await db.get_table_row_counts()
        for t in size_info.get('tables', []):
            t['row_count_exact'] = row_counts.get(t['table_name'], 0)
        return {"success": True, "data": size_info}
    except Exception as e:
        return {"success": False, "message": f"查询失败: {e}"}


@app.post(f"{BASE_PATH}/api/db/delete")
async def api_db_delete(request: Request):
    """按日期删除指定表数据"""
    if not check_auth(request):
        raise HTTPException(status_code=401)
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


@app.get(f"{BASE_PATH}/api/db/stats")
async def api_db_stats(request: Request):
    """获取数据库统计摘要 + 连接池状态"""
    if not check_auth(request):
        raise HTTPException(status_code=401)
    try:
        summary = await db.get_stats_summary()
        row_counts = await db.get_table_row_counts()
        pool_info = db.get_pool_info()
        return {"success": True, "summary": summary, "row_counts": row_counts, "pool": pool_info}
    except Exception as e:
        return {"success": False, "message": f"查询失败: {e}"}


@app.get(f"{BASE_PATH}")
@app.get(f"{BASE_PATH}/")
async def root(request: Request):
    if check_auth(request):
        return RedirectResponse(url=f"{BASE_PATH}/panel")
    return RedirectResponse(url=f"{BASE_PATH}/login")


if __name__ == "__main__":
    print("=" * 56)
    print("  ⬡ AK 控制台")
    print(f"  地址: http://0.0.0.0:{PANEL_PORT}")
    print(f"  密码: {ADMIN_PASSWORD_HASH[:8]}...")
    print("=" * 56)
    uvicorn.run(app, host="0.0.0.0", port=PANEL_PORT, log_level="warning")
