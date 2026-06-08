import asyncio
import time
from typing import Optional

from .browser_policy import StaticResourceBrowserPolicy
from .config import StaticResourceCacheConfig
from .key_builder import StaticResourceCacheKeyBuilder
from .memory_cache import StaticResourceMemoryCache
from .memory_policy import StaticResourceMemoryPolicy
from .models import CachedStaticResource, StaticResourcePayload, StaticResourceRequest
from .policy import StaticResourceCachePolicy
from .store import DiskStaticResourceCacheStore


_BROWSER_POLICY_KEYS = {
    'js_browser_max_age_seconds',
    'css_browser_max_age_seconds',
    'media_browser_max_age_seconds',
    'js_disk_ttl_seconds',
    'css_disk_ttl_seconds',
    'media_disk_ttl_seconds',
    'stale_while_revalidate_seconds',
}

_MEMORY_POLICY_KEYS = {
    'memory_enabled',
    'memory_stats_enabled',
    'memory_max_entries',
    'memory_max_bytes',
    'memory_max_body_bytes',
}


class StaticResourceCacheService:
    def __init__(self, config: StaticResourceCacheConfig, policy: StaticResourceCachePolicy,
                 key_builder: StaticResourceCacheKeyBuilder, store: DiskStaticResourceCacheStore,
                 memory_cache: Optional[StaticResourceMemoryCache] = None):
        self.config = config
        self.policy = policy
        self.key_builder = key_builder
        self.store = store
        self.memory_policy = StaticResourceMemoryPolicy(config.root_dir, config)
        self.memory_cache = memory_cache or StaticResourceMemoryCache(
            self.memory_policy.snapshot().max_entries,
            self.memory_policy.snapshot().max_bytes,
            self.memory_policy.snapshot().max_body_bytes,
            self.memory_policy.snapshot().enabled,
            self.memory_policy.snapshot().stats_enabled,
        )
        self.memory_cache.update_policy(self.memory_policy.to_dict())
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
        cache_key = self.cache_key(request)
        cached = self.memory_cache.get(cache_key)
        if cached is not None:
            return cached
        try:
            cached = await self.store.get(cache_key)
            if cached is not None:
                self.memory_cache.set(cache_key, cached)
            return cached
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
            self.memory_cache.set(cache_key, resource)
            return True
        except Exception:
            return False

    async def cleanup_expired(self) -> int:
        self.memory_cache.cleanup_expired()
        try:
            return await self.store.cleanup_expired()
        except Exception:
            return 0

    async def describe_entries(self, limit: int = 80) -> dict:
        now = time.time()
        try:
            entries = await self.store.list_entries(limit)
        except Exception:
            entries = []
        fresh = 0
        expired = 0
        total_bytes = 0
        items = []
        for entry in entries:
            cache_key = str(entry.get('cache_key') or '')
            expires_at = float(entry.get('expires_at') or 0)
            is_fresh = expires_at > now
            if is_fresh:
                fresh += 1
            else:
                expired += 1
            body_size = int(entry.get('body_size') or 0)
            total_bytes += max(0, body_size)
            items.append({
                **entry,
                'fresh': is_fresh,
                'memory': self.memory_cache.contains(cache_key) if cache_key else False,
                'ttl_seconds': max(0, int(expires_at - now)) if is_fresh else 0,
            })
        return {
            'items': items,
            'summary': {
                'count': len(items),
                'fresh': fresh,
                'expired': expired,
                'bytes': total_bytes,
                'limit': max(1, min(int(limit or 80), 500)),
                'generated_at': now,
            },
        }

    def snapshot(self) -> dict:
        return {
            "lock_count": len(self._locks),
            "last_lock_cleanup": dict(self._last_lock_cleanup),
            "memory_policy": self.memory_policy.to_dict(),
            "memory_cache": self.memory_cache.snapshot(),
            "browser_policy": self.get_browser_policy(),
        }

    def get_browser_policy(self) -> dict:
        result = self.browser_policy.to_dict()
        result['memory_policy'] = self.memory_policy.to_dict()
        result['memory_cache'] = self.memory_cache.snapshot()
        return result

    def update_browser_policy(self, values: dict) -> dict:
        payload = values or {}
        if any(key in payload for key in _BROWSER_POLICY_KEYS):
            self.browser_policy.update(payload)
        if any(key in payload for key in _MEMORY_POLICY_KEYS):
            self.memory_policy.update(payload)
            self.memory_cache.update_policy(self.memory_policy.to_dict())
        return self.get_browser_policy()

    def refresh_upstream_version(self) -> dict:
        self.browser_policy.refresh_version()
        removed = self.browser_policy.clear_storage()
        memory_removed = self.memory_cache.clear()
        result = self.get_browser_policy()
        result['removed_entries'] = removed
        result['removed_memory_entries'] = memory_removed
        return result

    def version_url(self, url: str) -> str:
        return self.browser_policy.version_url(url)


def create_static_resource_cache_service(config: StaticResourceCacheConfig) -> StaticResourceCacheService:
    key_builder = StaticResourceCacheKeyBuilder()
    policy = StaticResourceCachePolicy(config)
    store = DiskStaticResourceCacheStore(config, key_builder)
    memory_cache = StaticResourceMemoryCache(
        config.memory_max_entries,
        config.memory_max_bytes,
        config.memory_max_body_bytes,
        config.memory_enabled,
        config.memory_stats_enabled,
    )
    return StaticResourceCacheService(config, policy, key_builder, store, memory_cache)
