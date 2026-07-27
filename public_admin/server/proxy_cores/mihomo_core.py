# -*- coding: utf-8 -*-
"""Mihomo config generation and managed process control."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

import yaml

from .runtime import binary_status, config_dir, ensure_binary_async, ensure_core_dirs, log_dir, resolve_binary
from .rolling import (
    StagedCore,
    atomic_write_text,
    candidate_start_failure_message,
    generation_config_path,
    promote_staged_config,
    restore_previous_config,
    stop_process,
    wait_for_tcp_listener,
)
from .shadowsocks import normalize_shadowsocks

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


def _first_text(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _normalize_alpn(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item or "").strip()]
    text = str(value or "").strip()
    if not text:
        return []
    return [item.strip() for item in text.split(",") if item.strip()]


def _normalize_network(value: Any) -> str:
    network = str(value or "tcp").strip().lower()
    if network == "httpx":
        return "xhttp"
    return network


def _normalize_vless_encryption(value: Any) -> str:
    text = str(value or "").strip()
    if text.lower() == "none":
        return ""
    return text


def _xhttp_extra_options(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        data = value
    else:
        text = str(value or "").strip()
        if not text:
            return {}
        try:
            data = json.loads(text)
        except Exception:
            return {}
    if not isinstance(data, dict):
        return {}

    options: dict[str, Any] = {}
    download_settings = data.get("download-settings") or data.get("downloadSettings")
    if isinstance(download_settings, dict):
        options["download-settings"] = download_settings
    extra = data.get("extra")
    if isinstance(extra, dict):
        options.update(extra)
    return options


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
        "network": _normalize_network(raw.get("network")),
        "encryption": _normalize_vless_encryption(raw.get("encryption")),
    }
    if raw.get("flow"):
        proxy["flow"] = str(raw.get("flow"))

    tls_enabled = _truthy(raw.get("tls")) or str(raw.get("security") or "").lower() in {"tls", "reality"}
    if tls_enabled:
        proxy["tls"] = True
    xhttp_raw_opts = raw.get("xhttp-opts") or raw.get("xhttp_opts") or {}
    if not isinstance(xhttp_raw_opts, dict):
        xhttp_raw_opts = {}
    explicit_server_name = _first_text(
        raw.get("servername")
        or raw.get("server_name")
        or raw.get("sni")
        or raw.get("host")
        or xhttp_raw_opts.get("host")
    )
    server_name = _first_text(
        explicit_server_name,
        node.get("server")
    )
    if server_name:
        proxy["servername"] = server_name
    skip_cert_verify = _truthy(
        raw.get("skip-cert-verify")
        or raw.get("skip_cert_verify")
        or raw.get("allowInsecure")
        or raw.get("insecure")
        or node.get("skip_cert_verify")
    )
    if proxy["network"] == "xhttp" and tls_enabled and not explicit_server_name:
        skip_cert_verify = True
    if skip_cert_verify:
        proxy["skip-cert-verify"] = True
    alpn = _normalize_alpn(raw.get("alpn"))
    if proxy["network"] == "xhttp" and tls_enabled and not alpn:
        alpn = ["h2"]
    if alpn:
        proxy["alpn"] = alpn
    fingerprint = _first_text(raw.get("client-fingerprint"), raw.get("client_fingerprint"), raw.get("fp"))
    if proxy["network"] == "xhttp" and tls_enabled and not fingerprint:
        fingerprint = "chrome"
    if fingerprint:
        proxy["client-fingerprint"] = fingerprint
    reality_opts = raw.get("reality-opts") or raw.get("reality_opts") or {}
    if not isinstance(reality_opts, dict):
        reality_opts = {}
    public_key = _first_text(reality_opts.get("public-key"), reality_opts.get("public_key"), raw.get("pbk"), raw.get("public-key"))
    short_id = _first_text(reality_opts.get("short-id"), reality_opts.get("short_id"), raw.get("sid"), raw.get("short-id"))
    if public_key or short_id:
        proxy["reality-opts"] = {}
        if public_key:
            proxy["reality-opts"]["public-key"] = public_key
        if short_id:
            proxy["reality-opts"]["short-id"] = short_id

    if proxy["network"] == "xhttp":
        xhttp_opts: dict[str, Any] = {}
        path = str(raw.get("path") or xhttp_raw_opts.get("path") or "/").strip() or "/"
        xhttp_opts["path"] = path
        mode = str(raw.get("mode") or xhttp_raw_opts.get("mode") or "").strip()
        if mode:
            xhttp_opts["mode"] = mode
        host = _first_text(raw.get("host"), xhttp_raw_opts.get("host"), server_name, node.get("server"))
        if host:
            xhttp_opts["host"] = host
            xhttp_opts["headers"] = {"Host": host}
        download_settings = (
            xhttp_raw_opts.get("download-settings")
            or xhttp_raw_opts.get("downloadSettings")
        )
        if isinstance(download_settings, dict):
            xhttp_opts["download-settings"] = download_settings
        extra = xhttp_raw_opts.get("extra") if isinstance(xhttp_raw_opts.get("extra"), dict) else None
        if extra:
            xhttp_opts.update(extra)
        xhttp_opts.update(_xhttp_extra_options(raw.get("extra")))
        proxy["xhttp-opts"] = xhttp_opts
    return proxy


def _make_shadowsocks_proxy(node: dict[str, Any], index: int) -> dict[str, Any]:
    spec = normalize_shadowsocks(node)
    proxy: dict[str, Any] = {
        "name": f"proxy-out-{index}",
        "type": "ss",
        "server": spec.server,
        "port": spec.port,
        "cipher": spec.cipher,
        "password": spec.password,
        "udp": spec.udp,
    }
    if spec.plugin:
        proxy["plugin"] = spec.plugin
    if spec.plugin_options:
        proxy["plugin-opts"] = spec.plugin_options
    if spec.client_fingerprint:
        proxy["client-fingerprint"] = spec.client_fingerprint
    return proxy


def _make_proxy(node: dict[str, Any], index: int) -> dict[str, Any]:
    proto = str((_raw(node).get("type") or node.get("type") or "")).lower()
    if proto == "vless":
        return _make_vless_proxy(node, index)
    if proto in {"ss", "shadowsocks"}:
        return _make_shadowsocks_proxy(node, index)
    raise ValueError(f"mihomo unsupported protocol: {proto or 'unknown'}")


def generate_config(nodes: list[dict[str, Any]], base_port: int = MIHOMO_BASE_PORT) -> dict[str, Any]:
    proxies = []
    listeners = []
    rules = []
    for index, node in enumerate(nodes):
        proxy = _make_proxy(node, index)
        proxies.append(proxy)
        port = int(node.get("local_port") or (base_port + index))
        listener_name = f"socks-in-{index}"
        listeners.append({
            "name": listener_name,
            "type": "socks",
            "listen": "127.0.0.1",
            "port": port,
        })
        rules.append(f"IN-NAME,{listener_name},{proxy['name']}")
    rules.append("MATCH,DIRECT")

    return {
        "mixed-port": 0,
        "allow-lan": False,
        "mode": "rule",
        "log-level": "warning",
        "ipv6": True,
        "find-process-mode": "off",
        "proxies": proxies,
        "listeners": listeners,
        "rules": rules,
    }


def write_config(nodes: list[dict[str, Any]], base_port: int = MIHOMO_BASE_PORT, target_path: Path | None = None) -> str:
    ensure_core_dirs(CORE_TYPE)
    path = target_path or config_path()
    payload = generate_config(nodes, base_port=base_port)
    atomic_write_text(path, yaml.safe_dump(payload, allow_unicode=True, sort_keys=False))
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

    try:
        check = subprocess.run(
            [binary, "-t", "-f", str(path)],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except OSError as exc:
        logger.warning("[Mihomo] binary check failed: %s", exc)
        return {"success": False, "message": f"mihomo binary check failed: {exc}"}
    if check.returncode != 0:
        err = check.stderr.strip() or check.stdout.strip()
        logger.warning("[Mihomo] config check failed: %s", err)
        return {"success": False, "message": f"mihomo config check failed: {err}"}

    stop_managed_process()
    log_path = log_dir(CORE_TYPE) / "mihomo.log"
    log_file = log_path.open("ab")
    try:
        proc = subprocess.Popen(
            [binary, "-f", str(path), "-d", str(config_dir(CORE_TYPE))],
            stdout=log_file,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    except OSError as exc:
        logger.warning("[Mihomo] start failed: %s", exc)
        return {"success": False, "message": f"mihomo start failed: {exc}"}
    pid_path().write_text(str(proc.pid), encoding="utf-8")
    logger.info("[Mihomo] started managed process pid=%s", proc.pid)
    return {"success": True, "message": "mihomo started", "pid": proc.pid, "config_path": str(path)}


def _stage_nodes_sync(nodes: list[dict[str, Any]], base_port: int, binary: str | None) -> StagedCore:
    active_path = config_path()
    previous_config = active_path.read_bytes() if active_path.exists() else None
    stage_path = generation_config_path(CORE_TYPE, ".yaml")
    write_config(nodes, base_port, target_path=stage_path)
    stage = StagedCore(
        core_type=CORE_TYPE,
        nodes_count=len(nodes),
        base_port=base_port,
        staging_config_path=stage_path,
        active_config_path=active_path,
        previous_pid=_read_pid(),
        previous_config=previous_config,
    )
    if not nodes:
        return stage
    if not binary:
        raise RuntimeError("mihomo binary missing")

    check = subprocess.run(
        [binary, "-t", "-f", str(stage_path)],
        capture_output=True,
        text=True,
        timeout=15,
    )
    if check.returncode != 0:
        raise RuntimeError(check.stderr.strip() or check.stdout.strip() or "mihomo config check failed")

    candidate_log = log_dir(CORE_TYPE) / f"mihomo-candidate-{stage_path.stem}.log"
    try:
        with candidate_log.open("ab") as log_file:
            proc = subprocess.Popen(
                [binary, "-f", str(stage_path), "-d", str(config_dir(CORE_TYPE))],
                stdout=log_file,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
    except OSError as exc:
        raise RuntimeError(candidate_start_failure_message("mihomo", str(exc), base_port)) from exc
    time.sleep(0.4)
    if proc.poll() is not None:
        tail = candidate_log.read_bytes()[-2000:].decode("utf-8", "replace") if candidate_log.exists() else ""
        raise RuntimeError(candidate_start_failure_message("mihomo", tail, base_port))
    probe_port = int(nodes[0].get("local_port") or base_port)
    if not wait_for_tcp_listener(probe_port):
        stop_process(proc.pid)
        raise RuntimeError(f"mihomo candidate listener not ready on 127.0.0.1:{probe_port}")
    stage.candidate_pid = proc.pid
    return stage


async def stage_nodes(nodes: list[dict[str, Any]], base_port: int) -> dict[str, Any]:
    ensure_core_dirs(CORE_TYPE)
    binary_path: str | None = None
    if nodes:
        binary = await ensure_binary_async(CORE_TYPE, MIHOMO_BIN_NAME)
        if not binary.get("available"):
            return {
                "success": False,
                "pending_download": bool(binary.get("downloading")),
                "message": "mihomo binary missing, download started",
                "nodes_count": len(nodes),
            }
        binary_path = str(binary.get("path") or "")
    try:
        stage = await asyncio.to_thread(_stage_nodes_sync, nodes, base_port, binary_path)
        return {
            "success": True,
            "message": "mihomo candidate ready" if nodes else "mihomo empty generation ready",
            "nodes_count": len(nodes),
            "stage": stage,
        }
    except Exception as exc:
        logger.warning("[Mihomo] candidate stage failed: %s", exc)
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
    if stage.candidate_pid:
        stop_process(stage.candidate_pid)
    restore_previous_config(stage)
    if stage.previous_pid:
        pid_path().write_text(str(stage.previous_pid), encoding="utf-8")
    else:
        try:
            pid_path().unlink()
        except FileNotFoundError:
            pass


def retire_stage_previous(stage: StagedCore) -> None:
    if stage.previous_pid and stage.previous_pid != stage.candidate_pid:
        stop_process(stage.previous_pid)


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
