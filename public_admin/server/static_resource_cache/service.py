import asyncio
import time
from typing import Optional

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
        self._locks: dict[str, asyncio.Lock] = {}

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

    async def store_payload(self, request: StaticResourceRequest, payload: StaticResourcePayload) -> bool:
        if not self.policy.can_store(request, payload):
            return False
        try:
            now = time.time()
            cache_key = self.cache_key(request)
            resource = CachedStaticResource(
                cache_key=cache_key,
                status_code=int(payload.status_code),
                headers=dict(payload.headers or {}),
                content_type=payload.content_type or 'application/octet-stream',
                body=payload.body or b'',
                created_at=now,
                expires_at=now + self.config.ttl_seconds,
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


def create_static_resource_cache_service(config: StaticResourceCacheConfig) -> StaticResourceCacheService:
    key_builder = StaticResourceCacheKeyBuilder()
    policy = StaticResourceCachePolicy(config)
    store = DiskStaticResourceCacheStore(config, key_builder)
    return StaticResourceCacheService(config, policy, key_builder, store)
