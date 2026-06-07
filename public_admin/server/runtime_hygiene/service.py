import asyncio
import inspect
import time
from typing import Any, Awaitable, Callable, Optional

from .models import RuntimeHygienePolicy


CleanupCallback = Callable[[RuntimeHygienePolicy], dict[str, Any] | Awaitable[dict[str, Any]]]


class RuntimeHygieneService:
    """Runs low-risk cleanup hooks for process-local runtime state."""

    def __init__(self, cleanup: CleanupCallback, *, policy: RuntimeHygienePolicy | None = None,
                 logger: Any = None):
        self.cleanup = cleanup
        self.policy = policy or RuntimeHygienePolicy()
        self.interval_seconds = self.policy.cleanup_interval_seconds
        self.initial_delay_seconds = self.policy.initial_delay_seconds
        self.logger = logger
        self._task: Optional[asyncio.Task] = None
        self._stopping = asyncio.Event()
        self._last_result: dict[str, Any] = {}
        self._last_error = ""
        self._last_started_at = 0.0
        self._last_finished_at = 0.0
        self._run_count = 0
        self._error_count = 0

    def start(self) -> None:
        if not self.policy.enabled:
            return
        if self._task and not self._task.done():
            return
        self._stopping = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="ak-runtime-hygiene")

    async def stop(self) -> None:
        self._stopping.set()
        if not self._task:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        finally:
            self._task = None

    async def update_policy(self, policy: RuntimeHygienePolicy) -> None:
        self.policy = policy
        self.interval_seconds = policy.cleanup_interval_seconds
        self.initial_delay_seconds = policy.initial_delay_seconds
        if not policy.enabled:
            await self.stop()
            return
        self.start()

    async def run_once(self) -> dict[str, Any]:
        self._last_started_at = time.time()
        try:
            if not self.policy.enabled:
                self._last_result = {"skipped": "disabled"}
                self._last_error = ""
                return self._last_result
            result = self.cleanup(self.policy)
            if inspect.isawaitable(result):
                result = await result
            self._last_result = dict(result or {})
            self._last_error = ""
            return self._last_result
        except Exception as exc:
            self._error_count += 1
            self._last_error = str(exc)
            if self.logger:
                try:
                    self.logger.warning("[RuntimeHygiene] cleanup failed: %s", exc)
                except Exception:
                    pass
            return {"error": str(exc)}
        finally:
            self._run_count += 1
            self._last_finished_at = time.time()

    async def _run(self) -> None:
        try:
            if self.initial_delay_seconds > 0:
                await asyncio.wait_for(self._stopping.wait(), timeout=self.initial_delay_seconds)
                return
        except asyncio.TimeoutError:
            pass
        while not self._stopping.is_set():
            await self.run_once()
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=self.interval_seconds)
            except asyncio.TimeoutError:
                continue

    def snapshot(self) -> dict[str, Any]:
        return {
            "running": bool(self._task and not self._task.done()),
            "enabled": self.policy.enabled,
            "interval_seconds": self.interval_seconds,
            "initial_delay_seconds": self.initial_delay_seconds,
            "run_count": self._run_count,
            "error_count": self._error_count,
            "last_started_at": self._last_started_at,
            "last_finished_at": self._last_finished_at,
            "last_duration_ms": round((self._last_finished_at - self._last_started_at) * 1000, 2)
            if self._last_finished_at and self._last_started_at else 0.0,
            "last_error": self._last_error,
            "last_result": dict(self._last_result or {}),
            "policy": self.policy.to_dict(),
        }
