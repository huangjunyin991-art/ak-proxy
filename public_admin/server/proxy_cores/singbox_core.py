# -*- coding: utf-8 -*-
"""Compatibility wrapper around the existing sing-box manager."""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

from .runtime import binary_status, config_dir, ensure_binary_async, ensure_core_dirs, log_dir, resolve_binary

CORE_TYPE = "singbox"
SINGBOX_BIN_NAME = "sing-box"
SINGBOX_BASE_PORT = 10001
SINGBOX_SERVICE = os.environ.get("AK_SINGBOX_SERVICE", "sing-box")

logger = logging.getLogger("TransparentProxy")


def pid_path() -> Path:
    return config_dir(CORE_TYPE) / "sing-box.pid"


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


def _systemd_service_exists() -> bool:
    try:
        result = subprocess.run(
            ["systemctl", "show", SINGBOX_SERVICE, "--property=LoadState"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.returncode == 0 and "LoadState=loaded" in result.stdout
    except Exception:
        return False


def _start_managed(binary: str, config_path: str) -> dict[str, Any]:
    stop_managed_process()
    log_file = (log_dir(CORE_TYPE) / "sing-box.log").open("ab")
    proc = subprocess.Popen(
        [binary, "run", "-c", config_path],
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    pid_path().write_text(str(proc.pid), encoding="utf-8")
    logger.info("[SingBox] started managed process pid=%s", proc.pid)
    return {"success": True, "message": "sing-box managed process started", "pid": proc.pid}


def reload_service(config_path: str) -> dict[str, Any]:
    binary = resolve_binary(CORE_TYPE, SINGBOX_BIN_NAME)
    if not binary:
        return {"success": False, "message": "sing-box binary missing"}

    check = subprocess.run(
        [binary, "check", "-c", config_path],
        capture_output=True,
        text=True,
        timeout=10,
    )
    if check.returncode != 0:
        err = check.stderr.strip() or check.stdout.strip()
        return {"success": False, "message": f"sing-box config check failed: {err}"}

    if _systemd_service_exists():
        stop_managed_process()
        restart = subprocess.run(
            ["sudo", "systemctl", "restart", SINGBOX_SERVICE],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if restart.returncode == 0:
            return {"success": True, "message": "sing-box systemd restarted"}
        err = restart.stderr.strip() or restart.stdout.strip()
        logger.warning("[SingBox] systemd restart failed, fallback to managed process: %s", err)

    return _start_managed(binary, config_path)


async def apply_nodes(nodes: list[dict[str, Any]], base_port: int = SINGBOX_BASE_PORT) -> dict[str, Any]:
    from .. import singbox_manager as sbm

    ensure_core_dirs(CORE_TYPE)
    if not nodes:
        await asyncio.to_thread(stop_managed_process)
        config_path = await asyncio.to_thread(sbm.write_config, [], base_port)
        return {"success": True, "message": "no sing-box nodes", "config_path": config_path, "nodes_count": 0}
    binary = await ensure_binary_async(CORE_TYPE, SINGBOX_BIN_NAME)
    config_path = await asyncio.to_thread(sbm.write_config, nodes, base_port)
    if not binary.get("available"):
        return {
            "success": False,
            "pending_download": bool(binary.get("downloading")),
            "message": "sing-box binary missing, download started",
            "config_path": config_path,
            "nodes_count": len(nodes),
        }
    reload_result = await asyncio.to_thread(reload_service, config_path)
    return {**reload_result, "config_path": config_path, "nodes_count": len(nodes)}


def get_status() -> dict[str, Any]:
    from .. import singbox_manager as sbm

    status = sbm.get_service_status()
    if not isinstance(status, dict):
        status = {}
    managed_pid = _read_pid()
    return {
        "core_type": CORE_TYPE,
        **status,
        "managed_active": bool(managed_pid and _pid_is_running(managed_pid)),
        "managed_pid": str(managed_pid or 0),
        **binary_status(CORE_TYPE, SINGBOX_BIN_NAME),
    }
