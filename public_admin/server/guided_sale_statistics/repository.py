from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Any, Callable, Mapping


OFFLINE_GRACE_SECONDS = 30 * 60
PRESENCE_STALE_SECONDS = 60
DEFAULT_CACHE_RETENTION_DAYS = 30
GLOBAL_NOTICE_CACHE_SECONDS = 60 * 60


def _text(value: Any) -> str:
    return str(value or "").strip()


class GuidedSaleStatisticsRepository:
    """PostgreSQL state for restart-safe guided-sale discovery and scanning."""

    def __init__(self, pool_supplier: Callable[[], object]) -> None:
        self._pool_supplier = pool_supplier
        self._ready = False
        self._ready_lock = asyncio.Lock()

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
                    CREATE TABLE IF NOT EXISTS guided_sale_statistics_runs (
                        id BIGSERIAL PRIMARY KEY,
                        owner_scope TEXT NOT NULL,
                        source_account TEXT NOT NULL,
                        source_user_id TEXT NOT NULL DEFAULT '',
                        source_auth_refresh_attempted BOOLEAN NOT NULL DEFAULT FALSE,
                        state TEXT NOT NULL DEFAULT 'waiting_notice',
                        source_offline_since TIMESTAMP NULL,
                        notice_id TEXT NOT NULL DEFAULT '',
                        sale_count INTEGER NOT NULL DEFAULT 0,
                        title TEXT NOT NULL DEFAULT '',
                        guidance_time TEXT NOT NULL DEFAULT '',
                        target_line TEXT NOT NULL DEFAULT '',
                        start_date_key INTEGER NOT NULL DEFAULT 0,
                        end_date_key INTEGER NOT NULL DEFAULT 0,
                        start_date_label TEXT NOT NULL DEFAULT '',
                        end_date_label TEXT NOT NULL DEFAULT '',
                        cache_written_at TIMESTAMP NULL,
                        lease_owner TEXT NOT NULL DEFAULT '',
                        lease_expires_at TIMESTAMP NULL,
                        next_attempt_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        last_error TEXT NOT NULL DEFAULT '',
                        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        completed_at TIMESTAMP NULL,
                        UNIQUE(owner_scope, source_account)
                    )
                    """
                )
                await conn.execute(
                    "ALTER TABLE guided_sale_statistics_runs "
                    "ADD COLUMN IF NOT EXISTS source_auth_refresh_attempted BOOLEAN NOT NULL DEFAULT FALSE"
                )
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS guided_sale_statistics_jobs (
                        id BIGSERIAL PRIMARY KEY,
                        run_id BIGINT NOT NULL REFERENCES guided_sale_statistics_runs(id) ON DELETE CASCADE,
                        target_account TEXT NOT NULL,
                        target_user_id TEXT NOT NULL DEFAULT '',
                        next_page INTEGER NOT NULL DEFAULT 1,
                        state TEXT NOT NULL DEFAULT 'pending',
                        offline_since TIMESTAMP NULL,
                        auth_refresh_attempted BOOLEAN NOT NULL DEFAULT FALSE,
                        lease_owner TEXT NOT NULL DEFAULT '',
                        lease_expires_at TIMESTAMP NULL,
                        next_attempt_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        last_error TEXT NOT NULL DEFAULT '',
                        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        completed_at TIMESTAMP NULL,
                        UNIQUE(run_id, target_account)
                    )
                    """
                )
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS guided_sale_statistics_rows (
                        job_id BIGINT NOT NULL REFERENCES guided_sale_statistics_jobs(id) ON DELETE CASCADE,
                        child_account TEXT NOT NULL,
                        create_time TEXT NOT NULL DEFAULT '',
                        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        PRIMARY KEY(job_id, child_account)
                    )
                    """
                )
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS guided_sale_statistics_presence (
                        account_username TEXT NOT NULL,
                        instance_id TEXT NOT NULL,
                        connection_id TEXT NOT NULL,
                        last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        PRIMARY KEY(account_username, instance_id, connection_id)
                    )
                    """
                )
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS guided_sale_statistics_rpc_locks (
                        lock_key TEXT PRIMARY KEY,
                        holder TEXT NOT NULL DEFAULT '',
                        lease_expires_at TIMESTAMP NULL,
                        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
                    )
                    """
                )
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS guided_sale_statistics_global_notice (
                        slot SMALLINT PRIMARY KEY DEFAULT 1 CHECK (slot = 1),
                        source_account TEXT NOT NULL DEFAULT '',
                        source_user_id TEXT NOT NULL DEFAULT '',
                        notice_id TEXT NOT NULL DEFAULT '',
                        sale_count INTEGER NOT NULL DEFAULT 0,
                        title TEXT NOT NULL DEFAULT '',
                        target_line TEXT NOT NULL DEFAULT '',
                        start_date_key INTEGER NOT NULL DEFAULT 0,
                        end_date_key INTEGER NOT NULL DEFAULT 0,
                        start_date_label TEXT NOT NULL DEFAULT '',
                        end_date_label TEXT NOT NULL DEFAULT '',
                        notice_cached_at TIMESTAMP NULL,
                        refresh_state TEXT NOT NULL DEFAULT 'unconfigured',
                        refresh_after TIMESTAMP NOT NULL DEFAULT NOW(),
                        last_error TEXT NOT NULL DEFAULT '',
                        lease_owner TEXT NOT NULL DEFAULT '',
                        lease_expires_at TIMESTAMP NULL,
                        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
                    )
                    """
                )
                await conn.execute(
                    "INSERT INTO guided_sale_statistics_global_notice (slot) VALUES (1) ON CONFLICT (slot) DO NOTHING"
                )
                await conn.execute(
                    "ALTER TABLE guided_sale_statistics_global_notice "
                    "ADD COLUMN IF NOT EXISTS guidance_time TEXT NOT NULL DEFAULT ''"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_guided_sale_jobs_claim "
                    "ON guided_sale_statistics_jobs(state, next_attempt_at)"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_guided_sale_presence_seen "
                    "ON guided_sale_statistics_presence(account_username, last_seen_at)"
                )
            self._ready = True

    async def list_scope_accounts(self, owner_scope: str, is_super_admin: bool) -> list[dict[str, Any]]:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            if is_super_admin:
                rows = await conn.fetch(
                    """
                    SELECT username, nickname, added_by
                    FROM authorized_accounts
                    WHERE status = 'active' AND expire_time >= NOW()
                    ORDER BY username
                    """
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT username, nickname, added_by
                    FROM authorized_accounts
                    WHERE status = 'active' AND expire_time >= NOW() AND added_by = $1
                    ORDER BY username
                    """,
                    owner_scope,
                )
        return [dict(row) for row in rows]

    async def get_scoped_account(
        self, owner_scope: str, is_super_admin: bool, username: str
    ) -> dict[str, Any] | None:
        account = _text(username).lower()
        if not account:
            return None
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            if is_super_admin:
                row = await conn.fetchrow(
                    """
                    SELECT username, nickname, added_by FROM authorized_accounts
                    WHERE username = $1 AND status = 'active' AND expire_time >= NOW()
                    """,
                    account,
                )
            else:
                row = await conn.fetchrow(
                    """
                    SELECT username, nickname, added_by FROM authorized_accounts
                    WHERE username = $1 AND status = 'active' AND expire_time >= NOW() AND added_by = $2
                    """,
                    account,
                    owner_scope,
                )
        return dict(row) if row else None

    async def get_active_account(self, username: str) -> dict[str, Any] | None:
        """Return an active authorized account without applying an administrator scope."""
        account = _text(username).lower()
        if not account:
            return None
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT username, nickname, added_by FROM authorized_accounts
                WHERE username = $1 AND status = 'active' AND expire_time >= NOW()
                """,
                account,
            )
        return dict(row) if row else None

    async def get_account_password(self, username: str) -> str:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            return _text(
                await conn.fetchval(
                    """
                    SELECT COALESCE(NULLIF(us.password, ''), NULLIF(aa.password, ''), '')
                    FROM authorized_accounts aa
                    LEFT JOIN user_stats us ON us.username = aa.username
                    WHERE aa.username = $1
                    """,
                    _text(username).lower(),
                )
            )

    async def get_global_notice(self) -> dict[str, Any]:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM guided_sale_statistics_global_notice WHERE slot = 1"
            )
        return dict(row or {})

    async def configure_global_source(self, source_account: str) -> dict[str, Any]:
        """Replace the sole notice credential and invalidate its shared announcement snapshot."""
        await self.ensure_ready()
        pool = self._pool_supplier()
        account = _text(source_account).lower()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE guided_sale_statistics_global_notice
                SET source_account = $1, source_user_id = '',
                    notice_id = '', sale_count = 0, title = '', guidance_time = '', target_line = '',
                    start_date_key = 0, end_date_key = 0, start_date_label = '', end_date_label = '',
                    notice_cached_at = NULL, refresh_state = CASE WHEN $1 = '' THEN 'unconfigured' ELSE 'pending' END,
                    refresh_after = NOW(), last_error = '', lease_owner = '', lease_expires_at = NULL,
                    updated_at = NOW()
                WHERE slot = 1
                RETURNING *
                """,
                account,
            )
        return dict(row or {})

    async def claim_global_notice_refresh(self, holder: str, force_retry: bool = False) -> dict[str, Any] | None:
        """Claim one expired global snapshot so concurrent administrators share a single fetch."""
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE guided_sale_statistics_global_notice
                SET refresh_state = 'refreshing', lease_owner = $1,
                    lease_expires_at = NOW() + INTERVAL '45 seconds', updated_at = NOW()
                WHERE slot = 1
                  AND source_account <> ''
                  AND (refresh_after <= NOW() OR $3::boolean)
                  AND (
                        notice_cached_at IS NULL
                        OR notice_cached_at < NOW() - ($2::int * INTERVAL '1 second')
                        OR COALESCE(guidance_time, '') = ''
                  )
                  AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
                RETURNING *
                """,
                _text(holder),
                GLOBAL_NOTICE_CACHE_SECONDS,
                bool(force_retry),
            )
        return dict(row) if row else None

    async def cache_global_notice(
        self, holder: str, source_account: str, source_user_id: str, notice: Mapping[str, Any]
    ) -> bool:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                UPDATE guided_sale_statistics_global_notice
                SET source_user_id = $3, notice_id = $4, sale_count = $5, title = $6, guidance_time = $7,
                    target_line = $8, start_date_key = $9, end_date_key = $10, start_date_label = $11, end_date_label = $12,
                    notice_cached_at = NOW(), refresh_state = 'ready', refresh_after = NOW(), last_error = '',
                    lease_owner = '', lease_expires_at = NULL, updated_at = NOW()
                WHERE slot = 1 AND source_account = $2 AND lease_owner = $1
                """,
                _text(holder),
                _text(source_account).lower(),
                _text(source_user_id),
                _text(notice.get("notice_id")),
                max(0, int(notice.get("sale_count") or 0)),
                _text(notice.get("title")),
                _text(notice.get("guidance_time")),
                _text(notice.get("target_line")),
                max(0, int(notice.get("start_date_key") or 0)),
                max(0, int(notice.get("end_date_key") or 0)),
                _text(notice.get("start_date_label")),
                _text(notice.get("end_date_label")),
            )
        return str(result).endswith("1")

    async def defer_global_notice_refresh(self, holder: str, seconds: int, error: str = "") -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE guided_sale_statistics_global_notice
                SET refresh_state = 'pending', refresh_after = NOW() + ($2::int * INTERVAL '1 second'),
                    last_error = $3, lease_owner = '', lease_expires_at = NULL, updated_at = NOW()
                WHERE slot = 1 AND lease_owner = $1
                """,
                _text(holder),
                max(1, int(seconds)),
                _text(error)[:500],
            )

    async def create_or_get_run(self, owner_scope: str, source_account: str) -> dict[str, Any]:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO guided_sale_statistics_runs (owner_scope, source_account)
                VALUES ($1, $2)
                ON CONFLICT (owner_scope, source_account)
                DO UPDATE SET updated_at = NOW()
                RETURNING *
                """,
                owner_scope,
                _text(source_account).lower(),
            )
        return dict(row)

    async def reset_run(self, run_id: int) -> None:
        """Discard an expired snapshot before discovering the current announcement again."""
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute("DELETE FROM guided_sale_statistics_jobs WHERE run_id = $1", int(run_id))
                await conn.execute(
                    """
                    UPDATE guided_sale_statistics_runs
                    SET source_user_id = '', source_auth_refresh_attempted = FALSE,
                        state = 'waiting_notice', source_offline_since = NULL,
                        notice_id = '', sale_count = 0, title = '', target_line = '',
                        start_date_key = 0, end_date_key = 0, start_date_label = '', end_date_label = '',
                        cache_written_at = NULL, lease_owner = '', lease_expires_at = NULL,
                        next_attempt_at = NOW(), last_error = '', completed_at = NULL, updated_at = NOW()
                    WHERE id = $1
                    """,
                    int(run_id),
                )

    async def get_run(self, owner_scope: str, source_account: str) -> dict[str, Any] | None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM guided_sale_statistics_runs WHERE owner_scope = $1 AND source_account = $2",
                owner_scope,
                _text(source_account).lower(),
            )
        return dict(row) if row else None

    async def claim_next_run(self, worker_id: str) -> dict[str, Any] | None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    """
                    SELECT * FROM guided_sale_statistics_runs
                    WHERE state = 'waiting_notice'
                      AND next_attempt_at <= NOW()
                      AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
                    ORDER BY updated_at
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                    """
                )
                if not row:
                    return None
                claimed = await conn.fetchrow(
                    """
                    UPDATE guided_sale_statistics_runs
                    SET lease_owner = $2, lease_expires_at = NOW() + INTERVAL '45 seconds', updated_at = NOW()
                    WHERE id = $1 RETURNING *
                    """,
                    row["id"],
                    worker_id,
                )
        return dict(claimed)

    async def defer_run(
        self, run_id: int, seconds: int, *, offline_since: datetime | None = None, error: str = ""
    ) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE guided_sale_statistics_runs
                SET source_offline_since = $2,
                    next_attempt_at = NOW() + ($3::int * INTERVAL '1 second'),
                    last_error = $4,
                    lease_owner = '', lease_expires_at = NULL, updated_at = NOW()
                WHERE id = $1
                """,
                int(run_id),
                offline_since,
                max(1, int(seconds)),
                _text(error)[:500],
            )

    async def cancel_run(self, run_id: int, reason: str) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE guided_sale_statistics_jobs
                    SET state = 'cancelled', lease_owner = '', lease_expires_at = NULL,
                        last_error = $2, updated_at = NOW()
                    WHERE run_id = $1 AND state = 'pending'
                    """,
                    int(run_id),
                    _text(reason)[:500],
                )
                await conn.execute(
                    """
                    UPDATE guided_sale_statistics_runs
                    SET state = 'cancelled', lease_owner = '', lease_expires_at = NULL,
                        last_error = $2, updated_at = NOW(), completed_at = NOW()
                    WHERE id = $1
                    """,
                    int(run_id),
                    _text(reason)[:500],
                )

    async def complete_discovery(
        self, run_id: int, source_user_id: str, notice: Mapping[str, Any], target_accounts: list[str]
    ) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                targets = sorted({_text(item).lower() for item in target_accounts if _text(item)})
                await conn.execute(
                    """
                    UPDATE guided_sale_statistics_runs
                    SET source_user_id = $2, state = CASE WHEN $11::int = 0 THEN 'completed' ELSE 'scanning' END,
                        source_offline_since = NULL,
                        notice_id = $3, sale_count = $4, title = $5, target_line = $6,
                        start_date_key = $7, end_date_key = $8, start_date_label = $9, end_date_label = $10,
                        cache_written_at = NOW(), last_error = '', lease_owner = '', lease_expires_at = NULL,
                        completed_at = CASE WHEN $11::int = 0 THEN NOW() ELSE NULL END, updated_at = NOW()
                    WHERE id = $1
                    """,
                    int(run_id),
                    _text(source_user_id),
                    _text(notice.get("notice_id")),
                    max(0, int(notice.get("sale_count") or 0)),
                    _text(notice.get("title")),
                    _text(notice.get("target_line")),
                    max(0, int(notice.get("start_date_key") or 0)),
                    max(0, int(notice.get("end_date_key") or 0)),
                    _text(notice.get("start_date_label")),
                    _text(notice.get("end_date_label")),
                    len(targets),
                )
                for account in targets:
                    await conn.execute(
                        """
                        INSERT INTO guided_sale_statistics_jobs (run_id, target_account)
                        VALUES ($1, $2)
                        ON CONFLICT (run_id, target_account) DO NOTHING
                        """,
                        int(run_id),
                        account,
                    )

    async def ensure_run_jobs(self, run_id: int, target_accounts: list[str]) -> None:
        """Add newly whitelisted accounts to an existing run without restarting finished pages."""
        targets = sorted({_text(item).lower() for item in target_accounts if _text(item)})
        if not targets:
            return
        await self.ensure_ready()
        pool = self._pool_supplier()
        inserted = False
        async with pool.acquire() as conn:
            async with conn.transaction():
                for account in targets:
                    result = await conn.execute(
                        """
                        INSERT INTO guided_sale_statistics_jobs (run_id, target_account)
                        VALUES ($1, $2)
                        ON CONFLICT (run_id, target_account) DO NOTHING
                        """,
                        int(run_id),
                        account,
                    )
                    inserted = inserted or str(result).endswith("1")
                if inserted:
                    await conn.execute(
                        """
                        UPDATE guided_sale_statistics_runs
                        SET state = 'scanning', completed_at = NULL, updated_at = NOW()
                        WHERE id = $1
                        """,
                        int(run_id),
                    )

    async def set_run_user_id(self, run_id: int, user_id: str) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE guided_sale_statistics_runs SET source_user_id = $2, updated_at = NOW() WHERE id = $1",
                int(run_id),
                _text(user_id),
            )

    async def set_run_auth_refresh_attempted(self, run_id: int) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE guided_sale_statistics_runs
                SET source_auth_refresh_attempted = TRUE, updated_at = NOW()
                WHERE id = $1
                """,
                int(run_id),
            )

    async def claim_next_job(self, worker_id: str) -> dict[str, Any] | None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    """
                    SELECT j.*, r.owner_scope, r.source_account, r.source_user_id, r.notice_id, r.sale_count,
                           r.title, r.target_line, r.start_date_key, r.end_date_key,
                           r.start_date_label, r.end_date_label
                    FROM guided_sale_statistics_jobs j
                    JOIN guided_sale_statistics_runs r ON r.id = j.run_id
                    WHERE j.state = 'pending' AND r.state = 'scanning'
                      AND j.next_attempt_at <= NOW()
                      AND (j.lease_expires_at IS NULL OR j.lease_expires_at < NOW())
                    ORDER BY j.updated_at
                    FOR UPDATE OF j SKIP LOCKED
                    LIMIT 1
                    """
                )
                if not row:
                    return None
                claimed = await conn.fetchrow(
                    """
                    UPDATE guided_sale_statistics_jobs
                    SET lease_owner = $2, lease_expires_at = NOW() + INTERVAL '45 seconds', updated_at = NOW()
                    WHERE id = $1 RETURNING *
                    """,
                    row["id"],
                    worker_id,
                )
        result = dict(row)
        result.update(dict(claimed))
        return result

    async def defer_job(
        self, job_id: int, seconds: int, *, offline_since: datetime | None = None, error: str = ""
    ) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE guided_sale_statistics_jobs
                SET offline_since = $2,
                    next_attempt_at = NOW() + ($3::int * INTERVAL '1 second'),
                    last_error = $4,
                    lease_owner = '', lease_expires_at = NULL, updated_at = NOW()
                WHERE id = $1
                """,
                int(job_id),
                offline_since,
                max(1, int(seconds)),
                _text(error)[:500],
            )

    async def cancel_job(self, job_id: int, reason: str) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    UPDATE guided_sale_statistics_jobs
                    SET state = 'cancelled', lease_owner = '', lease_expires_at = NULL,
                        last_error = $2, updated_at = NOW(), completed_at = NOW()
                    WHERE id = $1
                    """,
                    int(job_id),
                    _text(reason)[:500],
                )
                await conn.execute(
                    """
                    UPDATE guided_sale_statistics_runs r
                    SET state = CASE WHEN NOT EXISTS (
                        SELECT 1 FROM guided_sale_statistics_jobs j
                        WHERE j.run_id = r.id AND j.state = 'pending'
                    ) THEN 'completed' ELSE r.state END,
                        completed_at = CASE WHEN NOT EXISTS (
                            SELECT 1 FROM guided_sale_statistics_jobs j
                            WHERE j.run_id = r.id AND j.state = 'pending'
                        ) THEN NOW() ELSE r.completed_at END,
                        updated_at = NOW()
                    WHERE r.id = (SELECT run_id FROM guided_sale_statistics_jobs WHERE id = $1)
                    """,
                    int(job_id),
                )

    async def set_job_user_id(self, job_id: int, user_id: str) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE guided_sale_statistics_jobs SET target_user_id = $2, updated_at = NOW() WHERE id = $1",
                int(job_id),
                _text(user_id),
            )

    async def set_run_job_user_id(self, run_id: int, account: str, user_id: str) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE guided_sale_statistics_jobs
                SET target_user_id = $3, updated_at = NOW()
                WHERE run_id = $1 AND target_account = $2
                """,
                int(run_id),
                _text(account).lower(),
                _text(user_id),
            )

    async def set_job_auth_refresh_attempted(self, job_id: int) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE guided_sale_statistics_jobs SET auth_refresh_attempted = TRUE, updated_at = NOW() WHERE id = $1",
                int(job_id),
            )

    async def commit_page(
        self, job_id: int, rows: list[Mapping[str, Any]], next_page: int, completed: bool
    ) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                for item in rows:
                    account = _text(item.get("account")).lower()
                    if not account:
                        continue
                    await conn.execute(
                        """
                        INSERT INTO guided_sale_statistics_rows (job_id, child_account, create_time)
                        VALUES ($1, $2, $3)
                        ON CONFLICT (job_id, child_account)
                        DO UPDATE SET create_time = EXCLUDED.create_time
                        """,
                        int(job_id),
                        account,
                        _text(item.get("createTime")),
                    )
                await conn.execute(
                    """
                    UPDATE guided_sale_statistics_jobs
                    SET next_page = $2, state = CASE WHEN $3 THEN 'completed' ELSE 'pending' END,
                        offline_since = NULL, next_attempt_at = CASE
                            WHEN $3 THEN NOW() ELSE NOW() + INTERVAL '2 seconds' END,
                        completed_at = CASE WHEN $3 THEN NOW() ELSE completed_at END,
                        last_error = '', lease_owner = '', lease_expires_at = NULL, updated_at = NOW()
                    WHERE id = $1
                    """,
                    int(job_id),
                    max(1, int(next_page)),
                    bool(completed),
                )
                await conn.execute(
                    """
                    UPDATE guided_sale_statistics_runs r
                    SET cache_written_at = NOW(), updated_at = NOW(),
                        state = CASE WHEN NOT EXISTS (
                            SELECT 1 FROM guided_sale_statistics_jobs j
                            WHERE j.run_id = r.id AND j.state = 'pending'
                        ) THEN 'completed' ELSE r.state END,
                        completed_at = CASE WHEN NOT EXISTS (
                            SELECT 1 FROM guided_sale_statistics_jobs j
                            WHERE j.run_id = r.id AND j.state = 'pending'
                        ) THEN NOW() ELSE r.completed_at END
                    WHERE r.id = (SELECT run_id FROM guided_sale_statistics_jobs WHERE id = $1)
                    """,
                    int(job_id),
                )

    async def get_job_rows(self, job_id: int) -> list[dict[str, str]]:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT child_account, create_time
                FROM guided_sale_statistics_rows
                WHERE job_id = $1
                ORDER BY child_account
                """,
                int(job_id),
            )
        return [
            {"account": _text(row["child_account"]), "createTime": _text(row["create_time"])}
            for row in rows
        ]

    async def is_account_online(self, username: str) -> bool:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            return bool(
                await conn.fetchval(
                    """
                    SELECT EXISTS (
                        SELECT 1 FROM guided_sale_statistics_presence
                        WHERE account_username = $1
                          AND last_seen_at >= NOW() - ($2::int * INTERVAL '1 second')
                    )
                    """,
                    _text(username).lower(),
                    PRESENCE_STALE_SECONDS,
                )
            )

    async def record_presence(
        self, username: str, instance_id: str, connection_id: str, event: str
    ) -> None:
        username = _text(username).lower()
        if not username or not connection_id:
            return
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            if event == "offline":
                await conn.execute(
                    """
                    DELETE FROM guided_sale_statistics_presence
                    WHERE account_username = $1 AND instance_id = $2 AND connection_id = $3
                    """,
                    username,
                    instance_id,
                    connection_id,
                )
            else:
                await conn.execute(
                    """
                    INSERT INTO guided_sale_statistics_presence (
                        account_username, instance_id, connection_id, last_seen_at
                    ) VALUES ($1, $2, $3, NOW())
                    ON CONFLICT (account_username, instance_id, connection_id)
                    DO UPDATE SET last_seen_at = NOW()
                    """,
                    username,
                    instance_id,
                    connection_id,
                )

    async def mark_external_activity(self, user_id: str) -> None:
        value = _text(user_id)
        if not value:
            return
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE guided_sale_statistics_runs
                SET source_offline_since = NULL, next_attempt_at = NOW() + INTERVAL '30 minutes', updated_at = NOW()
                WHERE source_user_id = $1 AND state = 'waiting_notice'
                """,
                value,
            )
            await conn.execute(
                """
                UPDATE guided_sale_statistics_jobs
                SET offline_since = NULL, next_attempt_at = NOW() + INTERVAL '30 minutes', updated_at = NOW()
                WHERE target_user_id = $1 AND state = 'pending'
                """,
                value,
            )

    async def try_claim_rpc_locks(self, identity: str, holder: str) -> bool:
        """Claim global and account locks together so workers never overlap upstream calls."""
        await self.ensure_ready()
        keys = sorted({"__global__", "account:" + (_text(identity) or "unknown")})
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                for key in keys:
                    await conn.execute(
                        "INSERT INTO guided_sale_statistics_rpc_locks (lock_key) VALUES ($1) ON CONFLICT DO NOTHING",
                        key,
                    )
                rows = await conn.fetch(
                    """
                    SELECT lock_key, holder, lease_expires_at
                    FROM guided_sale_statistics_rpc_locks
                    WHERE lock_key = ANY($1::text[])
                    ORDER BY lock_key
                    FOR UPDATE
                    """,
                    keys,
                )
                now = datetime.now()
                if any(row["lease_expires_at"] and row["lease_expires_at"] > now for row in rows):
                    return False
                await conn.execute(
                    """
                    UPDATE guided_sale_statistics_rpc_locks
                    SET holder = $2, lease_expires_at = NOW() + INTERVAL '20 seconds', updated_at = NOW()
                    WHERE lock_key = ANY($1::text[])
                    """,
                    keys,
                    holder,
                )
        return True

    async def release_rpc_locks(self, identity: str, holder: str) -> None:
        await self.ensure_ready()
        keys = ["__global__", "account:" + (_text(identity) or "unknown")]
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE guided_sale_statistics_rpc_locks
                SET holder = '', lease_expires_at = NULL, updated_at = NOW()
                WHERE lock_key = ANY($1::text[]) AND holder = $2
                """,
                keys,
                holder,
            )

    async def dashboard(
        self, owner_scope: str, source_account: str, retention_days: int
    ) -> dict[str, Any]:
        run = await self.get_run(owner_scope, source_account)
        if run is None:
            return {"run": None, "jobs": [], "rows": []}
        fresh = bool(
            run.get("cache_written_at")
            and (datetime.now() - run["cache_written_at"]).total_seconds() <= max(1, retention_days) * 86400
        )
        if not fresh and run.get("state") == "completed":
            run["state"] = "expired"
            return {"run": run, "jobs": [], "rows": []}
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            jobs = await conn.fetch(
                """
                SELECT j.id, j.target_account, j.state, j.next_page, j.created_at, j.updated_at,
                       j.completed_at, COUNT(r.child_account)::int AS matched_count
                FROM guided_sale_statistics_jobs j
                LEFT JOIN guided_sale_statistics_rows r ON r.job_id = j.id
                WHERE j.run_id = $1
                GROUP BY j.id
                ORDER BY j.target_account
                """,
                run["id"],
            )
            rows = await conn.fetch(
                """
                SELECT j.target_account, r.child_account, r.create_time
                FROM guided_sale_statistics_rows r
                JOIN guided_sale_statistics_jobs j ON j.id = r.job_id
                WHERE j.run_id = $1
                ORDER BY j.target_account, r.create_time DESC, r.child_account
                """,
                run["id"],
            )
        return {"run": run, "jobs": [dict(item) for item in jobs], "rows": [dict(item) for item in rows]}

    async def cleanup_expired(self, retention_days: int) -> int:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                DELETE FROM guided_sale_statistics_runs
                WHERE state = 'completed'
                  AND cache_written_at < NOW() - ($1::int * INTERVAL '1 day')
                """,
                max(1, int(retention_days)),
            )
        return int(str(result).rsplit(" ", 1)[-1] or 0)
