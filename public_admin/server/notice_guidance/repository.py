from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Callable, Mapping


DEFAULT_GUIDED_SALE_CACHE_RETENTION_DAYS = 180
_CLEANUP_INTERVAL_SECONDS = 24 * 60 * 60


def _trim_string(value: Any) -> str:
    return str(value or "").strip()


def _load_json_array(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    try:
        parsed = json.loads(str(value or "[]"))
    except (TypeError, ValueError, json.JSONDecodeError):
        return []
    return parsed if isinstance(parsed, list) else []


class NoticeGuidanceCacheRepository:
    """Persistent, per-user cache for completed guided-sale scans."""

    def __init__(
        self,
        pool_supplier: Callable[[], object],
        retention_days: int = DEFAULT_GUIDED_SALE_CACHE_RETENTION_DAYS,
    ) -> None:
        self._pool_supplier = pool_supplier
        self._retention_days = max(1, int(retention_days or DEFAULT_GUIDED_SALE_CACHE_RETENTION_DAYS))
        self._ready = False
        self._ready_lock = asyncio.Lock()
        self._cleanup_lock = asyncio.Lock()
        self._next_cleanup_at = 0.0

    async def ensure_ready(self) -> None:
        if self._ready:
            return
        async with self._ready_lock:
            if self._ready:
                return
            pool = self._pool_supplier()
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS notice_guided_sale_account_cache (
                        viewer_user_id TEXT NOT NULL,
                        auth_key_fingerprint TEXT NOT NULL,
                        notice_key TEXT NOT NULL,
                        notice_id TEXT NOT NULL DEFAULT '',
                        start_date_key INTEGER NOT NULL,
                        end_date_key INTEGER NOT NULL,
                        accounts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                        rows_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                        pages_scanned INTEGER NOT NULL DEFAULT 0,
                        stop_reason TEXT NOT NULL DEFAULT '',
                        completed_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        PRIMARY KEY (viewer_user_id, notice_key, start_date_key, end_date_key)
                    )
                    """
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_notice_guided_sale_cache_completed_at "
                    "ON notice_guided_sale_account_cache(completed_at)"
                )
            self._ready = True

    async def get_completed_scan(self, scope: Mapping[str, Any]) -> dict[str, Any] | None:
        await self.ensure_ready()
        await self._maybe_cleanup_expired()
        normalized = self._normalize_scope(scope)
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT accounts_json, rows_json, pages_scanned, stop_reason, completed_at
                FROM notice_guided_sale_account_cache
                WHERE viewer_user_id = $1
                  AND auth_key_fingerprint = $2
                  AND notice_key = $3
                  AND start_date_key = $4
                  AND end_date_key = $5
                  AND completed_at >= NOW() - ($6::int * INTERVAL '1 day')
                """,
                normalized["viewer_user_id"],
                normalized["auth_key_fingerprint"],
                normalized["notice_key"],
                normalized["start_date_key"],
                normalized["end_date_key"],
                self._retention_days,
            )
        if not row:
            return None
        accounts = [
            _trim_string(account)
            for account in _load_json_array(row["accounts_json"])
            if _trim_string(account)
        ]
        rows = [item for item in _load_json_array(row["rows_json"]) if isinstance(item, dict)]
        return {
            "accounts": accounts,
            "rows": rows,
            "pages_scanned": max(0, int(row["pages_scanned"] or 0)),
            "stop_reason": _trim_string(row["stop_reason"]),
            "completed_at": row["completed_at"],
        }

    async def save_completed_scan(self, scope: Mapping[str, Any], result: Mapping[str, Any]) -> None:
        await self.ensure_ready()
        await self._maybe_cleanup_expired()
        normalized = self._normalize_scope(scope)
        accounts = [
            _trim_string(account)
            for account in (result.get("accounts") or [])
            if _trim_string(account)
        ]
        rows = []
        for item in result.get("rows") or []:
            if not isinstance(item, Mapping):
                continue
            account = _trim_string(item.get("account"))
            if not account:
                continue
            rows.append({
                "account": account,
                "createTime": _trim_string(item.get("createTime")),
            })
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO notice_guided_sale_account_cache (
                    viewer_user_id, auth_key_fingerprint, notice_key, notice_id, start_date_key, end_date_key,
                    accounts_json, rows_json, pages_scanned, stop_reason, completed_at, created_at, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, NOW(), NOW(), NOW())
                ON CONFLICT (viewer_user_id, notice_key, start_date_key, end_date_key)
                DO UPDATE SET
                    auth_key_fingerprint = EXCLUDED.auth_key_fingerprint,
                    notice_id = EXCLUDED.notice_id,
                    accounts_json = EXCLUDED.accounts_json,
                    rows_json = EXCLUDED.rows_json,
                    pages_scanned = EXCLUDED.pages_scanned,
                    stop_reason = EXCLUDED.stop_reason,
                    completed_at = NOW(),
                    updated_at = NOW()
                """,
                normalized["viewer_user_id"],
                normalized["auth_key_fingerprint"],
                normalized["notice_key"],
                normalized["notice_id"],
                normalized["start_date_key"],
                normalized["end_date_key"],
                json.dumps(accounts, ensure_ascii=False, separators=(",", ":")),
                json.dumps(rows, ensure_ascii=False, separators=(",", ":")),
                max(0, int(result.get("pages_scanned") or 0)),
                _trim_string(result.get("stop_reason")),
            )

    async def _maybe_cleanup_expired(self) -> None:
        now = time.monotonic()
        if now < self._next_cleanup_at:
            return
        async with self._cleanup_lock:
            now = time.monotonic()
            if now < self._next_cleanup_at:
                return
            pool = self._pool_supplier()
            async with pool.acquire() as conn:
                await conn.execute(
                    "DELETE FROM notice_guided_sale_account_cache "
                    "WHERE completed_at < NOW() - ($1::int * INTERVAL '1 day')",
                    self._retention_days,
                )
            self._next_cleanup_at = now + _CLEANUP_INTERVAL_SECONDS

    @staticmethod
    def _normalize_scope(scope: Mapping[str, Any]) -> dict[str, Any]:
        viewer_user_id = _trim_string(scope.get("viewer_user_id"))
        auth_key_fingerprint = _trim_string(scope.get("auth_key_fingerprint"))
        notice_key = _trim_string(scope.get("notice_key"))
        if not viewer_user_id or not auth_key_fingerprint or not notice_key:
            raise ValueError("invalid guided-sale cache scope")
        return {
            "viewer_user_id": viewer_user_id,
            "auth_key_fingerprint": auth_key_fingerprint,
            "notice_key": notice_key,
            "notice_id": _trim_string(scope.get("notice_id")),
            "start_date_key": max(0, int(scope.get("start_date_key") or 0)),
            "end_date_key": max(0, int(scope.get("end_date_key") or 0)),
        }
