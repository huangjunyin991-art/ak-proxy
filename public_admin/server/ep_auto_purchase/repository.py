from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Any, Callable, Mapping


def _accounts(value: Any) -> list[str]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            value = []
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        account = str(item or "").strip().lower()
        if account and account not in seen:
            seen.add(account)
            result.append(account)
    return result


class EPAutoPurchaseRepository:
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
                    CREATE TABLE IF NOT EXISTS ep_auto_purchase_config (
                        slot SMALLINT PRIMARY KEY DEFAULT 1 CHECK (slot = 1),
                        enabled BOOLEAN NOT NULL DEFAULT FALSE,
                        interval_seconds INTEGER NOT NULL DEFAULT 1,
                        accounts_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                        rotation_cursor INTEGER NOT NULL DEFAULT 0,
                        next_poll_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        lease_owner TEXT NOT NULL DEFAULT '',
                        lease_expires_at TIMESTAMP NULL,
                        current_account TEXT NOT NULL DEFAULT '',
                        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
                    )
                    """
                )
                await conn.execute(
                    """
                    INSERT INTO ep_auto_purchase_config (slot)
                    VALUES (1) ON CONFLICT (slot) DO NOTHING
                    """
                )
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS ep_auto_purchase_account_status (
                        account TEXT PRIMARY KEY,
                        state TEXT NOT NULL DEFAULT 'idle',
                        total_polls BIGINT NOT NULL DEFAULT 0,
                        listings_seen BIGINT NOT NULL DEFAULT 0,
                        purchase_successes BIGINT NOT NULL DEFAULT 0,
                        consecutive_failures INTEGER NOT NULL DEFAULT 0,
                        retry_after TIMESTAMP NULL,
                        last_poll_at TIMESTAMP NULL,
                        last_success_at TIMESTAMP NULL,
                        last_error TEXT NOT NULL DEFAULT '',
                        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
                    )
                    """
                )
                await conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS ep_auto_purchase_orders (
                        sid TEXT PRIMARY KEY,
                        buyer_account TEXT NOT NULL,
                        seller_account TEXT NOT NULL DEFAULT '',
                        ep_amount TEXT NOT NULL DEFAULT '',
                        sokey_digest TEXT NOT NULL,
                        state TEXT NOT NULL DEFAULT 'claimed',
                        message TEXT NOT NULL DEFAULT '',
                        claimed_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        completed_at TIMESTAMP NULL,
                        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
                    )
                    """
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_ep_auto_purchase_orders_claimed_at "
                    "ON ep_auto_purchase_orders(claimed_at DESC)"
                )
            self._ready = True

    async def list_active_accounts(self) -> list[dict[str, Any]]:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT aa.username, aa.nickname,
                       COALESCE(NULLIF(us.password, ''), NULLIF(aa.password, ''), '') <> '' AS has_password
                FROM authorized_accounts aa
                LEFT JOIN user_stats us ON us.username = aa.username
                WHERE aa.status = 'active' AND aa.expire_time >= NOW()
                ORDER BY aa.username
                """
            )
        return [dict(row) for row in rows]

    async def get_account_password(self, username: str) -> str:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            value = await conn.fetchval(
                """
                SELECT COALESCE(NULLIF(us.password, ''), NULLIF(aa.password, ''), '')
                FROM authorized_accounts aa
                LEFT JOIN user_stats us ON us.username = aa.username
                WHERE aa.username = $1
                """,
                str(username or "").strip().lower(),
            )
        return str(value or "").strip()

    async def get_config(self) -> dict[str, Any]:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM ep_auto_purchase_config WHERE slot = 1")
        result = dict(row or {})
        result["accounts"] = _accounts(result.pop("accounts_json", []))
        return result

    async def save_config(self, accounts: list[str], interval_seconds: int, enabled: bool) -> dict[str, Any]:
        await self.ensure_ready()
        encoded = json.dumps(accounts, ensure_ascii=False)
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE ep_auto_purchase_config
                SET enabled = $1,
                    interval_seconds = $2,
                    accounts_json = $3::jsonb,
                    rotation_cursor = CASE WHEN accounts_json = $3::jsonb THEN rotation_cursor ELSE 0 END,
                    next_poll_at = NOW(),
                    lease_owner = '', lease_expires_at = NULL, current_account = '', updated_at = NOW()
                WHERE slot = 1
                """,
                bool(enabled),
                int(interval_seconds),
                encoded,
            )
            await conn.execute(
                """
                INSERT INTO ep_auto_purchase_account_status (account)
                SELECT value FROM jsonb_array_elements_text($1::jsonb)
                ON CONFLICT (account) DO NOTHING
                """,
                encoded,
            )
        return await self.get_config()

    async def claim_next_poll(self, owner: str) -> dict[str, Any] | None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM ep_auto_purchase_config WHERE slot = 1 FOR UPDATE"
                )
                if not row or not row["enabled"] or row["next_poll_at"] > datetime.now():
                    return None
                if row["lease_expires_at"] and row["lease_expires_at"] > datetime.now():
                    return None
                accounts = _accounts(row["accounts_json"])
                if not accounts:
                    return None
                status_rows = await conn.fetch(
                    "SELECT account, retry_after FROM ep_auto_purchase_account_status WHERE account = ANY($1::text[])",
                    accounts,
                )
                retries = {str(item["account"]): item["retry_after"] for item in status_rows}
                cursor = max(0, int(row["rotation_cursor"] or 0)) % len(accounts)
                account = ""
                next_cursor = cursor
                now = datetime.now()
                for offset in range(len(accounts)):
                    index = (cursor + offset) % len(accounts)
                    candidate = accounts[index]
                    retry_after = retries.get(candidate)
                    if retry_after is None or retry_after <= now:
                        account = candidate
                        next_cursor = (index + 1) % len(accounts)
                        break
                if not account:
                    future = [value for value in retries.values() if value and value > now]
                    if future:
                        await conn.execute(
                            "UPDATE ep_auto_purchase_config SET next_poll_at = $1, updated_at = NOW() WHERE slot = 1",
                            min(future),
                        )
                    return None
                await conn.execute(
                    """
                    UPDATE ep_auto_purchase_config
                    SET rotation_cursor = $1, lease_owner = $2,
                        lease_expires_at = NOW() + INTERVAL '2 minutes', current_account = $3,
                        updated_at = NOW()
                    WHERE slot = 1
                    """,
                    next_cursor,
                    owner,
                    account,
                )
                return {"account": account, "interval_seconds": int(row["interval_seconds"] or 1)}

    async def finish_poll(
        self,
        owner: str,
        account: str,
        *,
        state: str,
        listings_seen: int = 0,
        purchase_successes: int = 0,
        error: str = "",
        retry_seconds: int = 0,
        count_poll: bool = True,
    ) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    INSERT INTO ep_auto_purchase_account_status (
                        account, state, total_polls, listings_seen, purchase_successes,
                        consecutive_failures, retry_after, last_poll_at, last_success_at, last_error, updated_at
                    ) VALUES (
                        $1, $2, CASE WHEN $7 THEN 1 ELSE 0 END, $3, $4,
                        CASE WHEN $5 = '' THEN 0 ELSE 1 END,
                        CASE WHEN $6 > 0 THEN NOW() + make_interval(secs => $6) ELSE NULL END,
                        CASE WHEN $7 THEN NOW() ELSE NULL END,
                        CASE WHEN $5 = '' AND $7 THEN NOW() ELSE NULL END,
                        $5, NOW()
                    )
                    ON CONFLICT (account) DO UPDATE SET
                        state = EXCLUDED.state,
                        total_polls = ep_auto_purchase_account_status.total_polls + CASE WHEN $7 THEN 1 ELSE 0 END,
                        listings_seen = ep_auto_purchase_account_status.listings_seen + $3,
                        purchase_successes = ep_auto_purchase_account_status.purchase_successes + $4,
                        consecutive_failures = CASE WHEN $5 = '' THEN 0 ELSE ep_auto_purchase_account_status.consecutive_failures + 1 END,
                        retry_after = EXCLUDED.retry_after,
                        last_poll_at = CASE WHEN $7 THEN NOW() ELSE ep_auto_purchase_account_status.last_poll_at END,
                        last_success_at = CASE WHEN $5 = '' AND $7 THEN NOW() ELSE ep_auto_purchase_account_status.last_success_at END,
                        last_error = $5,
                        updated_at = NOW()
                    """,
                    account,
                    state,
                    max(0, int(listings_seen)),
                    max(0, int(purchase_successes)),
                    str(error or "")[:500],
                    max(0, int(retry_seconds)),
                    bool(count_poll),
                )
                await conn.execute(
                    """
                    UPDATE ep_auto_purchase_config
                    SET lease_owner = '', lease_expires_at = NULL, current_account = '',
                        next_poll_at = NOW() + make_interval(secs => interval_seconds), updated_at = NOW()
                    WHERE slot = 1 AND lease_owner = $1
                    """,
                    owner,
                )

    async def claim_order(
        self,
        sid: str,
        buyer_account: str,
        seller_account: str,
        ep_amount: str,
        sokey_digest: str,
    ) -> bool:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                INSERT INTO ep_auto_purchase_orders (
                    sid, buyer_account, seller_account, ep_amount, sokey_digest
                ) VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (sid) DO NOTHING
                """,
                sid,
                buyer_account,
                seller_account,
                ep_amount,
                sokey_digest,
            )
        return result == "INSERT 0 1"

    async def finish_order(self, sid: str, state: str, message: str) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE ep_auto_purchase_orders
                SET state = $2, message = $3, completed_at = NOW(), updated_at = NOW()
                WHERE sid = $1
                """,
                sid,
                state,
                str(message or "")[:500],
            )

    async def release_order_claim(self, sid: str, buyer_account: str) -> bool:
        """Release only a claim that is known not to have reached the upstream."""
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                DELETE FROM ep_auto_purchase_orders
                WHERE sid = $1 AND buyer_account = $2 AND state = 'claimed'
                """,
                str(sid or ""),
                str(buyer_account or "").strip().lower(),
            )
        return result == "DELETE 1"

    async def dashboard(self) -> dict[str, Any]:
        config = await self.get_config()
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            statuses = await conn.fetch(
                """
                SELECT * FROM ep_auto_purchase_account_status
                WHERE account = ANY($1::text[])
                ORDER BY account
                """,
                config["accounts"] or [""],
            )
            orders = await conn.fetch(
                """
                SELECT sid, buyer_account, seller_account, ep_amount, state, message,
                       claimed_at, completed_at
                FROM ep_auto_purchase_orders
                ORDER BY claimed_at DESC LIMIT 100
                """
            )
            summary = await conn.fetchrow(
                """
                SELECT COUNT(*)::int AS orders,
                       COUNT(*) FILTER (WHERE state = 'success')::int AS successes,
                       COUNT(*) FILTER (WHERE state = 'unknown')::int AS unknown
                FROM ep_auto_purchase_orders
                """
            )
        return {
            "config": config,
            "accounts": [dict(row) for row in statuses],
            "orders": [dict(row) for row in orders],
            "summary": dict(summary or {}),
        }
