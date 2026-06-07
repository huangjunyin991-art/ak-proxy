import asyncio
import time
from typing import Optional

from .browser_policy import StaticResourceBrowserPolicy
from .config import StaticResourceCacheConfig
from .key_builder import StaticResourceCacheKeyBuilder
from .models import CachedStaticResource, StaticResourcePayload, StaticResourceRequest
from .policy import StaticResourceCachePolicy
from .store import DiskStaticResourceCacheStore


class StaticResourceCacheService:
    def __init__(self, config: StaticResourceCacheConfig, policy: StaticResourceCachePolicy,
                 key_builder: StaticResourceCacheKeyBuilder, store: DiskStaticResourceCacheStore):
        self.config = config
        self.policy = policy
        self.key_builder = key_builder
        self.store = store
        self.browser_policy = StaticResourceBrowserPolicy(config.root_dir)
        self._locks: dict[str, asyncio.Lock] = {}
        self._last_lock_cleanup = {"removed": 0, "remaining": 0, "ts": 0.0}

    def can_read(self, request: StaticResourceRequest) -> bool:
        return self.policy.can_read(request)

    def cache_key(self, request: StaticResourceRequest) -> str:
        return self.key_builder.build(request.namespace, request.url)

    async def get(self, request: StaticResourceRequest) -> Optional[CachedStaticResource]:
        if not self.policy.can_read(request):
            return None
        try:
            return await self.store.get(self.cache_key(request))
        except Exception:
            return None

    async def get_or_lock(self, request: StaticResourceRequest):
        cache_key = self.cache_key(request)
        lock = self._locks.get(cache_key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[cache_key] = lock
        return lock

    def release_lock(self, request: StaticResourceRequest, lock: asyncio.Lock | None) -> None:
        if lock is None:
            return
        try:
            if lock.locked():
                lock.release()
        except RuntimeError:
            pass
        self.drop_idle_lock(request, lock)

    def drop_idle_lock(self, request: StaticResourceRequest, lock: asyncio.Lock | None = None) -> bool:
        try:
            cache_key = self.cache_key(request)
            current = self._locks.get(cache_key)
            target = lock or current
            if not target or current is not target or target.locked():
                return False
            self._locks.pop(cache_key, None)
            return True
        except Exception:
            return False

    def cleanup_idle_locks(self) -> int:
        removed = 0
        try:
            for cache_key, lock in list(self._locks.items()):
                if lock.locked():
                    continue
                self._locks.pop(cache_key, None)
                removed += 1
        except Exception:
            pass
        self._last_lock_cleanup = {
            "removed": removed,
            "remaining": len(self._locks),
            "ts": time.time(),
        }
        return removed

    async def store_payload(self, request: StaticResourceRequest, payload: StaticResourcePayload) -> bool:
        if not self.policy.can_store(request, payload):
            return False
        try:
            now = time.time()
            cache_key = self.cache_key(request)
            resource = CachedStaticResource(
                cache_key=cache_key,
                path=request.path,
                status_code=int(payload.status_code),
                headers=dict(payload.headers or {}),
                content_type=payload.content_type or 'application/octet-stream',
                body=payload.body or b'',
                created_at=now,
                expires_at=now + self.browser_policy.disk_ttl_seconds(request.path, payload.content_type),
            )
            await self.store.set(cache_key, resource)
            return True
        except Exception:
            return False

    async def cleanup_expired(self) -> int:
        try:
            return await self.store.cleanup_expired()
        except Exception:
            return 0

    def snapshot(self) -> dict:
        return {
            "lock_count": len(self._locks),
            "last_lock_cleanup": dict(self._last_lock_cleanup),
            "browser_policy": self.get_browser_policy(),
        }

    def get_browser_policy(self) -> dict:
        return self.browser_policy.to_dict()

    def update_browser_policy(self, values: dict) -> dict:
        self.browser_policy.update(values or {})
        return self.browser_policy.to_dict()

    def refresh_upstream_version(self) -> dict:
        self.browser_policy.refresh_version()
        removed = self.browser_policy.clear_storage()
        result = self.browser_policy.to_dict()
        result['removed_entries'] = removed
        return result

    def version_url(self, url: str) -> str:
        return self.browser_policy.version_url(url)


def create_static_resource_cache_service(config: StaticResourceCacheConfig) -> StaticResourceCacheService:
    key_builder = StaticResourceCacheKeyBuilder()
    policy = StaticResourceCachePolicy(config)
    store = DiskStaticResourceCacheStore(config, key_builder)
    return StaticResourceCacheService(config, policy, key_builder, store)
