import asyncio
import os
import time
from collections import deque
from threading import Lock
from typing import Callable, Deque, TypeVar


T = TypeVar('T')


class BlockingRunner:
    def __init__(
        self,
        max_concurrency: int | None = None,
        slow_ms: float | None = None,
        name: str = 'default',
        label: str = 'Default blocking IO',
    ):
        if max_concurrency is None:
            try:
                max_concurrency = int(os.environ.get('AK_BLOCKING_IO_CONCURRENCY', '8'))
            except Exception:
                max_concurrency = 8
        self.name = str(name or 'default')
        self.label = str(label or self.name)
        self._max_concurrency = max(1, int(max_concurrency or 1))
        self._semaphore = asyncio.BoundedSemaphore(self._max_concurrency)
        self._slow_ms = float(slow_ms if slow_ms is not None else os.environ.get('AK_BLOCKING_IO_SLOW_MS', '250'))
        self._lock = Lock()
        self._waiting = 0
        self._in_flight = 0
        self._submitted = 0
        self._completed = 0
        self._failed = 0
        self._cancelled = 0
        self._slow_count = 0
        self._total_queue_ms = 0.0
        self._total_run_ms = 0.0
        self._max_queue_ms = 0.0
        self._max_run_ms = 0.0
        self._recent_slow: Deque[dict] = deque(maxlen=20)

    async def run(self, func: Callable[..., T], *args, **kwargs) -> T:
        queued_at = time.perf_counter()
        func_name = getattr(func, '__qualname__', getattr(func, '__name__', 'blocking_call'))
        acquired = False
        with self._lock:
            self._submitted += 1
            self._waiting += 1
        try:
            await self._semaphore.acquire()
            acquired = True
        except asyncio.CancelledError:
            with self._lock:
                self._waiting = max(0, self._waiting - 1)
                self._cancelled += 1
            raise
        queue_ms = (time.perf_counter() - queued_at) * 1000.0
        with self._lock:
            self._waiting = max(0, self._waiting - 1)
            self._in_flight += 1
        started_at = time.perf_counter()
        failed = False
        cancelled = False
        try:
            return await asyncio.to_thread(func, *args, **kwargs)
        except asyncio.CancelledError:
            cancelled = True
            raise
        except Exception:
            failed = True
            raise
        finally:
            run_ms = (time.perf_counter() - started_at) * 1000.0
            with self._lock:
                self._in_flight = max(0, self._in_flight - 1)
                self._completed += 1
                if failed:
                    self._failed += 1
                if cancelled:
                    self._cancelled += 1
                self._total_queue_ms += queue_ms
                self._total_run_ms += run_ms
                self._max_queue_ms = max(self._max_queue_ms, queue_ms)
                self._max_run_ms = max(self._max_run_ms, run_ms)
                if queue_ms >= self._slow_ms or run_ms >= self._slow_ms:
                    self._slow_count += 1
                    self._recent_slow.append({
                        'pool': self.name,
                        'func': str(func_name),
                        'queue_ms': round(queue_ms, 2),
                        'run_ms': round(run_ms, 2),
                        'ts': time.time(),
                    })
            if acquired:
                self._semaphore.release()

    def snapshot(self) -> dict:
        with self._lock:
            completed = max(1, self._completed)
            in_flight = int(self._in_flight)
            waiting = int(self._waiting)
            if waiting > 0 and in_flight >= self._max_concurrency:
                status = 'saturated'
            elif waiting > 0:
                status = 'queued'
            elif in_flight >= self._max_concurrency:
                status = 'busy'
            elif in_flight > 0:
                status = 'active'
            else:
                status = 'idle'
            return {
                'name': self.name,
                'label': self.label,
                'status': status,
                'max_concurrency': self._max_concurrency,
                'in_flight': in_flight,
                'waiting': waiting,
                'submitted': self._submitted,
                'completed': self._completed,
                'failed': self._failed,
                'cancelled': self._cancelled,
                'slow_count': self._slow_count,
                'slow_ms': round(self._slow_ms, 2),
                'saturation_pct': round((in_flight / self._max_concurrency) * 100.0, 2),
                'avg_queue_ms': round(self._total_queue_ms / completed, 2),
                'avg_run_ms': round(self._total_run_ms / completed, 2),
                'max_queue_ms': round(self._max_queue_ms, 2),
                'max_run_ms': round(self._max_run_ms, 2),
                'recent_slow': list(self._recent_slow),
            }


_default_runner = BlockingRunner(name='default', label='默认阻塞 IO')


async def run_blocking(func: Callable[..., T], *args, **kwargs) -> T:
    return await _default_runner.run(func, *args, **kwargs)


def get_blocking_runner_snapshot() -> dict:
    return _default_runner.snapshot()


def get_default_blocking_runner() -> BlockingRunner:
    return _default_runner
