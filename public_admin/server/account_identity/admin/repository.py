from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Callable


class AccountIdentityAdminRepository:
    def __init__(self, pool_supplier: Callable[[], object]):
        self._pool_supplier = pool_supplier

    def _pool(self):
        return self._pool_supplier()

    async def ensure_tables(self) -> None:
        pool = self._pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS account_identity_sync_runs (
                    id BIGSERIAL PRIMARY KEY,
                    trigger_mode TEXT NOT NULL DEFAULT 'manual',
                    triggered_by TEXT NOT NULL DEFAULT '',
                    phase_key TEXT NOT NULL DEFAULT 'all',
                    dry_run BOOLEAN NOT NULL DEFAULT FALSE,
                    limit_per_spec INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'running',
                    summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
                    error_message TEXT NOT NULL DEFAULT '',
                    started_at TIMESTAMP NOT NULL DEFAULT NOW(),
                    finished_at TIMESTAMP
                )
                """
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_account_identity_sync_runs_started_at "
                "ON account_identity_sync_runs(started_at DESC)"
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_account_identity_sync_runs_status "
                "ON account_identity_sync_runs(status)"
            )

    async def get_identity_summary(self) -> dict[str, Any]:
        pool = self._pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                WITH alias_counts AS (
                    SELECT account_id, COUNT(*)::int AS alias_count
                    FROM account_username_aliases
                    GROUP BY account_id
                )
                SELECT
                    (SELECT COUNT(*)::bigint FROM account_identities) AS total_identities,
                    (SELECT COUNT(*)::bigint FROM account_username_aliases) AS total_aliases,
                    (
                        SELECT COUNT(*)::bigint
                        FROM account_identities i
                        JOIN alias_counts a ON a.account_id = i.account_id
                        WHERE i.last_renamed_at IS NOT NULL OR a.alias_count > 1
                    ) AS changed_identities,
                    (SELECT MAX(last_renamed_at) FROM account_identities) AS last_renamed_at
                """
            )
        return dict(row) if row else {
            "total_identities": 0,
            "total_aliases": 0,
            "changed_identities": 0,
            "last_renamed_at": None,
        }

    async def list_recent_identity_changes(
        self,
        search: str = "",
        limit: int = 50,
        offset: int = 0,
    ) -> dict[str, Any]:
        keyword = str(search or "").strip().lower()
        pattern = f"%{keyword}%"
        safe_limit = max(1, min(int(limit or 50), 200))
        safe_offset = max(0, int(offset or 0))
        pool = self._pool()
        async with pool.acquire() as conn:
            total = await conn.fetchval(
                """
                WITH alias_counts AS (
                    SELECT account_id, COUNT(*)::int AS alias_count
                    FROM account_username_aliases
                    GROUP BY account_id
                )
                SELECT COUNT(*)::bigint
                FROM account_identities i
                JOIN alias_counts a ON a.account_id = i.account_id
                WHERE (i.last_renamed_at IS NOT NULL OR a.alias_count > 1)
                  AND (
                    $1 = ''
                    OR LOWER(i.canonical_username) LIKE $2
                    OR EXISTS(
                        SELECT 1
                        FROM account_username_aliases alias
                        WHERE alias.account_id = i.account_id
                          AND alias.username LIKE $2
                    )
                  )
                """,
                keyword,
                pattern,
            )
            rows = await conn.fetch(
                """
                WITH alias_summary AS (
                    SELECT
                        account_id,
                        COUNT(*)::int AS alias_count,
                        ARRAY_AGG(username ORDER BY is_canonical DESC, updated_at DESC, username ASC) AS aliases
                    FROM account_username_aliases
                    GROUP BY account_id
                )
                SELECT
                    i.account_id,
                    i.canonical_username,
                    i.created_at,
                    i.updated_at,
                    i.last_renamed_at,
                    a.alias_count,
                    a.aliases
                FROM account_identities i
                JOIN alias_summary a ON a.account_id = i.account_id
                WHERE (i.last_renamed_at IS NOT NULL OR a.alias_count > 1)
                  AND (
                    $1 = ''
                    OR LOWER(i.canonical_username) LIKE $2
                    OR EXISTS(
                        SELECT 1
                        FROM account_username_aliases alias
                        WHERE alias.account_id = i.account_id
                          AND alias.username LIKE $2
                    )
                  )
                ORDER BY COALESCE(i.last_renamed_at, i.updated_at) DESC, i.account_id DESC
                LIMIT $3 OFFSET $4
                """,
                keyword,
                pattern,
                safe_limit,
                safe_offset,
            )
        return {"total": int(total or 0), "rows": [dict(row) for row in rows]}

    async def create_sync_run(
        self,
        trigger_mode: str,
        triggered_by: str,
        phase_key: str,
        dry_run: bool,
        limit_per_spec: int,
    ) -> int:
        pool = self._pool()
        async with pool.acquire() as conn:
            run_id = await conn.fetchval(
                """
                INSERT INTO account_identity_sync_runs (
                    trigger_mode, triggered_by, phase_key, dry_run, limit_per_spec, status
                )
                VALUES ($1, $2, $3, $4, $5, 'running')
                RETURNING id
                """,
                str(trigger_mode or "manual"),
                str(triggered_by or ""),
                str(phase_key or "all"),
                bool(dry_run),
                max(0, int(limit_per_spec or 0)),
            )
        return int(run_id or 0)

    async def finish_sync_run(
        self,
        run_id: int,
        status: str,
        summary: dict[str, Any],
        error_message: str = "",
    ) -> None:
        pool = self._pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE account_identity_sync_runs
                SET status = $2,
                    summary_json = $3::jsonb,
                    error_message = $4,
                    finished_at = NOW()
                WHERE id = $1
                """,
                int(run_id or 0),
                str(status or "failed"),
                json.dumps(summary or {}, ensure_ascii=False),
                str(error_message or "")[:2000],
            )

    async def list_recent_sync_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        safe_limit = max(1, min(int(limit or 20), 100))
        pool = self._pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                    id,
                    trigger_mode,
                    triggered_by,
                    phase_key,
                    dry_run,
                    limit_per_spec,
                    status,
                    summary_json,
                    error_message,
                    started_at,
                    finished_at
                FROM account_identity_sync_runs
                ORDER BY started_at DESC, id DESC
                LIMIT $1
                """,
                safe_limit,
            )
        return [dict(row) for row in rows]

    async def get_latest_auto_sync_run(
        self,
        *,
        day_start: datetime | None = None,
        day_end: datetime | None = None,
    ) -> dict[str, Any] | None:
        pool = self._pool()
        async with pool.acquire() as conn:
            if day_start is not None and day_end is not None:
                row = await conn.fetchrow(
                    """
                    SELECT
                        id,
                        trigger_mode,
                        triggered_by,
                        phase_key,
                        dry_run,
                        limit_per_spec,
                        status,
                        summary_json,
                        error_message,
                        started_at,
                        finished_at
                    FROM account_identity_sync_runs
                    WHERE trigger_mode = 'auto'
                      AND started_at >= $1
                      AND started_at < $2
                    ORDER BY started_at DESC, id DESC
                    LIMIT 1
                    """,
                    day_start,
                    day_end,
                )
            else:
                row = await conn.fetchrow(
                    """
                    SELECT
                        id,
                        trigger_mode,
                        triggered_by,
                        phase_key,
                        dry_run,
                        limit_per_spec,
                        status,
                        summary_json,
                        error_message,
                        started_at,
                        finished_at
                    FROM account_identity_sync_runs
                    WHERE trigger_mode = 'auto'
                    ORDER BY started_at DESC, id DESC
                    LIMIT 1
                    """
                )
        return dict(row) if row else None
