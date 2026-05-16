import asyncio
import time
from typing import Awaitable, Callable, Optional, TypeVar


T = TypeVar('T')


class TimedServiceStatusCache:
    def __init__(self, loader: Callable[[], Awaitable[T]], ttl_seconds: float = 3.0,
                 fallback: Optional[Callable[[], T]] = None, clock: Callable[[], float] = time.time):
        self._loader = loader
        self._ttl_seconds = max(0.1, float(ttl_seconds))
        self._fallback = fallback
        self._clock = clock
        self._lock = asyncio.Lock()
        self._cached: Optional[T] = None
        self._loaded_at = 0.0

    async def get(self, force_refresh: bool = False) -> T:
        if not force_refresh and self._is_fresh():
            return self._cached
        async with self._lock:
            if not force_refresh and self._is_fresh():
                return self._cached
            try:
                value = await self._loader()
            except Exception:
                if self._cached is not None:
                    return self._cached
                if self._fallback is not None:
                    return self._fallback()
                raise
            self._cached = value
            self._loaded_at = self._clock()
            return value

    def invalidate(self) -> None:
        self._cached = None
        self._loaded_at = 0.0

    def _is_fresh(self) -> bool:
        return self._cached is not None and self._clock() - self._loaded_at < self._ttl_seconds
