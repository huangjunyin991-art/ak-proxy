# -*- coding: utf-8 -*-
"""Runtime paths and binary acquisition for proxy cores.

Binary downloads are best-effort and non-blocking from the caller's point of
view. A missing core must not stop the main proxy service.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import os
import platform
import shutil
import stat
import tarfile
import tempfile
import zipfile
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

logger = logging.getLogger("TransparentProxy")

RUNTIME_ROOT = Path(os.environ.get("AK_PROXY_CORE_RUNTIME_DIR") or (Path.home() / ".ak_proxy" / "proxy_cores"))
DOWNLOAD_TIMEOUT_SECONDS = int(os.environ.get("AK_PROXY_CORE_DOWNLOAD_TIMEOUT", "120"))

SINGBOX_VERSION = os.environ.get("AK_SINGBOX_VERSION", "")
MIHOMO_VERSION = os.environ.get("AK_MIHOMO_VERSION", "")
SINGBOX_FALLBACK_VERSION = "1.11.15"
MIHOMO_FALLBACK_VERSION = "1.19.15"

_download_tasks: dict[str, asyncio.Task] = {}
_download_status: dict[str, dict[str, Any]] = {}


def core_dir(core_type: str) -> Path:
    return RUNTIME_ROOT / core_type


def bin_dir(core_type: str) -> Path:
    return core_dir(core_type) / "bin"


def config_dir(core_type: str) -> Path:
    return core_dir(core_type) / "config"


def log_dir(core_type: str) -> Path:
    return core_dir(core_type) / "logs"


def ensure_core_dirs(core_type: str) -> None:
    for path in (bin_dir(core_type), config_dir(core_type), log_dir(core_type)):
        path.mkdir(parents=True, exist_ok=True)


def executable_name(name: str) -> str:
    return f"{name}.exe" if os.name == "nt" else name


def managed_binary_path(core_type: str) -> Path:
    name = "sing-box" if core_type == "singbox" else "mihomo"
    return bin_dir(core_type) / executable_name(name)


def resolve_binary(core_type: str, system_name: str) -> str | None:
    explicit_env = "AK_SINGBOX_BIN" if core_type == "singbox" else "AK_MIHOMO_BIN"
    explicit = os.environ.get(explicit_env)
    if explicit:
        path = Path(explicit)
        if path.exists():
            return str(path)
    managed = managed_binary_path(core_type)
    if managed.exists():
        return str(managed)
    found = shutil.which(system_name)
    if found:
        return found
    return None


def _platform_parts() -> tuple[str, str]:
    sys_name = platform.system().lower()
    machine = platform.machine().lower()
    if sys_name.startswith("linux"):
        os_part = "linux"
    elif sys_name.startswith("darwin"):
        os_part = "darwin"
    elif sys_name.startswith("windows"):
        os_part = "windows"
    else:
        raise RuntimeError(f"unsupported os: {platform.system()}")

    if machine in {"x86_64", "amd64"}:
        arch_part = "amd64"
    elif machine in {"aarch64", "arm64"}:
        arch_part = "arm64"
    elif machine in {"armv7l", "armv7"}:
        arch_part = "armv7"
    else:
        raise RuntimeError(f"unsupported arch: {platform.machine()}")
    return os_part, arch_part


def _fetch_latest_asset_url(repo: str, predicates: list[str]) -> str | None:
    api_url = f"https://api.github.com/repos/{repo}/releases/latest"
    req = Request(api_url, headers={
        "User-Agent": "ak-proxy-core-downloader/1.0",
        "Accept": "application/vnd.github+json",
    })
    with urlopen(req, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))
    assets = payload.get("assets") if isinstance(payload, dict) else []
    if not isinstance(assets, list):
        return None
    lowered_predicates = [item.lower() for item in predicates if item]
    matches: list[tuple[int, str]] = []
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        name = str(asset.get("name") or "")
        lower_name = name.lower()
        if all(token in lower_name for token in lowered_predicates):
            url = str(asset.get("browser_download_url") or "")
            if url:
                penalty = 0
                if "legacy" in lower_name:
                    penalty += 10
                if "compatible" in lower_name:
                    penalty += 5
                matches.append((penalty, url))
    if matches:
        matches.sort(key=lambda item: item[0])
        return matches[0][1]
    return None


def _singbox_download_url() -> str:
    os_part, arch_part = _platform_parts()
    ext = "zip" if os_part == "windows" else "tar.gz"
    if not os.environ.get("AK_SINGBOX_VERSION"):
        latest = _fetch_latest_asset_url("SagerNet/sing-box", ["sing-box", os_part, arch_part, ext])
        if latest:
            return latest
    version = SINGBOX_VERSION or SINGBOX_FALLBACK_VERSION
    return (
        "https://github.com/SagerNet/sing-box/releases/download/"
        f"v{version}/sing-box-{version}-{os_part}-{arch_part}.{ext}"
    )


def _mihomo_download_url() -> str:
    os_part, arch_part = _platform_parts()
    if os_part == "darwin":
        os_name = "darwin"
    elif os_part == "windows":
        os_name = "windows"
    else:
        os_name = "linux"
    arch_name = "amd64" if arch_part == "amd64" else "arm64"
    suffix = "zip" if os_part == "windows" else "gz"
    if not os.environ.get("AK_MIHOMO_VERSION"):
        latest = _fetch_latest_asset_url("MetaCubeX/mihomo", ["mihomo", os_name, arch_name, suffix])
        if latest:
            return latest
    version = MIHOMO_VERSION or MIHOMO_FALLBACK_VERSION
    return (
        "https://github.com/MetaCubeX/mihomo/releases/download/"
        f"v{version}/mihomo-{os_name}-{arch_name}-v{version}.{suffix}"
    )


def download_url(core_type: str) -> str:
    override_env = "AK_SINGBOX_DOWNLOAD_URL" if core_type == "singbox" else "AK_MIHOMO_DOWNLOAD_URL"
    override = os.environ.get(override_env)
    if override:
        return override
    if core_type == "singbox":
        return _singbox_download_url()
    if core_type == "mihomo":
        return _mihomo_download_url()
    raise ValueError(f"unknown core: {core_type}")


def _copy_executable_from_tree(root: Path, target: Path, names: set[str]) -> None:
    candidates: list[Path] = []
    for path in root.rglob("*"):
        if path.is_file() and path.name in names:
            candidates.append(path)
    if not candidates:
        for path in root.rglob("*"):
            if path.is_file() and any(path.name.startswith(name) for name in names):
                candidates.append(path)
    if not candidates:
        raise RuntimeError(f"archive does not contain executable: {', '.join(sorted(names))}")
    chosen = max(candidates, key=lambda p: p.stat().st_size)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(chosen, target)
    if os.name != "nt":
        mode = target.stat().st_mode
        target.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _download_file(url: str, destination: Path) -> None:
    req = Request(url, headers={"User-Agent": "ak-proxy-core-downloader/1.0"})
    with urlopen(req, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
        with destination.open("wb") as f:
            shutil.copyfileobj(response, f)


def _install_downloaded(core_type: str, archive_path: Path, target: Path) -> None:
    names = {target.name}
    if core_type == "singbox":
        names.update({"sing-box", "sing-box.exe"})
    elif core_type == "mihomo":
        names.update({"mihomo", "mihomo.exe"})

    with tempfile.TemporaryDirectory(prefix=f"ak-{core_type}-extract-") as temp_name:
        temp_root = Path(temp_name)
        archive_name = archive_path.name.lower()
        if archive_name.endswith(".zip"):
            with zipfile.ZipFile(archive_path) as zf:
                zf.extractall(temp_root)
            _copy_executable_from_tree(temp_root, target, names)
            return
        if archive_name.endswith(".tar.gz") or archive_name.endswith(".tgz"):
            with tarfile.open(archive_path, "r:gz") as tf:
                tf.extractall(temp_root)
            _copy_executable_from_tree(temp_root, target, names)
            return
        if archive_name.endswith(".gz"):
            extracted = temp_root / target.name
            with gzip.open(archive_path, "rb") as src, extracted.open("wb") as dst:
                shutil.copyfileobj(src, dst)
            _copy_executable_from_tree(temp_root, target, names)
            return
        _copy_executable_from_tree(archive_path.parent, target, names)


def _download_binary_sync(core_type: str) -> dict[str, Any]:
    ensure_core_dirs(core_type)
    target = managed_binary_path(core_type)
    if target.exists():
        return {"success": True, "message": "binary already exists", "path": str(target)}
    url = download_url(core_type)
    suffix = ".zip" if url.lower().endswith(".zip") else ".tar.gz" if url.lower().endswith((".tar.gz", ".tgz")) else ".gz"
    temp_file = target.with_suffix(target.suffix + suffix + ".download")
    if temp_file.exists():
        try:
            temp_file.unlink()
        except Exception:
            pass
    logger.info("[ProxyCore] downloading %s from %s", core_type, url)
    _download_file(url, temp_file)
    _install_downloaded(core_type, temp_file, target)
    try:
        temp_file.unlink()
    except Exception:
        pass
    return {"success": True, "message": "downloaded", "path": str(target), "url": url}


async def ensure_binary_async(core_type: str, system_name: str) -> dict[str, Any]:
    binary = resolve_binary(core_type, system_name)
    if binary:
        return {"available": True, "path": binary, "download": _download_status.get(core_type, {})}

    task = _download_tasks.get(core_type)
    if task and not task.done():
        return {
            "available": False,
            "downloading": True,
            "path": "",
            "download": _download_status.get(core_type, {"state": "running"}),
        }

    async def _run_download() -> dict[str, Any]:
        _download_status[core_type] = {"state": "running", "started_at": asyncio.get_running_loop().time()}
        try:
            result = await asyncio.to_thread(_download_binary_sync, core_type)
            _download_status[core_type] = {"state": "success", **result}
            return result
        except Exception as exc:
            logger.warning("[ProxyCore] %s download failed: %s", core_type, exc)
            _download_status[core_type] = {"state": "failed", "error": str(exc)}
            return {"success": False, "message": str(exc)}

    _download_tasks[core_type] = asyncio.create_task(_run_download())
    return {
        "available": False,
        "downloading": True,
        "path": "",
        "download": _download_status.get(core_type, {"state": "queued"}),
    }


def binary_status(core_type: str, system_name: str) -> dict[str, Any]:
    binary = resolve_binary(core_type, system_name)
    task = _download_tasks.get(core_type)
    return {
        "available": bool(binary),
        "path": binary or "",
        "managed_path": str(managed_binary_path(core_type)),
        "downloading": bool(task and not task.done()),
        "download": _download_status.get(core_type, {}),
    }
