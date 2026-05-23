from typing import Any, Awaitable, Callable

from .ttl_cache import AsyncTTLCache, CacheResult


class AdminStatsCache:
    def __init__(
        self,
        stats_loader: Callable[[], Awaitable[dict[str, Any]]],
        dashboard_loader: Callable[[], Awaitable[dict[str, Any]]],
        stats_ttl_seconds: float = 15.0,
        dashboard_ttl_seconds: float = 30.0,
    ):
        self._stats_cache = AsyncTTLCache(stats_loader, stats_ttl_seconds, stats_ttl_seconds * 4, refresh_stale_in_background=True)
        self._dashboard_cache = AsyncTTLCache(dashboard_loader, dashboard_ttl_seconds, dashboard_ttl_seconds * 4, refresh_stale_in_background=True)

    async def get_stats_result(self, force_refresh: bool = False) -> CacheResult:
        return await self._stats_cache.get_result(force_refresh=force_refresh)

    async def get_dashboard_result(self, force_refresh: bool = False) -> CacheResult:
        return await self._dashboard_cache.get_result(force_refresh=force_refresh)

    async def get_stats(self, force_refresh: bool = False) -> dict[str, Any]:
        return await self._stats_cache.get(force_refresh=force_refresh)

    async def get_dashboard(self, force_refresh: bool = False) -> dict[str, Any]:
        return await self._dashboard_cache.get(force_refresh=force_refresh)

    def invalidate_stats(self) -> None:
        self._stats_cache.invalidate()

    def invalidate_dashboard(self) -> None:
        self._dashboard_cache.invalidate()

    def invalidate_all(self) -> None:
        self.invalidate_stats()
        self.invalidate_dashboard()
