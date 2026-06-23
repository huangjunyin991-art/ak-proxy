# -*- coding: utf-8 -*-
"""Mihomo config generation and managed process control."""

from __future__ import annotations

import logging
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

import yaml

from .runtime import binary_status, config_dir, ensure_binary_async, ensure_core_dirs, log_dir, resolve_binary

logger = logging.getLogger("TransparentProxy")

CORE_TYPE = "mihomo"
MIHOMO_BIN_NAME = "mihomo"
MIHOMO_BASE_PORT = int(os.environ.get("AK_MIHOMO_BASE_PORT", "11001"))


def config_path() -> Path:
    return config_dir(CORE_TYPE) / "config.yaml"


def pid_path() -> Path:
    return config_dir(CORE_TYPE) / "mihomo.pid"


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _raw(node: dict[str, Any]) -> dict[str, Any]:
    return node.get("raw") if isinstance(node.get("raw"), dict) else {}


def _node_name(node: dict[str, Any], index: int) -> str:
    return str(node.get("display_name") or node.get("name") or f"mihomo-node-{index + 1}")


def _make_vless_proxy(node: dict[str, Any], index: int) -> dict[str, Any]:
    raw = _raw(node)
    proxy: dict[str, Any] = {
        "name": f"proxy-out-{index}",
        "type": "vless",
        "server": str(node.get("server") or ""),
        "port": int(node.get("port") or 0),
        "uuid": str(raw.get("uuid") or ""),
        "udp": True,
        "network": str(raw.get("network") or "tcp").lower(),
    }
    if raw.get("flow"):
        proxy["flow"] = str(raw.get("flow"))

    tls_enabled = _truthy(raw.get("tls")) or str(raw.get("security") or "").lower() in {"tls", "reality"}
    if tls_enabled:
        proxy["tls"] = True
    server_name = str(
        raw.get("servername")
        or raw.get("server_name")
        or raw.get("sni")
        or raw.get("host")
        or node.get("server")
        or ""
    ).strip()
    if server_name:
        proxy["servername"] = server_name
    if _truthy(raw.get("skip-cert-verify") or raw.get("skip_cert_verify") or node.get("skip_cert_verify")):
        proxy["skip-cert-verify"] = True
    fingerprint = str(raw.get("client-fingerprint") or raw.get("client_fingerprint") or raw.get("fp") or "").strip()
    if fingerprint:
        proxy["client-fingerprint"] = fingerprint

    if proxy["network"] == "xhttp":
        opts = raw.get("xhttp-opts") or raw.get("xhttp_opts") or {}
        if not isinstance(opts, dict):
            opts = {}
        xhttp_opts: dict[str, Any] = {}
        path = str(raw.get("path") or opts.get("path") or "/").strip() or "/"
        xhttp_opts["path"] = path
        mode = str(raw.get("mode") or opts.get("mode") or "").strip()
        if mode:
            xhttp_opts["mode"] = mode
        host = str(raw.get("host") or opts.get("host") or "").strip()
        if host:
            xhttp_opts["headers"] = {"Host": host}
        extra = opts.get("extra") if isinstance(opts.get("extra"), dict) else None
        if extra:
            xhttp_opts.update(extra)
        proxy["xhttp-opts"] = xhttp_opts
    return proxy


def _make_proxy(node: dict[str, Any], index: int) -> dict[str, Any]:
    proto = str((_raw(node).get("type") or node.get("type") or "")).lower()
    if proto == "vless":
        return _make_vless_proxy(node, index)
    raise ValueError(f"mihomo unsupported protocol: {proto or 'unknown'}")


def generate_config(nodes: list[dict[str, Any]], base_port: int = MIHOMO_BASE_PORT) -> dict[str, Any]:
    proxies = []
    listeners = []
    for index, node in enumerate(nodes):
        proxy = _make_proxy(node, index)
        proxies.append(proxy)
        port = int(node.get("local_port") or (base_port + index))
        listeners.append({
            "name": f"socks-in-{index}",
            "type": "socks",
            "listen": "127.0.0.1",
            "port": port,
            "proxy": proxy["name"],
        })

    return {
        "mixed-port": 0,
        "allow-lan": False,
        "mode": "rule",
        "log-level": "warning",
        "ipv6": True,
        "find-process-mode": "off",
        "proxies": proxies,
        "listeners": listeners,
        "rules": ["MATCH,DIRECT"],
    }


