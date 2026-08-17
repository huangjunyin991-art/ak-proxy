import asyncio
import threading
import time


class _Bucket:
    __slots__ = ('timestamps', 'lock')

    def __init__(self):
        self.timestamps = []
        self.lock = asyncio.Lock()


class PerSecondRateLimiter:
    def __init__(self):
        self._buckets = {}
        self._buckets_lock = asyncio.Lock()

    async def wait(self, key: str, rate_per_second: float) -> float:
        rate = float(rate_per_second or 0)
        if rate <= 0:
            return 0.0
        bucket = await self._get_bucket(str(key or 'default'), rate)
        waited = 0.0
        while True:
            async with bucket.lock:
                now = time.monotonic()
                cutoff = now - 1.0
                bucket.timestamps = [t for t in bucket.timestamps if t > cutoff]
                limit = max(1, int(rate))
                if len(bucket.timestamps) < limit:
                    bucket.timestamps.append(now)
                    return waited
                wait_seconds = max(0.001, min(bucket.timestamps) + 1.0 - now)
            await asyncio.sleep(wait_seconds)
            waited += wait_seconds

    async def _get_bucket(self, key: str, rate: float):
        bucket = self._buckets.get(key)
        if bucket is not None:
            return bucket
        async with self._buckets_lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = _Bucket()
                self._buckets[key] = bucket
            return bucket


class DynamicExitPacer:
    """Atomically pace each exit without queuing requests behind that exit.

    A node selected for a request is unavailable until its configured interval
    has elapsed. The dispatcher can therefore choose another ready node rather
    than accumulating a per-node coroutine queue.
    """

    def __init__(self) -> None:
        self._next_available: dict[str, float] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _interval_seconds(rate_per_second: float) -> float:
        try:
            rate = float(rate_per_second or 0)
        except (TypeError, ValueError):
            rate = 0.0
        return 0.0 if rate <= 0 else 1.0 / rate

    def is_available(self, key: str, rate_per_second: float) -> bool:
        interval = self._interval_seconds(rate_per_second)
        if interval <= 0:
            return True
        now = time.monotonic()
        with self._lock:
            return self._next_available.get(str(key or "default"), 0.0) <= now

    def try_reserve(self, key: str, rate_per_second: float) -> bool:
        interval = self._interval_seconds(rate_per_second)
        if interval <= 0:
            return True
        now = time.monotonic()
        normalized_key = str(key or "default")
        with self._lock:
            if self._next_available.get(normalized_key, 0.0) > now:
                return False
            self._next_available[normalized_key] = now + interval
            return True

    def cooldown_seconds(self, key: str) -> float:
        now = time.monotonic()
        with self._lock:
            return max(0.0, self._next_available.get(str(key or "default"), 0.0) - now)
