from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Mapping
from typing import Any


DEFAULT_RETENTION_DAYS = 365
MIN_RETENTION_DAYS = 1
MAX_RETENTION_DAYS = 3650


class AKSellLedgerRepository:
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
                    CREATE TABLE IF NOT EXISTS ak_sell_ledger (
                        id BIGSERIAL PRIMARY KEY,
                        event_id TEXT NOT NULL UNIQUE,
                        request_id TEXT NULL,
                        account TEXT NOT NULL DEFAULT '',
                        sub_account_id TEXT NOT NULL DEFAULT '',
                        sub_account_name TEXT NOT NULL DEFAULT '',
                        amount TEXT NOT NULL DEFAULT '',
                        endpoint TEXT NOT NULL DEFAULT '',
                        message TEXT NOT NULL DEFAULT '',
                        source TEXT NOT NULL DEFAULT '',
                        confirmation_method TEXT NOT NULL DEFAULT 'upstream_response',
                        sold_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        upstream_payload JSONB NOT NULL DEFAULT '{}'::jsonb
                    )
                    """
                )
                await conn.execute(
                    "ALTER TABLE ak_sell_ledger ADD COLUMN IF NOT EXISTS confirmation_method "
                    "TEXT NOT NULL DEFAULT 'upstream_response'"
                )
                await conn.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_ak_sell_ledger_request_id "
                    "ON ak_sell_ledger(request_id) WHERE request_id IS NOT NULL AND request_id <> ''"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_ak_sell_ledger_sold_at ON ak_sell_ledger(sold_at DESC)"
                )
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS ak_sell_balance_confirmation_tasks (
                        task_id TEXT PRIMARY KEY,
                        request_id TEXT NOT NULL DEFAULT '',
                        account TEXT NOT NULL,
                        endpoint TEXT NOT NULL,
                        sub_account_id TEXT NOT NULL DEFAULT '',
                        amount TEXT NOT NULL,
                        initial_balance TEXT NOT NULL,
                        source TEXT NOT NULL DEFAULT '',
                        state TEXT NOT NULL DEFAULT 'pending',
                        attempts INTEGER NOT NULL DEFAULT 0,
                        next_attempt_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        expires_at TIMESTAMP NOT NULL,
                        last_error TEXT NOT NULL DEFAULT '',
                        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        confirmed_at TIMESTAMP NULL
                    )
                    """
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_ak_sell_balance_confirmation_due "
                    "ON ak_sell_balance_confirmation_tasks(state, next_attempt_at)"
                )
                await conn.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_ak_sell_balance_confirmation_request_id "
                    "ON ak_sell_balance_confirmation_tasks(request_id) "
                    "WHERE request_id <> ''"
                )
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS ak_sell_ledger_config (
                        slot SMALLINT PRIMARY KEY DEFAULT 1 CHECK (slot = 1),
                        retention_days INTEGER NOT NULL DEFAULT 365,
                        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
                    )
                    """
                )
                await conn.execute(
                    "INSERT INTO ak_sell_ledger_config (slot, retention_days) VALUES (1, $1) "
                    "ON CONFLICT (slot) DO NOTHING",
                    DEFAULT_RETENTION_DAYS,
                )
            self._ready = True

    async def record(self, record: Mapping[str, Any]) -> bool:
        await self.ensure_ready()
        pool = self._pool_supplier()
        event_id = str(record.get("event_id") or "")
        request_id = str(record.get("request_id") or "").strip() or None
        if not event_id:
            raise ValueError("event_id is required")
        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                INSERT INTO ak_sell_ledger (
                    event_id, request_id, account, sub_account_id, sub_account_name,
                    amount, endpoint, message, source, confirmation_method, upstream_payload
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
                ON CONFLICT DO NOTHING
                """,
                event_id, request_id, str(record.get("account") or ""),
                str(record.get("sub_account_id") or ""), str(record.get("sub_account_name") or ""),
                str(record.get("amount") or ""), str(record.get("endpoint") or ""),
                str(record.get("message") or ""), str(record.get("source") or ""),
                str(record.get("confirmation_method") or "upstream_response"),
                json.dumps(record.get("upstream_payload") or {}, ensure_ascii=False),
            )
        return result.endswith("1")

    async def list_rows(self, *, account: str = "", source: str = "", page: int = 1, page_size: int = 50) -> list[dict[str, Any]]:
        await self.ensure_ready()
        page = max(1, int(page or 1))
        page_size = max(10, min(int(page_size or 50), 200))
        conditions = []
        params: list[Any] = []
        if account.strip():
            params.append(account.strip().lower())
            conditions.append(f"account = ${len(params)}")
        if source.strip():
            params.append(source.strip())
            conditions.append(f"source = ${len(params)}")
        params.extend([page_size, (page - 1) * page_size])
        where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
        sql = f"SELECT id,event_id,request_id,account,sub_account_id,sub_account_name,amount,endpoint,message,source,confirmation_method,sold_at,created_at FROM ak_sell_ledger{where} ORDER BY sold_at DESC, id DESC LIMIT ${len(params) - 1} OFFSET ${len(params)}"
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            rows = await conn.fetch(sql, *params)
        return [dict(row) for row in rows]

    async def dashboard(self, *, account: str = "", source: str = "", page: int = 1, page_size: int = 50) -> dict[str, Any]:
        await self.ensure_ready()
        conditions = []
        params: list[Any] = []
        if account.strip():
            params.append(account.strip().lower())
            conditions.append(f"account = ${len(params)}")
        if source.strip():
            params.append(source.strip())
            conditions.append(f"source = ${len(params)}")
        where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            summary = await conn.fetchrow(
                f"SELECT COUNT(*)::bigint AS records, COUNT(DISTINCT account)::bigint AS accounts, COALESCE(SUM(CASE WHEN amount ~ '^[0-9]+([.][0-9]+)?$' THEN amount::numeric ELSE 0 END), 0)::numeric AS amount, COUNT(*) FILTER (WHERE sold_at >= CURRENT_DATE)::bigint AS today_records FROM ak_sell_ledger{where}",
                *params,
            )
        summary_data = dict(summary or {})
        total = int(summary_data.get("records") or 0)
        page_size = max(10, min(int(page_size or 50), 200))
        total_pages = max(1, (total + page_size - 1) // page_size)
        page = max(1, min(int(page or 1), total_pages))
        return {
            "summary": summary_data,
            "rows": await self.list_rows(account=account, source=source, page=page, page_size=page_size),
            "pagination": {"page": page, "page_size": page_size, "total": total, "total_pages": total_pages},
            "config": await self.get_config(),
        }

    async def get_config(self) -> dict[str, Any]:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow("SELECT retention_days, updated_at FROM ak_sell_ledger_config WHERE slot = 1")
        return dict(row or {"retention_days": DEFAULT_RETENTION_DAYS})

    async def save_config(self, retention_days: int) -> dict[str, Any]:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "UPDATE ak_sell_ledger_config SET retention_days=$1,updated_at=NOW() WHERE slot=1 RETURNING retention_days,updated_at",
                retention_days,
            )
        return dict(row or {})

    async def cleanup(self) -> dict[str, Any]:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                retention_days = int(await conn.fetchval(
                    "SELECT retention_days FROM ak_sell_ledger_config WHERE slot = 1 FOR SHARE"
                ) or DEFAULT_RETENTION_DAYS)
                cutoff = await conn.fetchval("SELECT NOW() - make_interval(days => $1::integer)", retention_days)
                result = await conn.execute("DELETE FROM ak_sell_ledger WHERE sold_at < $1", cutoff)
                task_result = await conn.execute(
                    "DELETE FROM ak_sell_balance_confirmation_tasks "
                    "WHERE state IN ('confirmed', 'expired', 'superseded') AND updated_at < $1",
                    cutoff,
                )
        return {
            "deleted": int(result.split()[-1]),
            "deleted_confirmations": int(task_result.split()[-1]),
            "cutoff": cutoff,
            "retention_days": retention_days,
        }

    async def enqueue_balance_confirmation(self, task: Mapping[str, Any]) -> bool:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                INSERT INTO ak_sell_balance_confirmation_tasks (
                    task_id, request_id, account, endpoint, sub_account_id, amount,
                    initial_balance, source, state, next_attempt_at, expires_at, last_error
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',NOW() + INTERVAL '3 seconds',
                          NOW() + INTERVAL '2 minutes',$9)
                ON CONFLICT (task_id) DO NOTHING
                """,
                str(task.get("task_id") or ""),
                str(task.get("request_id") or ""),
                str(task.get("account") or "").lower(),
                str(task.get("endpoint") or ""),
                str(task.get("sub_account_id") or ""),
                str(task.get("amount") or ""),
                str(task.get("initial_balance") or ""),
                str(task.get("source") or ""),
                str(task.get("last_error") or "")[:500],
            )
        return result.endswith("1")

    async def claim_due_balance_confirmations(self, limit: int = 20) -> list[dict[str, Any]]:
        await self.ensure_ready()
        pool = self._pool_supplier()
        size = max(1, min(int(limit or 20), 100))
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "UPDATE ak_sell_balance_confirmation_tasks SET state='pending',updated_at=NOW() "
                    "WHERE state='checking' AND updated_at < NOW() - INTERVAL '2 minutes'"
                )
                await conn.execute(
                    "UPDATE ak_sell_balance_confirmation_tasks SET state='expired',updated_at=NOW(),"
                    "last_error=CASE WHEN last_error='' THEN 'confirmation window expired' ELSE last_error END "
                    "WHERE state='pending' AND expires_at <= NOW()"
                )
                rows = await conn.fetch(
                    """
                    WITH due AS (
                        SELECT task_id FROM ak_sell_balance_confirmation_tasks
                        WHERE state='pending' AND next_attempt_at <= NOW() AND expires_at > NOW()
                        ORDER BY next_attempt_at, created_at
                        FOR UPDATE SKIP LOCKED
                        LIMIT $1
                    )
                    UPDATE ak_sell_balance_confirmation_tasks task
                    SET state='checking',attempts=task.attempts+1,updated_at=NOW()
                    FROM due
                    WHERE task.task_id=due.task_id
                    RETURNING task.*
                    """,
                    size,
                )
        return [dict(row) for row in rows]

    async def mark_balance_confirmation_confirmed(self, task_id: str) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                task = await conn.fetchrow(
                    """
                    UPDATE ak_sell_balance_confirmation_tasks
                    SET state='confirmed',confirmed_at=NOW(),updated_at=NOW(),last_error=''
                    WHERE task_id=$1
                    RETURNING account,endpoint,sub_account_id,amount,initial_balance,created_at
                    """,
                    task_id,
                )
                if task is None:
                    return
                await conn.execute(
                    """
                    UPDATE ak_sell_balance_confirmation_tasks
                    SET state='superseded',updated_at=NOW(),last_error='equivalent request confirmed'
                    WHERE state IN ('pending','checking')
                      AND task_id <> $1
                      AND account=$2 AND endpoint=$3 AND sub_account_id=$4
                      AND amount=$5 AND initial_balance=$6
                      AND created_at >= $7 - INTERVAL '2 minutes'
                    """,
                    task_id,
                    task["account"], task["endpoint"], task["sub_account_id"],
                    task["amount"], task["initial_balance"], task["created_at"],
                )

    async def retry_balance_confirmation(self, task_id: str, error: str, retry_seconds: int = 5) -> str:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE ak_sell_balance_confirmation_tasks
                SET state=CASE WHEN expires_at <= NOW() THEN 'expired' ELSE 'pending' END,
                    next_attempt_at=NOW() + make_interval(secs => $3::integer),
                    updated_at=NOW(),last_error=$2
                WHERE task_id=$1
                RETURNING state
                """,
                task_id,
                str(error or "confirmation failed")[:500],
                max(1, int(retry_seconds or 5)),
            )
        return str((row or {}).get("state") or "")
