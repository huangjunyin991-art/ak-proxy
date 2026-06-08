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
from .guard import GuardError, validate_limit, validate_range
from .schemas import error_item, unavailable
from .snapshot_policy import MonitoringSnapshotPolicy, MonitoringSnapshotPolicyStore
from ..ws_ticket import WsTicketDiagnosticsPolicyStore, collect_ws_ticket_diagnostics


class MonitoringService:
    def __init__(self, pool_supplier: Callable[[], object], im_server_internal_url: str = "", system_config=None, logger=None):
        self.pool_supplier = pool_supplier
        self.im_server_internal_url = str(im_server_internal_url or "").rstrip("/")
        self._cache = {}
        self._locks = {}
        self.ws_ticket_policy = WsTicketDiagnosticsPolicyStore(pool_supplier)
        self._logger = logger
        self._snapshot_policy_store = MonitoringSnapshotPolicyStore(system_config, logger=logger)
        self._snapshot_policy = MonitoringSnapshotPolicy()
        self.light_ttl_seconds = self._snapshot_policy.light_ttl_seconds
        self.heavy_ttl_seconds = self._snapshot_policy.heavy_ttl_seconds
        self.high_load_skip = self._snapshot_policy.high_load_skip
        self._background_task = None
        self._background_started_at = 0.0
        self._background_last_run_at = 0.0
        self._background_next_run_at = 0.0
        self._background_last_duration_ms = 0
        self._background_last_error = ""
        self._background_last_items = []

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
        await self.refresh_snapshot_policy()
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
        if not self.high_load_skip or not bool((system_snapshot or {}).get("high_load")):
            return None
        cached = self._cache_any(cache_key)
        if cached is not None:
            return self._mark_delayed(cached, system_snapshot)
        payload = unavailable("monitoring", "系统负载较高，监控统计已延迟执行，暂无缓存数据")
        return self._mark_delayed(payload, system_snapshot)

    async def refresh_snapshot_policy(self, force: bool = False) -> dict:
        payload = await self._snapshot_policy_store.refresh_policy(force=force)
        await self._apply_snapshot_policy(MonitoringSnapshotPolicy.from_mapping(payload))
        return self._snapshot_policy.to_dict()

    async def update_snapshot_policy(self, payload: dict) -> dict:
        saved = await self._snapshot_policy_store.set_policy_payload(payload or {})
        await self._apply_snapshot_policy(MonitoringSnapshotPolicy.from_mapping(saved))
        return await self.get_snapshot_policy(force=True)

    async def get_snapshot_policy(self, force: bool = False) -> dict:
        await self.refresh_snapshot_policy(force=force)
        return {
            "policy": self._snapshot_policy.to_dict(),
            "runtime": self._snapshot_runtime(),
        }

    async def _apply_snapshot_policy(self, policy: MonitoringSnapshotPolicy) -> None:
        changed = policy != self._snapshot_policy
        self._snapshot_policy = policy
        self.light_ttl_seconds = policy.light_ttl_seconds
        self.heavy_ttl_seconds = policy.heavy_ttl_seconds
        self.high_load_skip = policy.high_load_skip
        if policy.background_enabled:
            self._ensure_background_task()
        elif changed:
            self._stop_background_task()

    def _ensure_background_task(self) -> None:
        if self._background_task is not None and not self._background_task.done():
            return
        try:
            self._background_started_at = time.time()
            self._background_task = asyncio.create_task(self._background_loop(), name="ak-monitoring-snapshot-refresh")
        except RuntimeError:
            self._background_task = None

    def _stop_background_task(self) -> None:
        task = self._background_task
        self._background_task = None
        self._background_next_run_at = 0.0
        if task is not None and not task.done():
            task.cancel()

    def _snapshot_runtime(self) -> dict:
        task = self._background_task
        return {
            "cache_keys": len(self._cache),
            "background_running": bool(task is not None and not task.done()),
            "background_started_at": self._iso_from_ts(self._background_started_at),
            "last_background_run_at": self._iso_from_ts(self._background_last_run_at),
            "next_background_run_at": self._iso_from_ts(self._background_next_run_at),
            "last_background_duration_ms": int(self._background_last_duration_ms or 0),
            "last_background_error": self._background_last_error,
            "last_background_items": list(self._background_last_items or []),
        }

    async def _background_loop(self) -> None:
        try:
            while True:
                await self.refresh_snapshot_policy()
                if not self._snapshot_policy.background_enabled:
                    return
                started = time.perf_counter()
                self._background_last_error = ""
                self._background_last_items = []
                try:
                    items = await self.refresh_heavy_snapshots(force=True)
                    self._background_last_items = list(items)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self._background_last_error = str(exc)[:300]
                    if self._logger:
                        self._logger.warning("[MonitoringSnapshot] background refresh failed: %s", exc)
                self._background_last_run_at = time.time()
                self._background_last_duration_ms = int(max(0, (time.perf_counter() - started) * 1000))
                sleep_seconds = max(60, int(self.heavy_ttl_seconds or 3600))
                self._background_next_run_at = time.time() + sleep_seconds
                await asyncio.sleep(sleep_seconds)
        except asyncio.CancelledError:
            return

    async def refresh_heavy_snapshots(self, force: bool = False) -> list[str]:
        await self.refresh_snapshot_policy()
        refreshed = []
        tasks = [("database", self.get_database(force=force))]
        for range_name in ("24h", "7d", "30d"):
            tasks.append((f"chat_summary:{range_name}", self.get_chat_summary(range_name, force=force)))
            tasks.append((f"chat_groups:{range_name}:100", self.get_chat_groups(range_name, 100, force=force)))
        tasks.append(("file_assets:active:50", self.get_file_assets("active", 50, force=force)))
        for name, task in tasks:
            try:
                await task
                refreshed.append(name)
            except Exception as exc:
                if self._logger:
                    self._logger.warning("[MonitoringSnapshot] refresh %s failed: %s", name, exc)
        return refreshed

    @staticmethod
    def _iso_from_ts(value: float) -> str:
        if not value:
            return ""
        return datetime.fromtimestamp(float(value), timezone.utc).isoformat()

    async def get_system(self, force: bool = False) -> dict:
        return await self._cached("system", self.light_ttl_seconds, collect_system_snapshot, force=force)

    async def get_health(self, force: bool = False) -> dict:
        async def collector():
            return await collect_health_snapshot(self._pool(), self.im_server_internal_url)
        return await self._cached("health", self.light_ttl_seconds, collector, force=force)

    async def get_ws_tickets(self, force: bool = False) -> dict:
        async def collector():
            return await collect_ws_ticket_diagnostics(self._pool, self.ws_ticket_policy)
        return await self._cached("ws_tickets", self.light_ttl_seconds, collector, force=force)

    async def get_ws_ticket_policy(self) -> dict:
        return await self.ws_ticket_policy.get_policy(force=True)

    async def update_ws_ticket_policy(self, payload: dict) -> dict:
        await self.ws_ticket_policy.set_policy(payload or {})
        self._cache.pop("ws_tickets", None)
        return await self.get_ws_tickets(force=True)

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
        normalized_range = validate_range(range_name)
        system_snapshot = await self.get_system(force=False)
        cache_key = f"chat_summary:{normalized_range}"
        delayed = await self._heavy_guard(cache_key, system_snapshot)
        if delayed is not None:
            return delayed
        async def collector():
            return await collect_chat_summary(self._pool(), normalized_range)
        return await self._cached(cache_key, self.heavy_ttl_seconds, collector, force=force)

    async def get_chat_groups(self, range_name: str = "7d", limit: int = 100, force: bool = False) -> dict:
        normalized_range = validate_range(range_name)
        normalized_limit = validate_limit("groups", limit)
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
        normalized_limit = validate_limit("file_assets", limit)
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
        health_result, database_result, chat_result = await asyncio.gather(
            self.get_health(force=False),
            self.get_database(force=force),
            self.get_chat_summary(range_name, force=force),
            return_exceptions=True,
        )
        if isinstance(health_result, Exception):
            health = unavailable("health", str(health_result))
            partial_errors.append(error_item("health", str(health_result)))
        else:
            health = health_result
        if isinstance(database_result, Exception):
            database = unavailable("database", str(database_result))
            partial_errors.append(error_item("database", str(database_result)))
        else:
            database = database_result
        if isinstance(chat_result, Exception):
            chat = unavailable("chat", str(chat_result))
            partial_errors.append(error_item("chat", str(chat_result)))
        else:
            chat = chat_result
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
                "heavy_refresh_minutes": int(self.heavy_ttl_seconds / 60),
                "background_enabled": self._snapshot_policy.background_enabled,
                "high_load_skip": self.high_load_skip,
                "business_priority": True,
            },
        }

    @staticmethod
    def _normalize_range(range_name: str) -> str:
        value = str(range_name or "7d").strip().lower()
        if value in ("24h", "7d", "30d"):
            return value
        return "7d"
