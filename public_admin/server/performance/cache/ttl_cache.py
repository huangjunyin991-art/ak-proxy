import asyncio
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional


@dataclass
class CacheResult:
    value: Any
    hit: bool
    stale: bool = False


class AsyncTTLCache:
    def __init__(self, loader: Callable[[], Awaitable[Any]], ttl_seconds: float, stale_seconds: Optional[float] = None):
        self._loader = loader
        self._ttl_seconds = max(0.0, float(ttl_seconds))
        self._stale_seconds = max(self._ttl_seconds, float(stale_seconds if stale_seconds is not None else ttl_seconds * 4))
        self._lock = asyncio.Lock()
        self._value: Any = None
        self._loaded_at = 0.0
        self._has_value = False

    def invalidate(self) -> None:
        self._loaded_at = 0.0

    def _age(self, now: float) -> float:
        if not self._has_value:
            return float("inf")
        return max(0.0, now - self._loaded_at)

    async def get_result(self, force_refresh: bool = False) -> CacheResult:
        now = time.monotonic()
        if not force_refresh and self._has_value and self._age(now) <= self._ttl_seconds:
            return CacheResult(self._value, hit=True)

        async with self._lock:
            now = time.monotonic()
            if not force_refresh and self._has_value and self._age(now) <= self._ttl_seconds:
                return CacheResult(self._value, hit=True)
            try:
                value = await self._loader()
            except Exception:
                if self._has_value and self._age(now) <= self._stale_seconds:
                    return CacheResult(self._value, hit=True, stale=True)
                raise
            self._value = value
            self._loaded_at = time.monotonic()
            self._has_value = True
            return CacheResult(value, hit=False)

    async def get(self, force_refresh: bool = False) -> Any:
        result = await self.get_result(force_refresh=force_refresh)
        return result.value
