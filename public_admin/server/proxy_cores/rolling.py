"""Blue-green lifecycle primitives for local proxy-core generations."""

from __future__ import annotations

import json
import os
import socket
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .runtime import RUNTIME_ROOT, config_dir, ensure_core_dirs


PORT_BANK_OFFSET = 20_000
DRAIN_SECONDS = max(0.0, float(os.environ.get("AK_PROXY_CORE_DRAIN_SECONDS", "30")))
_STATE_PATH = RUNTIME_ROOT / "active_port_generations.json"


@dataclass
class StagedCore:
    core_type: str
    nodes_count: int
    base_port: int
    staging_config_path: Path
    active_config_path: Path
    candidate_pid: int = 0
    previous_pid: int = 0
    previous_config: bytes | None = None
    previous_systemd_active: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)
    promoted: bool = False


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_bytes(payload)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def atomic_write_text(path: Path, payload: str, encoding: str = "utf-8") -> None:
    atomic_write_bytes(path, payload.encode(encoding))


def generation_config_path(core_type: str, suffix: str) -> Path:
    ensure_core_dirs(core_type)
    generation_dir = config_dir(core_type) / "generations"
    generation_dir.mkdir(parents=True, exist_ok=True)
    return generation_dir / f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:10]}{suffix}"


def _read_state() -> dict[str, Any]:
    try:
        data = json.loads(_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _write_state(data: dict[str, Any]) -> None:
    atomic_write_text(_STATE_PATH, json.dumps(data, ensure_ascii=True, sort_keys=True))


def active_base_port(core_type: str, default: int) -> int:
    data = _read_state()
    try:
        port = int((data.get(core_type) or {}).get("base_port") or default)
    except (TypeError, ValueError):
        return int(default)
    return port if 1 <= port <= 65_535 else int(default)


def candidate_base_port(core_type: str, default: int) -> int:
    """Alternate between two non-overlapping port banks for each core."""
    default = int(default)
    active = active_base_port(core_type, default)
    alternate = default + PORT_BANK_OFFSET
    if alternate > 65_535:
        alternate = default - PORT_BANK_OFFSET
    if alternate <= 0:
        raise ValueError(f"no valid alternate port bank for {core_type}: {default}")
    return alternate if active == default else default


def mark_active_base_port(core_type: str, base_port: int) -> None:
    data = _read_state()
    data[core_type] = {"base_port": int(base_port), "updated_at": int(time.time())}
    _write_state(data)


def clear_active_base_port(core_type: str) -> None:
    data = _read_state()
    if core_type in data:
        data.pop(core_type, None)
        _write_state(data)


def is_process_running(pid: int) -> bool:
    if int(pid or 0) <= 0:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except OSError:
        return False


def stop_process(pid: int, timeout_seconds: float = 8.0) -> bool:
    pid = int(pid or 0)
    if not is_process_running(pid):
        return False
    try:
        import signal
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    deadline = time.monotonic() + max(0.1, float(timeout_seconds))
    while is_process_running(pid) and time.monotonic() < deadline:
        time.sleep(0.1)
    if is_process_running(pid):
        try:
            import signal
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    return True


def wait_for_tcp_listener(port: int, timeout_seconds: float = 3.0) -> bool:
    deadline = time.monotonic() + max(0.1, float(timeout_seconds))
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", int(port)), timeout=0.25):
                return True
        except OSError:
            time.sleep(0.1)
    return False


def promote_staged_config(stage: StagedCore) -> None:
    atomic_write_bytes(stage.active_config_path, stage.staging_config_path.read_bytes())
    stage.promoted = True


def restore_previous_config(stage: StagedCore) -> None:
    if not stage.promoted:
        return
    if stage.previous_config is None:
        try:
            stage.active_config_path.unlink()
        except FileNotFoundError:
            pass
    else:
        atomic_write_bytes(stage.active_config_path, stage.previous_config)
    stage.promoted = False
