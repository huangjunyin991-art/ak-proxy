from __future__ import annotations

import time
from collections import deque
from typing import Callable, Iterable


class _RollingCounter:
    """Small per-second counter used only for bounded recent windows."""

    def __init__(self, retention_seconds: int) -> None:
        self.retention_seconds = max(1, int(retention_seconds))
        self._buckets: deque[tuple[int, int]] = deque()

    def record(self, now: float) -> None:
        second = int(now)
        if self._buckets and self._buckets[-1][0] == second:
            bucket_second, count = self._buckets[-1]
            self._buckets[-1] = (bucket_second, count + 1)
        else:
            self._buckets.append((second, 1))
        self._prune(now)

    def count(self, window_seconds: float, now: float) -> int:
        self._prune(now)
        cutoff = now - max(0.0, float(window_seconds))
        return sum(count for second, count in self._buckets if second + 1 > cutoff)

    def dump(self, now: float) -> list[list[int]]:
        self._prune(now)
        return [[second, count] for second, count in self._buckets]

    def restore(self, buckets: Iterable, now: float) -> None:
        restored: dict[int, int] = {}
        cutoff = now - self.retention_seconds
        for item in buckets or ():
            try:
                second, count = item
                second = int(second)
                count = int(count)
            except (TypeError, ValueError):
                continue
            if count > 0 and second + 1 > cutoff and second <= int(now) + 1:
                restored[second] = restored.get(second, 0) + count
        self._buckets = deque(sorted(restored.items()))
        self._prune(now)

    def _prune(self, now: float) -> None:
        cutoff = now - self.retention_seconds
        while self._buckets and self._buckets[0][0] + 1 <= cutoff:
            self._buckets.popleft()


class RateLimitFeedback:
    """Bounded, time-decaying feedback for upstream HTTP 429 responses.

    Scheduling reads are constant time. Rolling counters are maintained only
    for status reporting and are bounded to one bucket per second.
    """

    DEFAULT_RECOVERY_SECONDS = 60.0
    HISTORY_SECONDS = 300

    def __init__(
        self,
        recovery_seconds: float = DEFAULT_RECOVERY_SECONDS,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.recovery_seconds = max(1.0, float(recovery_seconds))
        self._clock = clock or time.time
        self._last_429_at = 0.0
        self._requests = _RollingCounter(self.HISTORY_SECONDS)
        self._responses_429 = _RollingCounter(self.HISTORY_SECONDS)

    def record_request(self, now: float | None = None) -> None:
        self._requests.record(self._now(now))

    def record_429(self, now: float | None = None) -> None:
        current = self._now(now)
        self._last_429_at = current
        self._responses_429.record(current)

    def scheduling_state(self, now: float | None = None) -> tuple[int, float]:
        """Return the risk tier and capacity weight used by schedulers."""
        current = self._now(now)
        if self._last_429_at <= 0:
            return 0, 1.0
        age = max(0.0, current - self._last_429_at)
        if age >= self.recovery_seconds:
            return 0, 1.0
        return 1, max(0.05, min(1.0, age / self.recovery_seconds))

    def is_active(self, now: float | None = None) -> bool:
        current = self._now(now)
        return self._last_429_at > 0 and current - self._last_429_at < self.recovery_seconds

    def recovery_weight(self, now: float | None = None) -> float:
        current = self._now(now)
        if not self.is_active(current):
            return 1.0
        age = max(0.0, current - self._last_429_at)
        return min(1.0, age / self.recovery_seconds)

    def status(self, now: float | None = None) -> dict[str, object]:
        current = self._now(now)
        active = self.is_active(current)
        age = max(0.0, current - self._last_429_at) if self._last_429_at > 0 else None
        remaining = max(0.0, self.recovery_seconds - (age or 0.0)) if active else 0.0
        return {
            "active": active,
            "weight": round(self.scheduling_state(current)[1], 3),
            "recovery_seconds": self.recovery_seconds,
            "recovery_remaining": round(remaining, 1),
            "last_429_at": self._last_429_at or None,
            "last_429_seconds_ago": round(age, 1) if age is not None else None,
            "requests_1m": self._requests.count(60.0, current),
            "requests_5m": self._requests.count(300.0, current),
            "responses_429_1m": self._responses_429.count(60.0, current),
            "responses_429_5m": self._responses_429.count(300.0, current),
        }

    def dump_state(self, now: float | None = None) -> dict[str, object]:
        current = self._now(now)
        return {
            "last_429_at": self._last_429_at,
            "request_buckets": self._requests.dump(current),
            "response_429_buckets": self._responses_429.dump(current),
        }

    def restore_state(self, state: object, now: float | None = None) -> None:
        if not isinstance(state, dict):
            return
        current = self._now(now)
        try:
            last_429_at = float(state.get("last_429_at") or 0.0)
        except (TypeError, ValueError):
            last_429_at = 0.0
        if last_429_at > current + 1 or current - last_429_at >= self.HISTORY_SECONDS:
            last_429_at = 0.0
        self._last_429_at = max(0.0, last_429_at)
        self._requests.restore(state.get("request_buckets") or (), current)
        self._responses_429.restore(state.get("response_429_buckets") or (), current)

    def copy_from(self, other: object, now: float | None = None) -> None:
        dump_state = getattr(other, "dump_state", None)
        if callable(dump_state):
            self.restore_state(dump_state(now), now)

    def _now(self, value: float | None) -> float:
        return float(self._clock() if value is None else value)