def write_config(nodes: list[dict[str, Any]], base_port: int = MIHOMO_BASE_PORT) -> str:
    ensure_core_dirs(CORE_TYPE)
    path = config_path()
    payload = generate_config(nodes, base_port=base_port)
    path.write_text(yaml.safe_dump(payload, allow_unicode=True, sort_keys=False), encoding="utf-8")
    logger.info("[Mihomo] config written to %s (%s nodes)", path, len(nodes))
    return str(path)


def _pid_is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _read_pid() -> int:
    try:
        return int(pid_path().read_text(encoding="utf-8").strip())
    except Exception:
        return 0


def stop_managed_process(timeout: float = 8.0) -> bool:
    pid = _read_pid()
    if not pid or not _pid_is_running(pid):
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception:
        return False
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not _pid_is_running(pid):
            break
        time.sleep(0.2)
    if _pid_is_running(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass
    return True


def reload_service() -> dict[str, Any]:
    binary = resolve_binary(CORE_TYPE, MIHOMO_BIN_NAME)
    if not binary:
        return {"success": False, "message": "mihomo binary missing"}
    path = config_path()
    if not path.exists():
        return {"success": False, "message": "mihomo config missing"}

    check = subprocess.run(
        [binary, "-t", "-f", str(path)],
        capture_output=True,
        text=True,
        timeout=15,
    )
    if check.returncode != 0:
        err = check.stderr.strip() or check.stdout.strip()
        logger.warning("[Mihomo] config check failed: %s", err)
        return {"success": False, "message": f"mihomo config check failed: {err}"}

    stop_managed_process()
    log_path = log_dir(CORE_TYPE) / "mihomo.log"
    log_file = log_path.open("ab")
    proc = subprocess.Popen(
        [binary, "-f", str(path), "-d", str(config_dir(CORE_TYPE))],
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    pid_path().write_text(str(proc.pid), encoding="utf-8")
    logger.info("[Mihomo] started managed process pid=%s", proc.pid)
    return {"success": True, "message": "mihomo started", "pid": proc.pid, "config_path": str(path)}


async def apply_nodes(nodes: list[dict[str, Any]], base_port: int = MIHOMO_BASE_PORT) -> dict[str, Any]:
    ensure_core_dirs(CORE_TYPE)
    if not nodes:
        await _to_thread_stop()
        config = write_config([], base_port)
        return {"success": True, "message": "no mihomo nodes", "config_path": config, "nodes_count": 0}
    binary = await ensure_binary_async(CORE_TYPE, MIHOMO_BIN_NAME)
    config = write_config(nodes, base_port)
    if not binary.get("available"):
        return {
            "success": False,
            "pending_download": bool(binary.get("downloading")),
            "message": "mihomo binary missing, download started",
            "config_path": config,
            "nodes_count": len(nodes),
        }
    result = await _to_thread_reload()
    return {**result, "config_path": config, "nodes_count": len(nodes)}


async def _to_thread_reload() -> dict[str, Any]:
    import asyncio
    return await asyncio.to_thread(reload_service)


async def _to_thread_stop() -> bool:
    import asyncio
    return await asyncio.to_thread(stop_managed_process)


def get_status() -> dict[str, Any]:
    pid = _read_pid()
    status = binary_status(CORE_TYPE, MIHOMO_BIN_NAME)
    return {
        "core_type": CORE_TYPE,
        "installed": bool(status.get("available")),
        "active": bool(pid and _pid_is_running(pid)),
        "pid": str(pid or 0),
        "config_path": str(config_path()),
        "config_exists": config_path().exists(),
        "base_port": MIHOMO_BASE_PORT,
        **status,
    }
