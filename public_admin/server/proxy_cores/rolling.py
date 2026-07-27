"""Blue-green lifecycle primitives for local proxy-core generations."""

from __future__ import annotations

import json
import os
import re
import socket
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .runtime import RUNTIME_ROOT, config_dir, ensure_core_dirs


PORT_BANK_OFFSET = 20_000
PORT_BANK_GAP = 32
PORT_BANK_MIN_STEP = 1_000
PORT_POOL_START = 10_001
PORT_POOL_END = 65_535
DRAIN_SECONDS = max(0.0, float(os.environ.get("AK_PROXY_CORE_DRAIN_SECONDS", "30")))
_STATE_PATH = RUNTIME_ROOT / "active_port_generations.json"
_ANSI_ESCAPE_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")


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


def active_port_generation(core_type: str, default: int) -> tuple[int, int]:
    data = _read_state()
    generation = data.get(core_type) or {}
    try:
        port = int(generation.get("base_port") or default)
    except (TypeError, ValueError):
        port = int(default)
    if not 1 <= port <= 65_535:
        port = int(default)
    try:
        port_count = max(0, int(generation.get("port_count") or 0))
    except (TypeError, ValueError):
        port_count = 0
    return port, port_count


def active_base_port(core_type: str, default: int) -> int:
    return active_port_generation(core_type, default)[0]


def _ranges_overlap(first_base: int, first_count: int, second_base: int, second_count: int) -> bool:
    if first_count <= 0 or second_count <= 0:
        return False
    first_end = first_base + first_count - 1
    second_end = second_base + second_count - 1
    return first_base <= second_end and second_base <= first_end


def _port_range_is_available(base_port: int, port_count: int) -> bool:
    sockets: list[socket.socket] = []
    try:
        for port in range(int(base_port), int(base_port) + max(0, int(port_count))):
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            listener.bind(("127.0.0.1", port))
            sockets.append(listener)
        return True
    except OSError:
        return False
    finally:
        for listener in sockets:
            listener.close()


def candidate_base_port(
    core_type: str,
    default: int,
    required_ports: int = 1,
    reserved_ranges: tuple[tuple[int, int], ...] = (),
) -> int:
    """Choose a free port bank without touching the active generation."""
    default = int(default)
    required_ports = max(0, int(required_ports or 0))
    if required_ports == 0:
        return default

    active_base, active_count = active_port_generation(core_type, default)
    preferred_bases = []
    if active_count > 0:
        preferred_bases.append(active_base + active_count + PORT_BANK_GAP)
    preferred_bases.extend((
        default + PORT_BANK_OFFSET,
        default + 2 * PORT_BANK_OFFSET,
        default,
    ))
    scan_step = max(PORT_BANK_MIN_STEP, required_ports + PORT_BANK_GAP)
    preferred_bases.extend(range(PORT_POOL_START, PORT_POOL_END + 1, scan_step))
    banks = []
    seen_bases = set()
    for base in preferred_bases:
        base = int(base)
        if base in seen_bases or base < PORT_POOL_START:
            continue
        seen_bases.add(base)
        if base + required_ports - 1 <= PORT_POOL_END:
            banks.append(base)

    blocked_ranges = list(reserved_ranges)
    blocked_ranges.append((active_base, max(1, active_count)))
    for base in banks:
        if any(
            _ranges_overlap(base, required_ports, blocked_base, blocked_count)
            for blocked_base, blocked_count in blocked_ranges
        ):
            continue
        if _port_range_is_available(base, required_ports):
            return base

    raise RuntimeError(
        f"{core_type} 无可用本地端口段（需要连续 {required_ports} 个端口）"
    )


def mark_active_base_port(core_type: str, base_port: int, port_count: int = 0) -> None:
    data = _read_state()
    data[core_type] = {
        "base_port": int(base_port),
        "port_count": max(0, int(port_count or 0)),
        "updated_at": int(time.time()),
    }
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


def clean_process_output(value: str, max_chars: int = 1200) -> str:
    text = _ANSI_ESCAPE_RE.sub("", str(value or ""))
    text = " ".join(text.replace("\x00", " ").split())
    return text[-max(1, int(max_chars)):]


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
