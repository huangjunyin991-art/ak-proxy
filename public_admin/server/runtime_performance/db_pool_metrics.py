import asyncio
import inspect
import os
import time
from collections import deque
from typing import Any, Deque


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except Exception:
        return default


class DbAcquireMetrics:
    def __init__(self, slow_ms: float | None = None):
        self.slow_ms = float(slow_ms if slow_ms is not None else _float_env('AK_DB_ACQUIRE_SLOW_MS', 250.0))
        self.in_flight = 0
        self.completed = 0
        self.failed = 0
        self.timeouts = 0
        self.slow_count = 0
        self.total_wait_ms = 0.0
        self.max_wait_ms = 0.0
        self.last_wait_ms = 0.0
        self.recent_slow: Deque[dict] = deque(maxlen=20)
        self.recent_errors: Deque[dict] = deque(maxlen=20)

    def started(self) -> None:
        self.in_flight += 1

    def finished(self, wait_ms: float, error: BaseException | None = None) -> None:
        self.in_flight = max(0, self.in_flight - 1)
        self.completed += 1
        self.last_wait_ms = wait_ms
        self.total_wait_ms += wait_ms
        self.max_wait_ms = max(self.max_wait_ms, wait_ms)
        if error is not None:
            self.failed += 1
            if isinstance(error, asyncio.TimeoutError):
                self.timeouts += 1
            self.recent_errors.append({
                'wait_ms': round(wait_ms, 2),
                'error': type(error).__name__,
                'callsite': _format_external_callsite(),
                'ts': time.time(),
            })
            return
        if wait_ms >= self.slow_ms:
            self.slow_count += 1
            self.recent_slow.append({
                'wait_ms': round(wait_ms, 2),
                'callsite': _format_external_callsite(),
                'ts': time.time(),
            })

    def snapshot(self) -> dict:
        completed = max(1, self.completed)
        return {
            'in_flight': self.in_flight,
            'completed': self.completed,
            'failed': self.failed,
            'timeouts': self.timeouts,
            'slow_ms': self.slow_ms,
            'slow_count': self.slow_count,
            'last_wait_ms': round(self.last_wait_ms, 2),
            'avg_wait_ms': round(self.total_wait_ms / completed, 2),
            'max_wait_ms': round(self.max_wait_ms, 2),
            'recent_slow': list(self.recent_slow),
            'recent_errors': list(self.recent_errors),
        }


class InstrumentedPoolAcquire:
    def __init__(self, acquire_context: Any, metrics: DbAcquireMetrics):
        self._acquire_context = acquire_context
        self._metrics = metrics

    def __await__(self):
        return self._await_impl().__await__()

    async def _await_impl(self):
        started_at = time.perf_counter()
        self._metrics.started()
        try:
            conn = await self._acquire_context
        except BaseException as error:
            self._metrics.finished((time.perf_counter() - started_at) * 1000.0, error)
            raise
        self._metrics.finished((time.perf_counter() - started_at) * 1000.0)
        return conn

    async def __aenter__(self):
        started_at = time.perf_counter()
        self._metrics.started()
        try:
            conn = await self._acquire_context.__aenter__()
        except BaseException as error:
            self._metrics.finished((time.perf_counter() - started_at) * 1000.0, error)
            raise
        self._metrics.finished((time.perf_counter() - started_at) * 1000.0)
        return conn

    async def __aexit__(self, exc_type, exc, tb):
        return await self._acquire_context.__aexit__(exc_type, exc, tb)


class InstrumentedPool:
    def __init__(self, pool: Any, metrics: DbAcquireMetrics):
        self._pool = pool
        self._metrics = metrics

    def acquire(self, *args, **kwargs) -> InstrumentedPoolAcquire:
        return InstrumentedPoolAcquire(self._pool.acquire(*args, **kwargs), self._metrics)

    def unwrap(self) -> Any:
        return self._pool

    def __getattr__(self, name: str) -> Any:
        return getattr(self._pool, name)


def _format_external_callsite() -> str:
    for frame in inspect.stack()[2:]:
        filename = frame.filename.replace('\\', '/')
        if '/runtime_performance/' in filename:
            continue
        if filename.endswith('/asyncio/tasks.py') or filename.endswith('/contextlib.py'):
            continue
        return f"{os.path.basename(filename)}:{frame.lineno}:{frame.function}"
    return 'unknown'
