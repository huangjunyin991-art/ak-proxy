import asyncio
import inspect
import time
from datetime import datetime, timezone
from typing import Awaitable, Callable, Optional

import httpx

from .collectors.health_collector import collect_health_snapshot
from .collectors.im_chat_collector import collect_chat_summary, collect_file_assets, collect_group_statistics
from .collectors.postgres_collector import collect_database_snapshot
from .collectors.system_collector import collect_system_snapshot
from .schemas import error_item, unavailable


class MonitoringService:
    def __init__(self, pool_supplier: Callable[[], object], im_server_internal_url: str = ""):
        self.pool_supplier = pool_supplier
        self.im_server_internal_url = str(im_server_internal_url or "").rstrip("/")
        self._cache = {}
        self._locks = {}
        self.light_ttl_seconds = 5
        self.heavy_ttl_seconds = 3600

    def _pool(self):
        return self.pool_supplier()

    def _lock_for(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock

    def _cache_get(self, key: str, ttl_seconds: int):
        entry = self._cache.get(key)
        if not entry:
            return None
        age = time.time() - float(entry.get("stored_at") or 0)
        if age > ttl_seconds:
            return None
        value = entry.get("value")
        if isinstance(value, dict):
            value = dict(value)
            value["cache"] = {"hit": True, "age_seconds": int(max(0, age)), "ttl_seconds": ttl_seconds}
        return value

    def _cache_any(self, key: str):
        entry = self._cache.get(key)
        if not entry:
            return None
        age = time.time() - float(entry.get("stored_at") or 0)
        value = entry.get("value")
        if isinstance(value, dict):
            value = dict(value)
            value["cache"] = {"hit": True, "age_seconds": int(max(0, age)), "ttl_seconds": entry.get("ttl_seconds", 0)}
        return value

    def _cache_set(self, key: str, value: dict, ttl_seconds: int) -> dict:
        normalized = dict(value or {})
        normalized["cache"] = {"hit": False, "age_seconds": 0, "ttl_seconds": ttl_seconds}
        self._cache[key] = {"stored_at": time.time(), "value": normalized, "ttl_seconds": ttl_seconds}
        return dict(normalized)

    def _cache_delete_prefix(self, prefix: str) -> None:
        for key in list(self._cache.keys()):
            if str(key).startswith(prefix):
                self._cache.pop(key, None)

    async def _cached(self, key: str, ttl_seconds: int, collector: Callable[[], Awaitable[dict]], force: bool = False) -> dict:
        if not force:
            cached = self._cache_get(key, ttl_seconds)
            if cached is not None:
                return cached
        async with self._lock_for(key):
            if not force:
                cached = self._cache_get(key, ttl_seconds)
                if cached is not None:
                    return cached
            value = collector()
            if inspect.isawaitable(value):
                value = await value
            return self._cache_set(key, value, ttl_seconds)

    def _mark_delayed(self, payload: dict, system_snapshot: dict) -> dict:
        result = dict(payload or {})
        result["delayed"] = True
        result["delay_reason"] = "系统负载较高，监控统计已延迟执行，当前显示缓存数据"
        result["high_load_reasons"] = list((system_snapshot or {}).get("high_load_reasons") or [])
        return result

    async def _heavy_guard(self, cache_key: str, system_snapshot: dict) -> Optional[dict]:
        if not bool((system_snapshot or {}).get("high_load")):
            return None
        cached = self._cache_any(cache_key)
        if cached is not None:
            return self._mark_delayed(cached, system_snapshot)
        payload = unavailable("monitoring", "系统负载较高，监控统计已延迟执行，暂无缓存数据")
        return self._mark_delayed(payload, system_snapshot)

    async def get_system(self, force: bool = False) -> dict:
        return await self._cached("system", self.light_ttl_seconds, collect_system_snapshot, force=force)

    async def get_health(self, force: bool = False) -> dict:
        async def collector():
            return await collect_health_snapshot(self._pool(), self.im_server_internal_url)
        return await self._cached("health", self.light_ttl_seconds, collector, force=force)

    async def get_database(self, force: bool = False) -> dict:
        system_snapshot = await self.get_system(force=False)
        cache_key = "database"
        delayed = await self._heavy_guard(cache_key, system_snapshot)
        if delayed is not None:
            return delayed
        async def collector():
            return await collect_database_snapshot(self._pool())
        return await self._cached(cache_key, self.heavy_ttl_seconds, collector, force=force)

    async def get_chat_summary(self, range_name: str = "7d", force: bool = False) -> dict:
        normalized_range = self._normalize_range(range_name)
        system_snapshot = await self.get_system(force=False)
        cache_key = f"chat_summary:{normalized_range}"
        delayed = await self._heavy_guard(cache_key, system_snapshot)
        if delayed is not None:
            return delayed
        async def collector():
            return await collect_chat_summary(self._pool(), normalized_range)
        return await self._cached(cache_key, self.heavy_ttl_seconds, collector, force=force)

    async def get_chat_groups(self, range_name: str = "7d", limit: int = 100, force: bool = False) -> dict:
        normalized_range = self._normalize_range(range_name)
        normalized_limit = min(max(int(limit or 100), 1), 200)
        system_snapshot = await self.get_system(force=False)
        cache_key = f"chat_groups:{normalized_range}:{normalized_limit}"
        delayed = await self._heavy_guard(cache_key, system_snapshot)
        if delayed is not None:
            return delayed
        async def collector():
            return await collect_group_statistics(self._pool(), normalized_range, normalized_limit)
        return await self._cached(cache_key, self.heavy_ttl_seconds, collector, force=force)

    async def get_file_assets(self, status: str = "active", limit: int = 50, force: bool = False) -> dict:
        normalized_status = str(status or "active").strip().lower()
        if normalized_status not in ("active", "expired", "missing", "all"):
            normalized_status = "active"
        normalized_limit = min(max(int(limit or 50), 1), 100)
        system_snapshot = await self.get_system(force=False)
        cache_key = f"file_assets:{normalized_status}:{normalized_limit}"
        delayed = await self._heavy_guard(cache_key, system_snapshot)
        if delayed is not None:
            return delayed
        async def collector():
            return await collect_file_assets(self._pool(), normalized_status, normalized_limit)
        return await self._cached(cache_key, self.heavy_ttl_seconds, collector, force=force)

    async def expire_file_asset(self, storage_name: str) -> dict:
        normalized_storage_name = str(storage_name or "").strip()
        if not normalized_storage_name:
            return {"success": False, "message": "storage_name 不能为空"}
        if not self.im_server_internal_url:
            return {"success": False, "message": "未配置 IM 服务地址"}
        async with httpx.AsyncClient(timeout=8.0, trust_env=False) as client:
            response = await client.post(
                f"{self.im_server_internal_url}/im/internal/file_assets/expire",
                json={"storage_name": normalized_storage_name},
            )
        try:
            body = response.json()
        except Exception:
            body = {"error": True, "message": response.text[:300] or "IM 服务响应无效"}
        if response.status_code >= 400 or body.get("error"):
            return {"success": False, "message": str(body.get("message") or "IM 服务释放文件失败")[:300]}
        self._cache_delete_prefix("file_assets:")
        self._cache_delete_prefix("chat_summary:")
        self._cache_delete_prefix("chat_groups:")
        return {
            "success": True,
            "message": "文件已标记为失效并释放物理文件",
            "item": body,
        }

    async def get_overview(self, range_name: str = "7d", force: bool = False) -> dict:
        partial_errors = []
        system = await self.get_system(force=False)
        health = await self.get_health(force=False)
        try:
            database = await self.get_database(force=force)
        except Exception as exc:
            database = unavailable("database", str(exc))
            partial_errors.append(error_item("database", str(exc)))
        try:
            chat = await self.get_chat_summary(range_name, force=force)
        except Exception as exc:
            chat = unavailable("chat", str(exc))
            partial_errors.append(error_item("chat", str(exc)))
        return {
            "success": True,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "partial_errors": partial_errors,
            "system": system,
            "health": health,
            "database": database,
            "chat": chat,
            "policy": {
                "light_refresh_seconds": self.light_ttl_seconds,
                "heavy_refresh_seconds": self.heavy_ttl_seconds,
                "business_priority": True,
            },
        }

    @staticmethod
    def _normalize_range(range_name: str) -> str:
        value = str(range_name or "7d").strip().lower()
        if value in ("24h", "7d", "30d"):
            return value
        return "7d"
