import asyncio
import hashlib
import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any, Optional


@dataclass(frozen=True)
class CachedRpcResponse:
    cache_key: str
    status_code: int
    headers: dict[str, str]
    content_type: str
    body: bytes
    created_at: float
    expires_at: float


class StockPriceRpcCache:
    def __init__(self, root_dir: Path, max_body_bytes: int = 1024 * 1024):
        self.root_dir = Path(root_dir)
        self.max_body_bytes = max(1024, int(max_body_bytes or 0))
        self._items: dict[str, CachedRpcResponse] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._hits = 0
        self._misses = 0
        self._writes = 0
        self._expired = 0
        self._rejected = 0
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="stock-price-rpc-cache")

    def build_key(self, method: str, path: str, params: dict[str, Any] | None, raw_body: bytes | None) -> str:
        # Public_StockPrice is public market data. Upstream callers often add user
        # auth and version fields, but those must not split the shared price cache.
        material = {
            "path": str(path or "").strip("/").lower(),
            "scope": "global",
        }
        encoded = json.dumps(material, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    async def get(self, cache_key: str, ttl_seconds: int) -> Optional[CachedRpcResponse]:
        ttl_seconds = int(ttl_seconds or 0)
        if ttl_seconds <= 0:
            self._misses += 1
            return None
        cached = self._items.get(cache_key)
        if cached is not None:
            if self._is_fresh(cached, ttl_seconds):
                self._hits += 1
                return cached
            self._items.pop(cache_key, None)
            self._expired += 1
        cached = await self._run_io(self._read_disk_sync, cache_key)
        if cached is not None and self._is_fresh(cached, ttl_seconds):
            self._items[cache_key] = cached
            self._hits += 1
            return cached
        if cached is not None:
            await self.delete(cache_key)
            self._expired += 1
        self._misses += 1
        return None

    async def set(self, cache_key: str, response: CachedRpcResponse) -> bool:
        body = response.body or b""
        if len(body) <= 0 or len(body) > self.max_body_bytes:
            self._items.pop(cache_key, None)
            self._rejected += 1
            return False
        self._items[cache_key] = response
        try:
            await self._run_io(self._write_disk_sync, cache_key, response)
            self._writes += 1
            return True
        except Exception:
            self._writes += 1
            return True

    async def delete(self, cache_key: str) -> None:
        self._items.pop(cache_key, None)
        await self._run_io(self._delete_disk_sync, cache_key)

    async def get_or_lock(self, cache_key: str) -> asyncio.Lock:
        lock = self._locks.get(cache_key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[cache_key] = lock
        return lock

    def release_lock(self, cache_key: str, lock: asyncio.Lock | None) -> None:
        if lock is None:
            return
        try:
            if lock.locked():
                lock.release()
        except RuntimeError:
            pass
        current = self._locks.get(cache_key)
        if current is lock and not lock.locked():
            self._locks.pop(cache_key, None)

    async def cleanup_expired(self, ttl_seconds: int) -> int:
        ttl_seconds = int(ttl_seconds or 0)
        now = time.time()
        removed = 0
        for cache_key, cached in list(self._items.items()):
            if not self._is_fresh(cached, ttl_seconds, now=now):
                self._items.pop(cache_key, None)
                removed += 1
        removed += await self._run_io(self._cleanup_expired_disk_sync, ttl_seconds, now)
        if removed:
            self._expired += removed
        return removed

    def snapshot(self, ttl_seconds: int) -> dict[str, Any]:
        ttl_seconds = int(ttl_seconds or 0)
        now = time.time()
        fresh = 0
        oldest_age = 0
        for item in self._items.values():
            if self._is_fresh(item, ttl_seconds, now=now):
                fresh += 1
                oldest_age = max(oldest_age, int(now - float(item.created_at or now)))
        lookups = self._hits + self._misses
        return {
            "ttl_seconds": ttl_seconds,
            "memory_entries": len(self._items),
            "fresh_memory_entries": fresh,
            "lock_count": len(self._locks),
            "oldest_age_seconds": oldest_age,
            "hits": self._hits,
            "misses": self._misses,
            "writes": self._writes,
            "expired": self._expired,
            "rejected": self._rejected,
            "hit_ratio_pct": round((self._hits / lookups) * 100, 1) if lookups else 0.0,
        }

    async def _run_io(self, func, *args):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, partial(func, *args))

    def _is_fresh(self, response: CachedRpcResponse, ttl_seconds: int, now: float | None = None) -> bool:
        if ttl_seconds <= 0:
            return False
        created_at = float(response.created_at or 0)
        if created_at <= 0:
            expires_at = float(response.expires_at or 0)
            return expires_at > (now or time.time())
        return created_at + ttl_seconds > (now or time.time())

    def _paths(self, cache_key: str) -> tuple[Path, Path, Path]:
        shard = cache_key[:2] if len(cache_key) >= 2 else "xx"
        shard_dir = self.root_dir / shard
        return shard_dir, shard_dir / f"{cache_key}.meta.json", shard_dir / f"{cache_key}.body"

    def _read_disk_sync(self, cache_key: str) -> Optional[CachedRpcResponse]:
        _, meta_path, body_path = self._paths(cache_key)
        if not meta_path.exists() or not body_path.exists():
            return None
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            body = body_path.read_bytes()
            return CachedRpcResponse(
                cache_key=str(meta.get("cache_key") or cache_key),
                status_code=int(meta.get("status_code") or 200),
                headers=dict(meta.get("headers") or {}),
                content_type=str(meta.get("content_type") or "application/json"),
                body=body,
                created_at=float(meta.get("created_at") or 0),
                expires_at=float(meta.get("expires_at") or 0),
            )
        except Exception:
            self._delete_disk_sync(cache_key)
            return None

    def _write_disk_sync(self, cache_key: str, response: CachedRpcResponse) -> None:
        shard_dir, meta_path, body_path = self._paths(cache_key)
        shard_dir.mkdir(parents=True, exist_ok=True)
        tmp_meta = meta_path.with_suffix(".meta.json.tmp")
        tmp_body = body_path.with_suffix(".body.tmp")
        tmp_body.write_bytes(response.body or b"")
        tmp_meta.write_text(json.dumps({
            "cache_key": cache_key,
            "status_code": int(response.status_code),
            "headers": dict(response.headers or {}),
            "content_type": response.content_type or "application/json",
            "created_at": float(response.created_at),
            "expires_at": float(response.expires_at),
            "body_size": len(response.body or b""),
        }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        tmp_body.replace(body_path)
        tmp_meta.replace(meta_path)

    def _delete_disk_sync(self, cache_key: str) -> None:
        _, meta_path, body_path = self._paths(cache_key)
        for path in (meta_path, body_path, meta_path.with_suffix(".meta.json.tmp"), body_path.with_suffix(".body.tmp")):
            try:
                path.unlink(missing_ok=True)
            except Exception:
                pass

    def _cleanup_expired_disk_sync(self, ttl_seconds: int, now: float) -> int:
        removed = 0
        if not self.root_dir.exists():
            return 0
        for meta_path in self.root_dir.glob("*/*.meta.json"):
            cache_key = meta_path.name[:-len(".meta.json")]
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                created_at = float(meta.get("created_at") or 0)
                expires_at = float(meta.get("expires_at") or 0)
                if ttl_seconds <= 0:
                    fresh = False
                elif created_at > 0:
                    fresh = created_at + ttl_seconds > now
                else:
                    fresh = expires_at > now
                if fresh:
                    continue
            except Exception:
                pass
            self._delete_disk_sync(cache_key)
            removed += 1
        return removed
