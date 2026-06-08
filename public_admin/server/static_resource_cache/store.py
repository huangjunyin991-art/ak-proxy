import json
import time
from pathlib import Path
from typing import Optional

from ..runtime_performance import run_blocking
from .config import StaticResourceCacheConfig
from .key_builder import StaticResourceCacheKeyBuilder
from .models import CachedStaticResource


class DiskStaticResourceCacheStore:
    def __init__(self, config: StaticResourceCacheConfig, key_builder: StaticResourceCacheKeyBuilder):
        self.config = config
        self.key_builder = key_builder

    async def get(self, cache_key: str) -> Optional[CachedStaticResource]:
        return await run_blocking(self._get_sync, cache_key)

    async def set(self, cache_key: str, resource: CachedStaticResource) -> None:
        await run_blocking(self._set_sync, cache_key, resource)

    async def delete(self, cache_key: str) -> None:
        await run_blocking(self._delete_sync, cache_key)

    async def cleanup_expired(self) -> int:
        return await run_blocking(self._cleanup_expired_sync)

    async def list_entries(self, limit: int = 80) -> list[dict]:
        return await run_blocking(self._list_entries_sync, limit)

    def _paths(self, cache_key: str) -> tuple[Path, Path, Path]:
        shard_dir = self.config.root_dir / self.key_builder.shard(cache_key)
        return shard_dir, shard_dir / f'{cache_key}.meta.json', shard_dir / f'{cache_key}.body'

    def _get_sync(self, cache_key: str) -> Optional[CachedStaticResource]:
        _, meta_path, body_path = self._paths(cache_key)
        if not meta_path.exists() or not body_path.exists():
            return None
        try:
            meta = json.loads(meta_path.read_text(encoding='utf-8'))
            expires_at = float(meta.get('expires_at') or 0)
            if time.time() >= expires_at:
                self._delete_sync(cache_key)
                return None
            body = body_path.read_bytes()
            return CachedStaticResource(
                cache_key=cache_key,
                path=str(meta.get('path') or ''),
                status_code=int(meta.get('status_code') or 200),
                headers=dict(meta.get('headers') or {}),
                content_type=str(meta.get('content_type') or 'application/octet-stream'),
                body=body,
                created_at=float(meta.get('created_at') or 0),
                expires_at=expires_at,
            )
        except Exception:
            self._delete_sync(cache_key)
            return None

    def _set_sync(self, cache_key: str, resource: CachedStaticResource) -> None:
        shard_dir, meta_path, body_path = self._paths(cache_key)
        shard_dir.mkdir(parents=True, exist_ok=True)
        tmp_meta = meta_path.with_suffix('.meta.json.tmp')
        tmp_body = body_path.with_suffix('.body.tmp')
        meta = {
            'cache_key': cache_key,
            'path': str(resource.path or ''),
            'status_code': int(resource.status_code),
            'headers': dict(resource.headers or {}),
            'content_type': resource.content_type or 'application/octet-stream',
            'created_at': float(resource.created_at),
            'expires_at': float(resource.expires_at),
            'body_size': len(resource.body or b''),
        }
        tmp_body.write_bytes(resource.body or b'')
        tmp_meta.write_text(json.dumps(meta, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        tmp_body.replace(body_path)
        tmp_meta.replace(meta_path)

    def _delete_sync(self, cache_key: str) -> None:
        _, meta_path, body_path = self._paths(cache_key)
        for path in (meta_path, body_path, meta_path.with_suffix('.meta.json.tmp'), body_path.with_suffix('.body.tmp')):
            try:
                path.unlink(missing_ok=True)
            except Exception:
                pass

    def _cleanup_expired_sync(self) -> int:
        removed = 0
        root = self.config.root_dir
        if not root.exists():
            return 0
        now = time.time()
        for meta_path in root.glob('*/*.meta.json'):
            cache_key = meta_path.name[:-len('.meta.json')]
            try:
                meta = json.loads(meta_path.read_text(encoding='utf-8'))
                if now < float(meta.get('expires_at') or 0):
                    continue
            except Exception:
                pass
            self._delete_sync(cache_key)
            removed += 1
        return removed

    def _list_entries_sync(self, limit: int = 80) -> list[dict]:
        root = self.config.root_dir
        if not root.exists():
            return []
        max_items = max(1, min(int(limit or 80), 500))
        entries: list[dict] = []
        for meta_path in root.glob('*/*.meta.json'):
            try:
                meta = json.loads(meta_path.read_text(encoding='utf-8'))
                if not isinstance(meta, dict):
                    continue
                cache_key = str(meta.get('cache_key') or meta_path.name[:-len('.meta.json')])
                body_size = meta.get('body_size')
                if body_size is None:
                    _, _, body_path = self._paths(cache_key)
                    try:
                        body_size = body_path.stat().st_size
                    except Exception:
                        body_size = 0
                entries.append({
                    'cache_key': cache_key,
                    'path': str(meta.get('path') or ''),
                    'status_code': int(meta.get('status_code') or 0),
                    'content_type': str(meta.get('content_type') or ''),
                    'created_at': float(meta.get('created_at') or 0),
                    'expires_at': float(meta.get('expires_at') or 0),
                    'body_size': int(body_size or 0),
                })
            except Exception:
                continue
        entries.sort(key=lambda item: float(item.get('created_at') or 0), reverse=True)
        return entries[:max_items]
