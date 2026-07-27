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
from .rolling import (
    StagedCore,
    clean_process_output,
    generation_config_path,
    promote_staged_config,
    restore_previous_config,
    stop_process,
    wait_for_tcp_listener,
)

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


def _normalize_path_text(value: str) -> str:
    if not str(value or "").strip():
        return ""
    try:
        return str(Path(value).resolve())
    except Exception:
        return str(value or "")


def _process_uses_config(pid: int, config_path: str) -> bool:
    if not str(config_path or "").strip():
        return False
    cmdline_path = Path("/proc") / str(pid) / "cmdline"
    try:
        raw = cmdline_path.read_bytes().replace(b"\x00", b" ").decode("utf-8", "ignore")
    except Exception:
        return False
    if "sing-box" not in raw:
        return False
    target = _normalize_path_text(config_path)
    return str(config_path) in raw or target in raw


def _find_managed_processes(config_path: str) -> list[int]:
    if not str(config_path or "").strip():
        return []
    try:
        result = subprocess.run(
            ["pgrep", "-f", "sing-box"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return []
    pids: list[int] = []
    for line in result.stdout.splitlines():
        try:
            pid = int(line.strip())
        except Exception:
            continue
        if pid == os.getpid() or not _pid_is_running(pid):
            continue
        if _process_uses_config(pid, config_path):
            pids.append(pid)
    return pids


def _terminate_pid(pid: int, timeout: float = 8.0) -> bool:
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


def stop_managed_process(timeout: float = 8.0) -> bool:
    pid = _read_pid()
    return _terminate_pid(pid, timeout=timeout)


def stop_generated_config_processes(config_path: str, timeout: float = 8.0) -> int:
    stopped = 0
    seen = set()
    pid = _read_pid()
    if pid:
        seen.add(pid)
        if _terminate_pid(pid, timeout=timeout):
            stopped += 1
    for proc_pid in _find_managed_processes(config_path):
        if proc_pid in seen:
            continue
        if _terminate_pid(proc_pid, timeout=timeout):
            stopped += 1
    return stopped


def _tail_log(max_chars: int = 4000) -> str:
    path = log_dir(CORE_TYPE) / "sing-box.log"
    try:
        data = path.read_bytes()
    except Exception:
        return ""
    return data[-max_chars:].decode("utf-8", "replace").strip()


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


def _systemd_exec_start() -> str:
    try:
        result = subprocess.run(
            ["systemctl", "show", SINGBOX_SERVICE, "--property=ExecStart", "--value"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return ""


def _systemd_uses_config(config_path: str) -> bool:
    exec_start = _systemd_exec_start()
    if not exec_start:
        return False
    target = _normalize_path_text(config_path)
    return str(config_path) in exec_start or target in exec_start


def _stop_systemd_service() -> bool:
    try:
        result = subprocess.run(
            ["sudo", "systemctl", "stop", SINGBOX_SERVICE],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            err = result.stderr.strip() or result.stdout.strip()
            logger.warning("[SingBox] systemd stop failed before managed start: %s", err)
            return False
        return True
    except Exception as exc:
        logger.warning("[SingBox] systemd stop failed before managed start: %s", exc)
        return False


def _start_managed(binary: str, config_path: str) -> dict[str, Any]:
    stopped = stop_generated_config_processes(config_path)
    if stopped:
        logger.info("[SingBox] stopped %s existing generated-config process(es)", stopped)
    log_file = (log_dir(CORE_TYPE) / "sing-box.log").open("ab")
    proc = subprocess.Popen(
        [binary, "run", "-c", config_path],
        stdout=log_file,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    pid_path().write_text(str(proc.pid), encoding="utf-8")
    time.sleep(0.5)
    if proc.poll() is not None:
        log_tail = _tail_log()
        message = "sing-box 启动后立即退出"
        if "address already in use" in log_tail:
            message = "sing-box 启动失败：本地端口已被占用"
        return {"success": False, "message": message, "pid": proc.pid, "log_tail": log_tail}
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

    systemd_exists = _systemd_service_exists()
    if systemd_exists and _systemd_uses_config(config_path):
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
    elif systemd_exists:
        logger.warning(
            "[SingBox] systemd service does not use generated config %s, switching to managed process",
            config_path,
        )
        _stop_systemd_service()

    return _start_managed(binary, config_path)


def _systemd_is_active() -> bool:
    if not _systemd_service_exists():
        return False
    try:
        result = subprocess.run(
            ["systemctl", "is-active", SINGBOX_SERVICE],
            capture_output=True,
            text=True,
            timeout=5,
        )
        return result.returncode == 0 and result.stdout.strip() == "active"
    except Exception:
        return False


def _stage_nodes_sync(nodes: list[dict[str, Any]], base_port: int, binary: str | None) -> StagedCore:
    from .. import singbox_manager as sbm

    active_path = sbm.SINGBOX_CONFIG
    previous_config = active_path.read_bytes() if active_path.exists() else None
    stage_path = generation_config_path(CORE_TYPE, ".json")
    sbm.write_config(nodes, base_port, target_path=stage_path)
    stage = StagedCore(
        core_type=CORE_TYPE,
        nodes_count=len(nodes),
        base_port=base_port,
        staging_config_path=stage_path,
        active_config_path=active_path,
        previous_pid=_read_pid(),
        previous_config=previous_config,
        previous_systemd_active=_systemd_is_active(),
    )
    if not nodes:
        return stage
    if not binary:
        raise RuntimeError("sing-box binary missing")

    check = subprocess.run(
        [binary, "check", "-c", str(stage_path)],
        capture_output=True,
        text=True,
        timeout=10,
    )
    if check.returncode != 0:
        raise RuntimeError(check.stderr.strip() or check.stdout.strip() or "sing-box config check failed")

    candidate_log = log_dir(CORE_TYPE) / f"sing-box-candidate-{stage_path.stem}.log"
    with candidate_log.open("ab") as log_file:
        proc = subprocess.Popen(
            [binary, "run", "-c", str(stage_path)],
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    time.sleep(0.4)
    if proc.poll() is not None:
        tail = candidate_log.read_bytes()[-2000:].decode("utf-8", "replace") if candidate_log.exists() else ""
        clean_tail = clean_process_output(tail)
        if "address already in use" in clean_tail.lower():
            raise RuntimeError(f"sing-box 候选端口段已被占用（起始端口 {base_port}）")
        raise RuntimeError(f"sing-box 候选实例启动失败：{clean_tail or '未返回错误信息'}")
    probe_port = int(nodes[0].get("local_port") or base_port)
    if not wait_for_tcp_listener(probe_port):
        stop_process(proc.pid)
        raise RuntimeError(f"sing-box candidate listener not ready on 127.0.0.1:{probe_port}")
    stage.candidate_pid = proc.pid
    return stage


async def stage_nodes(nodes: list[dict[str, Any]], base_port: int) -> dict[str, Any]:
    ensure_core_dirs(CORE_TYPE)
    binary_path: str | None = None
    if nodes:
        binary = await ensure_binary_async(CORE_TYPE, SINGBOX_BIN_NAME)
        if not binary.get("available"):
            return {
                "success": False,
                "pending_download": bool(binary.get("downloading")),
                "message": "sing-box binary missing, download started",
                "nodes_count": len(nodes),
            }
        binary_path = str(binary.get("path") or "")
    try:
        stage = await asyncio.to_thread(_stage_nodes_sync, nodes, base_port, binary_path)
        return {
            "success": True,
            "message": "sing-box candidate ready" if nodes else "sing-box empty generation ready",
            "nodes_count": len(nodes),
            "stage": stage,
        }
    except Exception as exc:
        logger.warning("[SingBox] candidate stage failed: %s", exc)
        return {"success": False, "message": str(exc), "nodes_count": len(nodes)}


def promote_stage(stage: StagedCore) -> None:
    promote_staged_config(stage)
    if stage.candidate_pid:
        pid_path().write_text(str(stage.candidate_pid), encoding="utf-8")
    else:
        try:
            pid_path().unlink()
        except FileNotFoundError:
            pass


def discard_stage(stage: StagedCore) -> None:
    was_promoted = stage.promoted
    if stage.candidate_pid:
        stop_process(stage.candidate_pid)
    restore_previous_config(stage)
    if stage.previous_pid:
        pid_path().write_text(str(stage.previous_pid), encoding="utf-8")
    elif was_promoted:
        try:
            pid_path().unlink()
        except FileNotFoundError:
            pass


def retire_stage_previous(stage: StagedCore) -> None:
    if stage.previous_systemd_active:
        _stop_systemd_service()
    if stage.previous_pid and stage.previous_pid != stage.candidate_pid:
        stop_process(stage.previous_pid)


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
    managed_active = bool(managed_pid and _pid_is_running(managed_pid))
    systemd_active = bool(status.get("active"))
    generated_config_pids = _find_managed_processes(str(status.get("config_path") or ""))
    generated_pid = generated_config_pids[0] if generated_config_pids else 0
    if not managed_active and generated_pid:
        managed_pid = generated_pid
        managed_active = True
        try:
            pid_path().write_text(str(generated_pid), encoding="utf-8")
        except Exception:
            pass
    if managed_active:
        status["active"] = True
        status["state"] = "active"
        status["sub_state"] = "managed"
        status["pid"] = str(managed_pid)
    return {
        "core_type": CORE_TYPE,
        **status,
        "systemd_active": systemd_active,
        "managed_active": managed_active,
        "managed_pid": str(managed_pid or 0),
        "generated_config_pids": [str(pid) for pid in generated_config_pids],
        "run_mode": "managed" if managed_active else ("systemd" if systemd_active else "stopped"),
        "last_log_tail": _tail_log(2000),
        **binary_status(CORE_TYPE, SINGBOX_BIN_NAME),
    }
