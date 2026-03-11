# -*- coding: utf-8 -*-
"""
sing-box 配置管理器
负责：
  1. 根据订阅解析出的节点，生成 sing-box JSON 配置
  2. 将配置写入磁盘
  3. 热重载 sing-box 服务
  4. 持久化当前节点列表 (nodes.json)

每个节点 → 1个 SOCKS5 inbound (本地端口) + 1个 outbound (VPN协议)
"""

import json
import logging
import os
import subprocess
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger("TransparentProxy")

# ===== 路径配置 =====
SINGBOX_DIR = Path.home() / "sing-box"
SINGBOX_CONFIG = SINGBOX_DIR / "config.json"
NODES_FILE = SINGBOX_DIR / "nodes.json"  # 持久化节点列表
SINGBOX_BIN = "sing-box"  # sing-box 二进制 (需在 PATH 中)
SINGBOX_SERVICE = "sing-box"  # systemd 服务名


def ensure_dir():
    SINGBOX_DIR.mkdir(parents=True, exist_ok=True)


# ===== 节点持久化 =====

def load_saved_nodes() -> list[dict]:
    """加载已保存的节点列表"""
    try:
        if NODES_FILE.exists():
            return json.loads(NODES_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning(f"[SingBox] 加载节点列表失败: {e}")
    return []


def save_nodes(nodes: list[dict]):
    """保存节点列表到磁盘"""
    ensure_dir()
    NODES_FILE.write_text(json.dumps(nodes, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"[SingBox] 保存 {len(nodes)} 个节点到 {NODES_FILE}")


# ===== sing-box 配置生成 =====

def _make_outbound(node: dict, tag: str) -> dict:
    """根据节点信息生成 sing-box outbound 配置"""
    raw = node.get("raw", {})
    proto = raw.get("type", node.get("type", "")).lower()
    server = node.get("server", "")
    port = node.get("port", 0)

    if proto in ("ss", "shadowsocks"):
        ob = {
            "type": "shadowsocks",
            "tag": tag,
            "server": server,
            "server_port": int(port),
            "method": raw.get("cipher", "aes-128-gcm"),
            "password": raw.get("password", ""),
        }
        # plugin
        if raw.get("plugin"):
            ob["plugin"] = raw["plugin"]
            if raw.get("plugin-opts"):
                ob["plugin_opts"] = raw["plugin-opts"] if isinstance(raw["plugin-opts"], str) else json.dumps(raw["plugin-opts"])
        if raw.get("udp") is not None:
            ob["udp_over_tcp"] = bool(raw.get("udp"))
        return ob

    elif proto in ("vmess",):
        ob = {
            "type": "vmess",
            "tag": tag,
            "server": server,
            "server_port": int(port),
            "uuid": raw.get("uuid", ""),
            "alter_id": int(raw.get("alterId", 0)),
            "security": raw.get("cipher", "auto"),
        }
        # TLS
        if raw.get("tls"):
            ob["tls"] = {"enabled": True}
            if raw.get("sni"):
                ob["tls"]["server_name"] = raw["sni"]
        # WebSocket
        ws_opts = raw.get("ws-opts", {})
        if raw.get("network") == "ws" or ws_opts:
            ob["transport"] = {
                "type": "ws",
                "path": ws_opts.get("path", "/") if isinstance(ws_opts, dict) else "/",
            }
            if isinstance(ws_opts, dict) and ws_opts.get("headers"):
                ob["transport"]["headers"] = ws_opts["headers"]
        # gRPC
        grpc_opts = raw.get("grpc-opts", {})
        if raw.get("network") == "grpc" or grpc_opts:
            ob["transport"] = {
                "type": "grpc",
                "service_name": grpc_opts.get("grpc-service-name", "") if isinstance(grpc_opts, dict) else "",
            }
        return ob

    elif proto in ("vless",):
        ob = {
            "type": "vless",
            "tag": tag,
            "server": server,
            "server_port": int(port),
            "uuid": raw.get("uuid", ""),
            "flow": raw.get("flow", ""),
        }
        if raw.get("tls"):
            ob["tls"] = {"enabled": True}
            if raw.get("sni"):
                ob["tls"]["server_name"] = raw["sni"]
        return ob

    elif proto in ("trojan",):
        ob = {
            "type": "trojan",
            "tag": tag,
            "server": server,
            "server_port": int(port),
            "password": raw.get("password", ""),
        }
        if raw.get("sni"):
            ob["tls"] = {"enabled": True, "server_name": raw["sni"]}
        else:
            ob["tls"] = {"enabled": True}
        return ob

    elif proto in ("hysteria2", "hy2"):
        ob = {
            "type": "hysteria2",
            "tag": tag,
            "server": server,
            "server_port": int(port),
            "password": raw.get("password", ""),
            "tls": {"enabled": True},
        }
        if raw.get("sni"):
            ob["tls"]["server_name"] = raw["sni"]
        return ob

    else:
        # 未知协议，生成占位 (direct)
        return {
            "type": "direct",
            "tag": tag,
        }


def generate_config(nodes: list[dict], base_port: int = 10001) -> dict:
    """
    根据节点列表生成完整的 sing-box 配置

    每个节点 → 1个 socks inbound (127.0.0.1:base_port+i) + 1个 outbound
    """
    inbounds = []
    outbounds = []
    route_rules = []

    for i, node in enumerate(nodes):
        port = base_port + i
        in_tag = f"socks-in-{i}"
        out_tag = f"proxy-out-{i}"

        # Inbound: local SOCKS5 listener
        inbounds.append({
            "type": "socks",
            "tag": in_tag,
            "listen": "127.0.0.1",
            "listen_port": port,
        })

        # Outbound: VPN protocol
        outbounds.append(_make_outbound(node, out_tag))

        # Route: inbound → outbound
        route_rules.append({
            "inbound": [in_tag],
            "outbound": out_tag,
        })

    # 默认 outbound (direct)
    outbounds.append({"type": "direct", "tag": "direct"})

    config = {
        "log": {
            "level": "warn",
            "timestamp": True,
        },
        "inbounds": inbounds,
        "outbounds": outbounds,
        "route": {
            "rules": route_rules,
            "final": "direct",
        },
    }

    return config


def write_config(nodes: list[dict], base_port: int = 10001) -> str:
    """生成并写入 sing-box 配置文件，返回配置文件路径"""
    ensure_dir()
    config = generate_config(nodes, base_port)
    config_str = json.dumps(config, ensure_ascii=False, indent=2)
    SINGBOX_CONFIG.write_text(config_str, encoding="utf-8")
    logger.info(f"[SingBox] 配置已写入 {SINGBOX_CONFIG} ({len(nodes)} 个节点)")
    return str(SINGBOX_CONFIG)


# ===== sing-box 服务控制 =====

def reload_service() -> dict:
    """热重载 sing-box 服务"""
    try:
        # 先检查配置是否合法
        check = subprocess.run(
            [SINGBOX_BIN, "check", "-c", str(SINGBOX_CONFIG)],
            capture_output=True, text=True, timeout=10
        )
        if check.returncode != 0:
            err = check.stderr.strip() or check.stdout.strip()
            logger.error(f"[SingBox] 配置检查失败: {err}")
            return {"success": False, "message": f"配置检查失败: {err}"}

        # 重启服务
        restart = subprocess.run(
            ["sudo", "systemctl", "restart", SINGBOX_SERVICE],
            capture_output=True, text=True, timeout=15
        )
        if restart.returncode != 0:
            err = restart.stderr.strip() or restart.stdout.strip()
            logger.error(f"[SingBox] 服务重启失败: {err}")
            return {"success": False, "message": f"服务重启失败: {err}"}

        logger.info("[SingBox] 服务热重载成功")
        return {"success": True, "message": "sing-box 热重载成功"}

    except FileNotFoundError:
        msg = f"sing-box 二进制未找到 ({SINGBOX_BIN})，请先安装"
        logger.warning(f"[SingBox] {msg}")
        return {"success": False, "message": msg}
    except subprocess.TimeoutExpired:
        return {"success": False, "message": "操作超时"}
    except Exception as e:
        logger.error(f"[SingBox] 热重载异常: {e}")
        return {"success": False, "message": str(e)}


def start_service() -> dict:
    """启动 sing-box 服务（用于异常退出后远程恢复）"""
    try:
        result = subprocess.run(
            ["sudo", "systemctl", "start", SINGBOX_SERVICE],
            capture_output=True, text=True, timeout=15
        )
        if result.returncode != 0:
            err = result.stderr.strip() or result.stdout.strip()
            logger.error(f"[SingBox] 服务启动失败: {err}")
            return {"success": False, "message": f"服务启动失败: {err}"}
        logger.info("[SingBox] 服务启动成功")
        return {"success": True, "message": "sing-box 启动成功"}
    except FileNotFoundError:
        return {"success": False, "message": "systemctl 未找到"}
    except subprocess.TimeoutExpired:
        return {"success": False, "message": "操作超时"}
    except Exception as e:
        logger.error(f"[SingBox] 启动异常: {e}")
        return {"success": False, "message": str(e)}


def get_service_status() -> dict:
    """获取 sing-box 服务状态"""
    try:
        result = subprocess.run(
            ["systemctl", "is-active", SINGBOX_SERVICE],
            capture_output=True, text=True, timeout=5
        )
        active = result.stdout.strip() == "active"

        # 获取更多信息
        info = subprocess.run(
            ["systemctl", "show", SINGBOX_SERVICE, "--property=ActiveState,SubState,MainPID"],
            capture_output=True, text=True, timeout=5
        )
        props = {}
        for line in info.stdout.strip().split('\n'):
            if '=' in line:
                k, v = line.split('=', 1)
                props[k] = v

        return {
            "installed": True,
            "active": active,
            "state": props.get("ActiveState", "unknown"),
            "sub_state": props.get("SubState", "unknown"),
            "pid": props.get("MainPID", "0"),
            "config_path": str(SINGBOX_CONFIG),
            "config_exists": SINGBOX_CONFIG.exists(),
            "nodes_count": len(load_saved_nodes()),
        }
    except FileNotFoundError:
        return {
            "installed": False,
            "active": False,
            "state": "not-installed",
            "config_path": str(SINGBOX_CONFIG),
            "config_exists": SINGBOX_CONFIG.exists(),
            "nodes_count": len(load_saved_nodes()),
        }
    except Exception as e:
        return {"installed": False, "active": False, "error": str(e)}


# ===== 一键操作 =====

def apply_nodes(nodes: list[dict], base_port: int = 10001) -> dict:
    """
    一键应用节点：保存 → 生成配置 → 写盘 → 重载服务

    Returns:
        {"success": bool, "message": str, "config_path": str, "nodes_count": int}
    """
    try:
        save_nodes(nodes)
        config_path = write_config(nodes, base_port)
        reload_result = reload_service()

        return {
            "success": reload_result["success"],
            "message": reload_result["message"],
            "config_path": config_path,
            "nodes_count": len(nodes),
        }
    except Exception as e:
        logger.error(f"[SingBox] apply_nodes 失败: {e}")
        return {"success": False, "message": str(e)}
