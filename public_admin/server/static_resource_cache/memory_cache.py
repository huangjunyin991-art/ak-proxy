import time
from collections import OrderedDict
from typing import Optional

from .models import CachedStaticResource


class StaticResourceMemoryCache:
    def __init__(self, max_entries: int, max_bytes: int, max_body_bytes: int,
                 enabled: bool = True, stats_enabled: bool = True):
        self._enabled = bool(enabled)
        self._stats_enabled = bool(stats_enabled)
        self.max_entries = max(0, int(max_entries or 0))
        self.max_bytes = max(0, int(max_bytes or 0))
        self.max_body_bytes = max(0, int(max_body_bytes or 0))
        self._items: OrderedDict[str, CachedStaticResource] = OrderedDict()
        self._bytes = 0
        self._hits = 0
        self._misses = 0
        self._writes = 0
        self._evictions = 0
        self._expired = 0
        self._rejected = 0

    @property
    def enabled(self) -> bool:
        return self._enabled and self.max_entries > 0 and self.max_bytes > 0 and self.max_body_bytes > 0

    @property
    def stats_enabled(self) -> bool:
        return self._stats_enabled

    def update_policy(self, values: dict) -> None:
        was_enabled = self.enabled
        self._enabled = bool(values.get('enabled', self._enabled))
        self._stats_enabled = bool(values.get('stats_enabled', self._stats_enabled))
        self.max_entries = max(0, int(values.get('max_entries', self.max_entries) or 0))
        self.max_bytes = max(0, int(values.get('max_bytes', self.max_bytes) or 0))
        self.max_body_bytes = max(0, int(values.get('max_body_bytes', self.max_body_bytes) or 0))
        if not self.enabled:
            self.clear()
            return
        if was_enabled:
            self._evict_until_within_limits()

    def get(self, cache_key: str) -> Optional[CachedStaticResource]:
        if not self.enabled:
            return None
        resource = self._items.get(cache_key)
        if resource is None:
            self._count('_misses')
            return None
        if time.time() >= float(resource.expires_at or 0):
            self._drop(cache_key)
            self._count('_expired')
            self._count('_misses')
            return None
        self._items.move_to_end(cache_key)
        self._count('_hits')
        return resource

    def set(self, cache_key: str, resource: CachedStaticResource) -> bool:
        if not self.enabled:
            return False
        body_size = self._body_size(resource)
        if body_size <= 0 or body_size > self.max_body_bytes or body_size > self.max_bytes:
            self.delete(cache_key)
            self._count('_rejected')
            return False

        self._drop(cache_key)
        self._items[cache_key] = resource
        self._bytes += body_size
        self._count('_writes')
        self._evict_until_within_limits()
        return cache_key in self._items

    def delete(self, cache_key: str) -> bool:
        return self._drop(cache_key)

    def clear(self) -> int:
        removed = len(self._items)
        self._items.clear()
        self._bytes = 0
        return removed

    def cleanup_expired(self) -> int:
        now = time.time()
        removed = 0
        for cache_key, resource in list(self._items.items()):
            if now < float(resource.expires_at or 0):
                continue
            if self._drop(cache_key):
                removed += 1
        self._count('_expired', removed)
        return removed

    def snapshot(self) -> dict:
        lookups = self._hits + self._misses
        return {
            "enabled": self.enabled,
            "stats_enabled": self.stats_enabled,
            "entries": len(self._items),
            "max_entries": self.max_entries,
            "bytes": self._bytes,
            "max_bytes": self.max_bytes,
            "max_body_bytes": self.max_body_bytes,
            "hits": self._hits,
            "misses": self._misses,
            "hit_ratio_pct": round((self._hits / lookups) * 100, 1) if lookups else 0.0,
            "writes": self._writes,
            "evictions": self._evictions,
            "expired": self._expired,
            "rejected": self._rejected,
        }

    def _evict_until_within_limits(self) -> None:
        while self._items and (len(self._items) > self.max_entries or self._bytes > self.max_bytes):
            cache_key, _ = next(iter(self._items.items()))
            if self._drop(cache_key):
                self._count('_evictions')

    def _drop(self, cache_key: str) -> bool:
        resource = self._items.pop(cache_key, None)
        if resource is None:
            return False
        self._bytes = max(0, self._bytes - self._body_size(resource))
        return True

    def _body_size(self, resource: CachedStaticResource) -> int:
        try:
            return len(resource.body or b'')
        except Exception:
            return 0

    def _count(self, name: str, amount: int = 1) -> None:
        if not self._stats_enabled or amount <= 0:
            return
        try:
            setattr(self, name, int(getattr(self, name, 0)) + int(amount))
        except Exception:
            pass
