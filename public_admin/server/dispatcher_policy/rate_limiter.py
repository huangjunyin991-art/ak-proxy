import asyncio
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
