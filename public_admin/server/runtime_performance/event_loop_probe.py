import asyncio
import logging
import os
import threading
import time
from collections import deque
from typing import Deque, Optional


logger = logging.getLogger("RuntimePerformance")


class EventLoopLagProbe:
    def __init__(self, interval_seconds: float = 1.0, slow_ms: float = 250.0,
                 sample_size: int = 600, watchdog_seconds: float = 30.0,
                 watchdog_grace_seconds: float = 180.0,
                 watchdog_enabled: bool = True):
        self.interval_seconds = max(0.1, float(interval_seconds))
        self.slow_ms = max(1.0, float(slow_ms))
        self._samples: Deque[float] = deque(maxlen=max(10, int(sample_size)))
        self._recent_slow: Deque[dict] = deque(maxlen=20)
        self._task: Optional[asyncio.Task] = None
        self._started_at = 0.0
        self._last_lag_ms = 0.0
        self._max_lag_ms = 0.0
        self._slow_count = 0
        self._stopping = asyncio.Event()
        self.watchdog_seconds = max(5.0, float(watchdog_seconds))
        self.watchdog_grace_seconds = max(0.0, float(watchdog_grace_seconds))
        self.watchdog_enabled = bool(watchdog_enabled)
        self._last_heartbeat_monotonic = 0.0
        self._watchdog_started_monotonic = 0.0
        self._watchdog_stop = threading.Event()
        self._watchdog_thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stopping = asyncio.Event()
        self._started_at = time.time()
        self._last_heartbeat_monotonic = time.monotonic()
        self._watchdog_started_monotonic = self._last_heartbeat_monotonic
        self._watchdog_stop.clear()
        self._task = asyncio.create_task(self._run(), name='ak-event-loop-lag-probe')
        if self.watchdog_enabled:
            self._watchdog_thread = threading.Thread(
                target=self._watchdog_loop,
                name="ak-event-loop-watchdog",
                daemon=True,
            )
            self._watchdog_thread.start()

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
            self._watchdog_stop.set()
            watchdog = self._watchdog_thread
            self._watchdog_thread = None
            if watchdog and watchdog is not threading.current_thread():
                watchdog.join(timeout=1.0)

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        next_tick = loop.time() + self.interval_seconds
        while not self._stopping.is_set():
            await asyncio.sleep(max(0.0, next_tick - loop.time()))
            now = loop.time()
            lag_ms = max(0.0, (now - next_tick) * 1000.0)
            self._last_heartbeat_monotonic = time.monotonic()
            self._record(lag_ms)
            next_tick = max(next_tick + self.interval_seconds, now + self.interval_seconds)

    def _watchdog_loop(self) -> None:
        """Terminate a process whose event loop stopped scheduling probe ticks.

        The systemd unit restarts the process after the controlled exit.  A
        separate thread is intentional: an event-loop stall is exactly the
        condition this watchdog must be able to observe.
        """
        poll_seconds = min(2.0, max(0.5, self.watchdog_seconds / 4.0))
        while not self._watchdog_stop.wait(poll_seconds):
            now = time.monotonic()
            started = self._watchdog_started_monotonic
            heartbeat = self._last_heartbeat_monotonic
            if not started or not heartbeat:
                continue
            if now - started < self.watchdog_grace_seconds:
                continue
            stalled_for = now - heartbeat
            if stalled_for <= self.watchdog_seconds:
                continue
            logger.error(
                "[EventLoopWatchdog] event loop heartbeat stalled for %.1fs; exiting for systemd restart",
                stalled_for,
            )
            os._exit(75)

    def _record(self, lag_ms: float) -> None:
        self._last_lag_ms = lag_ms
        self._max_lag_ms = max(self._max_lag_ms, lag_ms)
        self._samples.append(lag_ms)
        if lag_ms >= self.slow_ms:
            self._slow_count += 1
            self._recent_slow.append({'lag_ms': round(lag_ms, 2), 'ts': time.time()})

    def snapshot(self) -> dict:
        samples = sorted(self._samples)
        count = len(samples)

        def percentile(pct: float) -> float:
            if not samples:
                return 0.0
            index = min(count - 1, max(0, int(round((pct / 100.0) * (count - 1)))))
            return round(samples[index], 2)

        return {
            'running': bool(self._task and not self._task.done()),
            'interval_seconds': self.interval_seconds,
            'slow_ms': self.slow_ms,
            'uptime_seconds': round(time.time() - self._started_at, 2) if self._started_at else 0.0,
            'sample_count': count,
            'last_lag_ms': round(self._last_lag_ms, 2),
            'max_lag_ms': round(self._max_lag_ms, 2),
            'p50_lag_ms': percentile(50),
            'p95_lag_ms': percentile(95),
            'p99_lag_ms': percentile(99),
            'slow_count': self._slow_count,
            'recent_slow': list(self._recent_slow),
            'watchdog': {
                'enabled': self.watchdog_enabled,
                'timeout_seconds': self.watchdog_seconds,
                'grace_seconds': self.watchdog_grace_seconds,
                'heartbeat_age_seconds': round(
                    max(0.0, time.monotonic() - self._last_heartbeat_monotonic), 2
                ) if self._last_heartbeat_monotonic else None,
            },
        }


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except Exception:
        return default


_default_probe = EventLoopLagProbe(
    interval_seconds=_float_env('AK_EVENT_LOOP_PROBE_INTERVAL', 1.0),
    slow_ms=_float_env('AK_EVENT_LOOP_SLOW_MS', 250.0),
    watchdog_seconds=_float_env('AK_EVENT_LOOP_WATCHDOG_SECONDS', 30.0),
    watchdog_grace_seconds=_float_env('AK_EVENT_LOOP_WATCHDOG_GRACE_SECONDS', 180.0),
)


def start_event_loop_probe() -> None:
    _default_probe.start()


async def stop_event_loop_probe() -> None:
    await _default_probe.stop()


def get_event_loop_probe_snapshot() -> dict:
    return _default_probe.snapshot()
