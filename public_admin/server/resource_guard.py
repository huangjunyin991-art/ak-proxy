"""Process-level resource guard for the proxy service.

The connection pools have their own budgets, but a process-wide guard is still
needed as a last resort for leaks in dependencies, proxy cores, or future code.
It deliberately requires a sustained hard-threshold breach before asking
systemd to restart the process, avoiding restart storms on short spikes.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import time
from dataclasses import dataclass
from typing import Any, Callable


def _env_bool(name: str, default: bool) -> bool:
    value = str(os.environ.get(name, "")).strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return default


def _env_float(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return min(max(value, minimum), maximum)


@dataclass(frozen=True)
class ResourceGuardConfig:
    enabled: bool = _env_bool("AK_RESOURCE_GUARD_ENABLED", True)
    interval_seconds: float = _env_float("AK_RESOURCE_GUARD_INTERVAL_SECONDS", 5.0, 0.5, 60.0)
    warning_ratio: float = _env_float("AK_RESOURCE_GUARD_WARNING_RATIO", 0.70, 0.50, 0.95)
    critical_ratio: float = _env_float("AK_RESOURCE_GUARD_CRITICAL_RATIO", 0.85, 0.60, 0.99)
    critical_hold_seconds: float = _env_float("AK_RESOURCE_GUARD_CRITICAL_HOLD_SECONDS", 15.0, 1.0, 600.0)
    restart_cooldown_seconds: float = _env_float("AK_RESOURCE_GUARD_RESTART_COOLDOWN_SECONDS", 300.0, 60.0, 86400.0)
    minimum_uptime_seconds: float = _env_float("AK_RESOURCE_GUARD_MINIMUM_UPTIME_SECONDS", 120.0, 0.0, 86400.0)


def _fd_limit() -> tuple[int, int]:
    try:
        import resource

        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        return int(soft), int(hard)
    except (ImportError, OSError, ValueError):
        return 0, 0


def _fd_count() -> int | None:
    proc_fd = "/proc/self/fd"
    try:
        return len(os.listdir(proc_fd))
    except (FileNotFoundError, PermissionError, OSError):
        return None


class ProcessResourceGuard:
    """Monitor process file descriptors and request a supervised restart."""

    def __init__(
        self,
        *,
        config: ResourceGuardConfig | None = None,
        logger: logging.Logger | None = None,
        now: Callable[[], float] | None = None,
        terminate: Callable[[], None] | None = None,
    ):
        self.config = config or ResourceGuardConfig()
        self.logger = logger or logging.getLogger("TransparentProxy")
        self._now = now or time.monotonic
        self._terminate = terminate or self._terminate_process
        self._started_at = self._now()
        self._critical_since: float | None = None
        self._last_warning_at = 0.0
        self._last_restart_at: float | None = None
        self._task: asyncio.Task | None = None
        self._stopping = asyncio.Event()
        self._last_snapshot: dict[str, Any] = {}
        self._restart_requested = False

    @staticmethod
    def _terminate_process() -> None:
        os.kill(os.getpid(), signal.SIGTERM)

    @staticmethod
    def snapshot() -> dict[str, Any]:
        fd_count = _fd_count()
        soft, hard = _fd_limit()
        ratio = (fd_count / soft) if fd_count is not None and soft > 0 else 0.0
        return {
            "fd_count": fd_count,
            "soft_limit": soft,
            "hard_limit": hard,
            "fd_ratio": round(ratio, 4),
        }

    def evaluate(self, snapshot: dict[str, Any] | None = None, *, now: float | None = None) -> str:
        """Evaluate one sample; return ``ok``, ``warning``, ``critical`` or ``restart``."""
        current = self._now() if now is None else float(now)
        sample = dict(snapshot or self.snapshot())
        self._last_snapshot = sample
        fd_count = sample.get("fd_count")
        soft_limit = int(sample.get("soft_limit") or 0)
        ratio = float(sample.get("fd_ratio") or 0.0)
        if fd_count is None or soft_limit <= 0:
            self._critical_since = None
            return "ok"
        if ratio >= self.config.critical_ratio:
            if self._critical_since is None:
                self._critical_since = current
            if (
                current - self._critical_since >= self.config.critical_hold_seconds
                and (
                    self._last_restart_at is None
                    or current - self._last_restart_at >= self.config.restart_cooldown_seconds
                )
                and current - self._started_at >= self.config.minimum_uptime_seconds
            ):
                self._last_restart_at = current
                self._restart_requested = True
                self.logger.critical(
                    "[ResourceGuard] 文件描述符持续超限，申请systemd重启 fd=%s soft=%s ratio=%.1f%% hold=%.1fs",
                    fd_count,
                    soft_limit,
                    ratio * 100,
                    current - self._critical_since,
                )
                return "restart"
            return "critical"
        self._critical_since = None
        if ratio >= self.config.warning_ratio:
            if current - self._last_warning_at >= self.config.interval_seconds:
                self._last_warning_at = current
                self.logger.warning(
                    "[ResourceGuard] 文件描述符水位偏高 fd=%s soft=%s ratio=%.1f%%",
                    fd_count,
                    soft_limit,
                    ratio * 100,
                )
            return "warning"
        return "ok"

    async def start(self) -> None:
        if not self.config.enabled or (self._task and not self._task.done()):
            return
        self._started_at = self._now()
        self._stopping = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="ak-resource-guard")

    async def stop(self) -> None:
        self._stopping.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None

    async def _run(self) -> None:
        while not self._stopping.is_set():
            result = self.evaluate()
            if result == "restart":
                self._terminate()
                return
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=self.config.interval_seconds)
            except asyncio.TimeoutError:
                continue

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.config.enabled,
            "running": bool(self._task and not self._task.done()),
            "restart_requested": self._restart_requested,
            "critical_since": self._critical_since,
            "last_restart_at": self._last_restart_at,
            "last_snapshot": dict(self._last_snapshot),
        }
