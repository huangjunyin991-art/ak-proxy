import json
import time
from pathlib import Path
from typing import Optional

from ..runtime_performance import (
    run_blocking_diagnostics,
    run_blocking_maintenance,
    run_blocking_static_cache,
)
from .config import StaticResourceCacheConfig
from .key_builder import StaticResourceCacheKeyBuilder
from .models import CachedStaticResource


class DiskStaticResourceCacheStore:
    def __init__(self, config: StaticResourceCacheConfig, key_builder: StaticResourceCacheKeyBuilder):
        self.config = config
        self.key_builder = key_builder

    async def get(self, cache_key: str) -> Optional[CachedStaticResource]:
        return await run_blocking_static_cache(self._get_sync, cache_key)

    async def set(self, cache_key: str, resource: CachedStaticResource) -> None:
        await run_blocking_static_cache(self._set_sync, cache_key, resource)

    async def delete(self, cache_key: str) -> None:
        await run_blocking_static_cache(self._delete_sync, cache_key)

    async def cleanup_expired(self) -> int:
        return await run_blocking_maintenance(self._cleanup_expired_sync)

    async def list_entries(self, limit: int = 80) -> list[dict]:
        return await run_blocking_diagnostics(self._list_entries_sync, limit)

    async def load_fresh_entries(self, limit: int, max_body_bytes: int, max_total_bytes: int) -> dict:
        return await run_blocking_static_cache(
            self._load_fresh_entries_sync,
            limit,
            max_body_bytes,
            max_total_bytes,
        )

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

    def _load_fresh_entries_sync(self, limit: int, max_body_bytes: int, max_total_bytes: int) -> dict:
        root = self.config.root_dir
        summary = {
            'scanned': 0,
            'fresh': 0,
            'loaded': 0,
            'expired': 0,
            'oversized': 0,
            'capacity_skipped': 0,
            'errors': 0,
            'bytes': 0,
        }
        if not root.exists():
            return {'items': [], 'summary': summary}

        max_items = max(0, int(limit or 0))
        max_body = max(0, int(max_body_bytes or 0))
        max_total = max(0, int(max_total_bytes or 0))
        if max_items <= 0 or max_body <= 0 or max_total <= 0:
            return {'items': [], 'summary': summary}

        now = time.time()
        candidates: list[tuple[float, str, dict, int]] = []
        for meta_path in root.glob('*/*.meta.json'):
            summary['scanned'] += 1
            try:
                meta = json.loads(meta_path.read_text(encoding='utf-8'))
                if not isinstance(meta, dict):
                    summary['errors'] += 1
                    continue
                expires_at = float(meta.get('expires_at') or 0)
                if now >= expires_at:
                    summary['expired'] += 1
                    continue
                cache_key = str(meta.get('cache_key') or meta_path.name[:-len('.meta.json')])
                body_size = meta.get('body_size')
                if body_size is None:
                    _, _, body_path = self._paths(cache_key)
                    body_size = body_path.stat().st_size
                body_size = int(body_size or 0)
                if body_size <= 0 or body_size > max_body:
                    summary['oversized'] += 1
                    continue
                candidates.append((float(meta.get('created_at') or 0), cache_key, meta, body_size))
            except Exception:
                summary['errors'] += 1
                continue

        candidates.sort(key=lambda item: item[0], reverse=True)
        summary['fresh'] = len(candidates)
        selected: list[CachedStaticResource] = []
        total_bytes = 0
        for _, cache_key, meta, body_size in candidates:
            if len(selected) >= max_items:
                summary['capacity_skipped'] += 1
                continue
            if total_bytes + body_size > max_total:
                summary['capacity_skipped'] += 1
                continue
            try:
                _, _, body_path = self._paths(cache_key)
                body = body_path.read_bytes()
                actual_size = len(body or b'')
                if actual_size <= 0 or actual_size > max_body or total_bytes + actual_size > max_total:
                    summary['capacity_skipped'] += 1
                    continue
                selected.append(CachedStaticResource(
                    cache_key=cache_key,
                    path=str(meta.get('path') or ''),
                    status_code=int(meta.get('status_code') or 200),
                    headers=dict(meta.get('headers') or {}),
                    content_type=str(meta.get('content_type') or 'application/octet-stream'),
                    body=body,
                    created_at=float(meta.get('created_at') or 0),
                    expires_at=float(meta.get('expires_at') or 0),
                ))
                total_bytes += actual_size
            except Exception:
                summary['errors'] += 1

        summary['loaded'] = len(selected)
        summary['bytes'] = total_bytes
        return {'items': selected, 'summary': summary}
