from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Any, Callable, Mapping


def _account_rows(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            value = []
    if not isinstance(value, list):
        return []
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, Mapping):
            continue
        account = str(item.get("account") or "").strip().lower()
        raw_enabled = item.get("enabled", True)
        enabled = (
            str(raw_enabled).strip().lower() not in {"0", "false", "no", "off"}
            if isinstance(raw_enabled, str)
            else bool(raw_enabled)
        )
        if account and account not in seen:
            seen.add(account)
            result.append({"account": account, "enabled": enabled})
    return result


def _accounts(value: Any) -> list[str]:
    return [str(item["account"]) for item in _account_rows(value)]


def _account_names(value: Any) -> list[str]:
    """Normalize account parameters passed between repository methods."""
    if not isinstance(value, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for item in value:
        account = (
            str(item.get("account") or "").strip().lower()
            if isinstance(item, Mapping)
            else str(item or "").strip().lower()
        )
        if account and account not in seen:
            seen.add(account)
            result.append(account)
    return result


def _enabled_accounts(value: Any) -> list[str]:
    return [str(item["account"]) for item in _account_rows(value) if item["enabled"]]


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
                        interval_milliseconds BIGINT NOT NULL DEFAULT 1000,
                        trading_password TEXT NOT NULL DEFAULT '',
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
                    ALTER TABLE ep_auto_purchase_config
                    ADD COLUMN IF NOT EXISTS interval_milliseconds BIGINT
                    """
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_config "
                    "ADD COLUMN IF NOT EXISTS trading_password TEXT NOT NULL DEFAULT ''"
                )
                await conn.execute(
                    """
                    UPDATE ep_auto_purchase_config
                    SET interval_milliseconds = GREATEST(1, COALESCE(interval_seconds, 1)::BIGINT * 1000)
                    WHERE interval_milliseconds IS NULL
                    """
                )
                await conn.execute(
                    """
                    ALTER TABLE ep_auto_purchase_config
                    ALTER COLUMN interval_milliseconds SET DEFAULT 1000,
                    ALTER COLUMN interval_milliseconds SET NOT NULL
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
                    CREATE TABLE IF NOT EXISTS ep_auto_purchase_account_credentials (
                        account TEXT PRIMARY KEY,
                        trading_password TEXT NOT NULL DEFAULT '',
                        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
                    )
                    """
                )
                await conn.execute(
                    """
                    INSERT INTO ep_auto_purchase_account_credentials (account, trading_password)
                    SELECT legacy_account.value->>'account', config.trading_password
                    FROM ep_auto_purchase_config config
                    CROSS JOIN LATERAL jsonb_array_elements(config.accounts_json)
                        AS legacy_account(value)
                    WHERE config.slot = 1
                      AND jsonb_typeof(legacy_account.value) = 'object'
                      AND NULLIF(legacy_account.value->>'account', '') IS NOT NULL
                      AND NULLIF(config.trading_password, '') IS NOT NULL
                    ON CONFLICT (account) DO NOTHING
                    """
                )
                await conn.execute(
                    """
                    UPDATE ep_auto_purchase_config
                    SET trading_password = '', updated_at = NOW()
                    WHERE slot = 1 AND trading_password <> ''
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
                    ALTER TABLE ep_auto_purchase_account_status
                    ADD COLUMN IF NOT EXISTS unique_listings_discovered BIGINT NOT NULL DEFAULT 0
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
                        state TEXT NOT NULL DEFAULT 'pending',
                        message TEXT NOT NULL DEFAULT '',
                        next_attempt_at TIMESTAMP NULL,
                        attempt_started_at TIMESTAMP NULL,
                        seller_lookup_state TEXT NOT NULL DEFAULT 'pending',
                        seller_lookup_next_at TIMESTAMP NULL,
                        seller_lookup_started_at TIMESTAMP NULL,
                        seller_lookup_attempts INTEGER NOT NULL DEFAULT 0,
                        seller_lookup_error TEXT NOT NULL DEFAULT '',
                        notification_state TEXT NOT NULL DEFAULT 'pending',
                        notification_next_at TIMESTAMP NULL,
                        notification_started_at TIMESTAMP NULL,
                        notification_attempts INTEGER NOT NULL DEFAULT 0,
                        notification_error TEXT NOT NULL DEFAULT '',
                        payment_state TEXT NOT NULL DEFAULT 'pending',
                        payment_message TEXT NOT NULL DEFAULT '',
                        payment_started_at TIMESTAMP NULL,
                        payment_confirmed_at TIMESTAMP NULL,
                        cancel_state TEXT NOT NULL DEFAULT 'pending',
                        cancel_message TEXT NOT NULL DEFAULT '',
                        cancel_started_at TIMESTAMP NULL,
                        cancel_confirmed_at TIMESTAMP NULL,
                        claimed_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        completed_at TIMESTAMP NULL,
                        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
                    )
                    """
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMP NULL"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS attempt_started_at TIMESTAMP NULL"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS seller_lookup_state TEXT NOT NULL DEFAULT 'pending'"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS seller_lookup_next_at TIMESTAMP NULL"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS seller_lookup_started_at TIMESTAMP NULL"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS seller_lookup_attempts INTEGER NOT NULL DEFAULT 0"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS seller_lookup_error TEXT NOT NULL DEFAULT ''"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS notification_state TEXT NOT NULL DEFAULT 'pending'"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS notification_next_at TIMESTAMP NULL"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS notification_started_at TIMESTAMP NULL"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS notification_attempts INTEGER NOT NULL DEFAULT 0"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS notification_error TEXT NOT NULL DEFAULT ''"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS payment_state TEXT NOT NULL DEFAULT 'pending'"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS payment_message TEXT NOT NULL DEFAULT ''"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS payment_started_at TIMESTAMP NULL"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMP NULL"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS cancel_state TEXT NOT NULL DEFAULT 'pending'"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS cancel_message TEXT NOT NULL DEFAULT ''"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS cancel_started_at TIMESTAMP NULL"
                )
                await conn.execute(
                    "ALTER TABLE ep_auto_purchase_orders ADD COLUMN IF NOT EXISTS cancel_confirmed_at TIMESTAMP NULL"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_ep_auto_purchase_orders_claimed_at "
                    "ON ep_auto_purchase_orders(claimed_at DESC)"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_ep_auto_purchase_orders_pending "
                    "ON ep_auto_purchase_orders(state, next_attempt_at)"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_ep_auto_purchase_orders_seller_lookup "
                    "ON ep_auto_purchase_orders(buyer_account, seller_lookup_state, seller_lookup_next_at)"
                )
                await conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_ep_auto_purchase_orders_notification "
                    "ON ep_auto_purchase_orders(state, notification_state, notification_next_at)"
                )
                await conn.execute(
                    """
                    UPDATE ep_auto_purchase_orders
                    SET state = 'unknown',
                        message = CASE WHEN message = '' THEN '服务重启时购买结果无法确认' ELSE message END,
                        completed_at = COALESCE(completed_at, NOW()),
                        updated_at = NOW()
                    WHERE state IN ('claimed', 'sending')
                    """
                )
                await conn.execute(
                    """
                    UPDATE ep_auto_purchase_orders
                    SET payment_state = 'unknown', payment_started_at = NULL,
                        payment_message = CASE
                            WHEN payment_message = '' THEN '服务重启时付款确认结果无法确认'
                            ELSE payment_message
                        END,
                        updated_at = NOW()
                    WHERE payment_state = 'confirming'
                    """
                )
                await conn.execute(
                    """
                    UPDATE ep_auto_purchase_orders
                    SET cancel_state = 'unknown', cancel_started_at = NULL,
                        cancel_message = CASE
                            WHEN cancel_message = '' THEN '服务重启时取消购买结果无法确认'
                            ELSE cancel_message
                        END,
                        updated_at = NOW()
                    WHERE cancel_state = 'cancelling'
                    """
                )
                await conn.execute(
                    """
                    UPDATE ep_auto_purchase_orders
                    SET seller_lookup_state = CASE
                            WHEN BTRIM(seller_account) <> '' THEN 'complete'
                            ELSE 'pending'
                        END,
                        seller_lookup_next_at = CASE
                            WHEN BTRIM(seller_account) <> '' THEN NULL
                            ELSE COALESCE(seller_lookup_next_at, NOW())
                        END,
                        seller_lookup_started_at = NULL,
                        seller_lookup_error = CASE
                            WHEN BTRIM(seller_account) <> '' THEN ''
                            ELSE seller_lookup_error
                        END,
                        updated_at = NOW()
                    WHERE seller_lookup_state = 'pending'
                    """
                )
                await conn.execute(
                    """
                    UPDATE ep_auto_purchase_orders
                    SET seller_lookup_state = 'pending', seller_lookup_next_at = NOW(),
                        seller_lookup_started_at = NULL, updated_at = NOW()
                    WHERE seller_lookup_state = 'running' AND BTRIM(seller_account) = ''
                    """
                )
                await conn.execute(
                    """
                    UPDATE ep_auto_purchase_orders
                    SET notification_state = 'pending', notification_next_at = NOW(),
                        notification_started_at = NULL, updated_at = NOW()
                    WHERE state = 'success' AND notification_state = 'sending'
                    """
                )
                # The first rollout must not replay every historical successful order.
                # New successful orders always receive notification_next_at in finish_order.
                await conn.execute(
                    """
                    UPDATE ep_auto_purchase_orders
                    SET notification_state = 'sent', notification_error = '', updated_at = NOW()
                    WHERE state = 'success'
                      AND notification_state = 'pending'
                      AND notification_next_at IS NULL
                      AND notification_started_at IS NULL
                      AND notification_attempts = 0
                    """
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
        account_rows = _account_rows(result.pop("accounts_json", []))
        result["accounts"] = [str(item["account"]) for item in account_rows]
        result["enabled_accounts"] = [
            str(item["account"]) for item in account_rows if bool(item["enabled"])
        ]
        result["account_enabled"] = {
            str(item["account"]): bool(item["enabled"])
            for item in account_rows
        }
        result.pop("trading_password", None)
        interval_milliseconds = max(1, int(result.get("interval_milliseconds") or 1000))
        result["interval_milliseconds"] = interval_milliseconds
        result["interval_seconds"] = (
            interval_milliseconds // 1000
            if interval_milliseconds % 1000 == 0
            else interval_milliseconds / 1000
        )
        return result

    async def get_trading_password(self, account: str) -> str:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            value = await conn.fetchval(
                """
                SELECT COALESCE(
                    NULLIF(credentials.trading_password, ''),
                    NULLIF(config.trading_password, ''),
                    ''
                )
                FROM ep_auto_purchase_config config
                LEFT JOIN ep_auto_purchase_account_credentials credentials
                  ON credentials.account = $1
                WHERE config.slot = 1
                """,
                str(account or "").strip().lower(),
            )
        return str(value or "")

    async def list_trading_password_accounts(self, accounts: list[str]) -> set[str]:
        normalized = _account_names(accounts)
        if not normalized:
            return set()
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT requested.account
                FROM unnest($1::text[]) AS requested(account)
                CROSS JOIN ep_auto_purchase_config config
                LEFT JOIN ep_auto_purchase_account_credentials credentials
                  ON credentials.account = requested.account
                WHERE config.slot = 1
                  AND COALESCE(
                      NULLIF(credentials.trading_password, ''),
                      NULLIF(config.trading_password, ''),
                      ''
                  ) <> ''
                """,
                normalized,
            )
        return {str(row["account"] or "").strip().lower() for row in rows}

    async def save_config(
        self,
        account_rows: list[Mapping[str, Any]],
        interval_milliseconds: int,
        enabled: bool,
        trading_passwords: Mapping[str, str] | None = None,
    ) -> dict[str, Any]:
        await self.ensure_ready()
        normalized_rows = _account_rows(account_rows)
        normalized_accounts = [str(item["account"]) for item in normalized_rows]
        encoded = json.dumps(normalized_rows, ensure_ascii=False)
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE ep_auto_purchase_config
                SET enabled = $1,
                    interval_seconds = GREATEST(1, CEIL($2::numeric / 1000)::INTEGER),
                    interval_milliseconds = $2,
                    accounts_json = $3::jsonb,
                    rotation_cursor = CASE WHEN accounts_json = $3::jsonb THEN rotation_cursor ELSE 0 END,
                    next_poll_at = NOW(),
                    lease_owner = '', lease_expires_at = NULL, current_account = '', updated_at = NOW()
                WHERE slot = 1
                """,
                bool(enabled),
                max(1, int(interval_milliseconds)),
                encoded,
            )
            if normalized_accounts:
                await conn.executemany(
                    """
                    INSERT INTO ep_auto_purchase_account_status (account)
                    VALUES ($1) ON CONFLICT (account) DO NOTHING
                    """,
                    [(account,) for account in normalized_accounts],
                )
            updates = [
                (str(account or "").strip().lower(), str(password or ""))
                for account, password in (trading_passwords or {}).items()
                if str(account or "").strip() and str(password or "")
            ]
            if updates:
                await conn.executemany(
                    """
                    INSERT INTO ep_auto_purchase_account_credentials
                        (account, trading_password, updated_at)
                    VALUES ($1, $2, NOW())
                    ON CONFLICT (account) DO UPDATE
                    SET trading_password = EXCLUDED.trading_password,
                        updated_at = NOW()
                    """,
                    updates,
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
                accounts = _enabled_accounts(row["accounts_json"])
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
                return {
                    "account": account,
                    "interval_milliseconds": max(1, int(row["interval_milliseconds"] or 1000)),
                }

    async def finish_poll(
        self,
        owner: str,
        account: str,
        *,
        state: str,
        unique_listings_discovered: int = 0,
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
                        account, state, total_polls, listings_seen, unique_listings_discovered, purchase_successes,
                        consecutive_failures, retry_after, last_poll_at, last_success_at, last_error, updated_at
                    ) VALUES (
                        $1, $2, CASE WHEN $7 THEN 1 ELSE 0 END, 0, $3, $4,
                        CASE WHEN $5 = '' THEN 0 ELSE 1 END,
                        CASE WHEN $6 > 0 THEN NOW() + make_interval(secs => $6) ELSE NULL END,
                        CASE WHEN $7 THEN NOW() ELSE NULL END,
                        CASE WHEN $5 = '' AND $7 THEN NOW() ELSE NULL END,
                        $5, NOW()
                    )
                    ON CONFLICT (account) DO UPDATE SET
                        state = EXCLUDED.state,
                        total_polls = ep_auto_purchase_account_status.total_polls + CASE WHEN $7 THEN 1 ELSE 0 END,
                        unique_listings_discovered = ep_auto_purchase_account_status.unique_listings_discovered + $3,
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
                    max(0, int(unique_listings_discovered)),
                    max(0, int(purchase_successes)),
                    str(error or "")[:500],
                    max(0, int(retry_seconds)),
                    bool(count_poll),
                )
                await conn.execute(
                    """
                    UPDATE ep_auto_purchase_config
                    SET lease_owner = '', lease_expires_at = NULL, current_account = '',
                        next_poll_at = NOW() + interval_milliseconds * INTERVAL '1 millisecond',
                        updated_at = NOW()
                    WHERE slot = 1 AND lease_owner = $1
                    """,
                    owner,
                )

    async def register_listing(
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
            row = await conn.fetchrow(
                """
                INSERT INTO ep_auto_purchase_orders (
                    sid, buyer_account, seller_account, ep_amount, sokey_digest, state, next_attempt_at,
                    seller_lookup_state, seller_lookup_next_at
                ) VALUES (
                    $1, $2, $3, $4, $5, 'pending', NOW(),
                    CASE WHEN BTRIM($3) <> '' THEN 'complete' ELSE 'pending' END,
                    CASE WHEN BTRIM($3) <> '' THEN NULL ELSE NOW() END
                )
                ON CONFLICT (sid) DO UPDATE
                SET seller_account = CASE
                        WHEN BTRIM(ep_auto_purchase_orders.seller_account) = ''
                             AND BTRIM(EXCLUDED.seller_account) <> ''
                        THEN EXCLUDED.seller_account
                        ELSE ep_auto_purchase_orders.seller_account
                    END,
                    seller_lookup_state = CASE
                        WHEN BTRIM(ep_auto_purchase_orders.seller_account) = ''
                             AND BTRIM(EXCLUDED.seller_account) <> ''
                        THEN 'complete'
                        ELSE ep_auto_purchase_orders.seller_lookup_state
                    END,
                    seller_lookup_next_at = CASE
                        WHEN BTRIM(ep_auto_purchase_orders.seller_account) = ''
                             AND BTRIM(EXCLUDED.seller_account) <> ''
                        THEN NULL
                        ELSE ep_auto_purchase_orders.seller_lookup_next_at
                    END,
                    seller_lookup_error = CASE
                        WHEN BTRIM(ep_auto_purchase_orders.seller_account) = ''
                             AND BTRIM(EXCLUDED.seller_account) <> ''
                        THEN ''
                        ELSE ep_auto_purchase_orders.seller_lookup_error
                    END,
                    updated_at = CASE
                        WHEN BTRIM(ep_auto_purchase_orders.seller_account) = ''
                             AND BTRIM(EXCLUDED.seller_account) <> ''
                        THEN NOW()
                        ELSE ep_auto_purchase_orders.updated_at
                    END
                RETURNING (xmax = 0) AS inserted
                """,
                sid,
                buyer_account,
                seller_account,
                ep_amount,
                sokey_digest,
            )
        return bool(row and row["inserted"])

    async def begin_order_attempt(
        self,
        sid: str,
        buyer_account: str,
        seller_account: str,
        ep_amount: str,
        sokey_digest: str,
    ) -> bool:
        """Atomically move a pending order to sending before EP_Buy is forwarded."""
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE ep_auto_purchase_orders
                SET state = 'sending', buyer_account = $2, seller_account = $3, ep_amount = $4,
                    sokey_digest = $5, message = '', next_attempt_at = NULL,
                    attempt_started_at = NOW(), completed_at = NULL, updated_at = NOW()
                WHERE sid = $1
                  AND state = 'pending'
                  AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
                RETURNING sid
                """,
                str(sid or ""),
                str(buyer_account or "").strip().lower(),
                str(seller_account or "").strip(),
                str(ep_amount or "").strip(),
                str(sokey_digest or ""),
            )
        return row is not None

    async def defer_order(self, sid: str, buyer_account: str, message: str, retry_seconds: float = 1.0) -> None:
        """Return a request known not to reach the upstream to the pending queue."""
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE ep_auto_purchase_orders
                SET state = 'pending', buyer_account = $2, message = $3,
                    next_attempt_at = NOW() + make_interval(secs => $4),
                    attempt_started_at = NULL, completed_at = NULL, updated_at = NOW()
                WHERE sid = $1 AND state = 'sending'
                """,
                str(sid or ""),
                str(buyer_account or "").strip().lower(),
                str(message or "等待用户请求优先")[:500],
                max(0.1, float(retry_seconds or 1.0)),
            )

    async def finish_order(self, sid: str, state: str, message: str) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE ep_auto_purchase_orders
                SET state = $2, message = $3, next_attempt_at = NULL,
                    notification_state = CASE WHEN $2 = 'success' THEN 'pending' ELSE notification_state END,
                    notification_next_at = CASE WHEN $2 = 'success' THEN NOW() ELSE notification_next_at END,
                    notification_started_at = CASE WHEN $2 = 'success' THEN NULL ELSE notification_started_at END,
                    notification_error = CASE WHEN $2 = 'success' THEN '' ELSE notification_error END,
                    completed_at = NOW(), updated_at = NOW()
                WHERE sid = $1 AND state = 'sending'
                """,
                sid,
                state,
                str(message or "")[:500],
            )

    async def begin_payment_confirmation(self, sid: str) -> dict[str, Any] | None:
        """Claim one successful purchase before forwarding EP_Confirm_Payment."""
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE ep_auto_purchase_orders
                SET payment_state = 'confirming', payment_message = '',
                    payment_started_at = NOW(), updated_at = NOW()
                WHERE sid = $1
                  AND state = 'success'
                  AND payment_state IN ('pending', 'failed')
                  AND cancel_state IN ('pending', 'failed')
                RETURNING sid, buyer_account, payment_state
                """,
                str(sid or "").strip(),
            )
        return dict(row) if row else None

    async def get_payment_order(self, sid: str) -> dict[str, Any] | None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT sid, buyer_account, state, payment_state, payment_message,
                       payment_started_at, payment_confirmed_at,
                       cancel_state, cancel_message, cancel_started_at, cancel_confirmed_at
                FROM ep_auto_purchase_orders
                WHERE sid = $1
                """,
                str(sid or "").strip(),
            )
        return dict(row) if row else None

    async def finish_payment_confirmation(self, sid: str, state: str, message: str) -> None:
        normalized_state = str(state or "failed").strip().lower()
        if normalized_state not in {"confirmed", "failed", "unknown", "pending"}:
            normalized_state = "failed"
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE ep_auto_purchase_orders
                SET payment_state = $2, payment_message = $3,
                    payment_started_at = NULL,
                    payment_confirmed_at = CASE
                        WHEN $2 = 'confirmed' THEN NOW()
                        ELSE payment_confirmed_at
                    END,
                    updated_at = NOW()
                WHERE sid = $1 AND payment_state = 'confirming'
                """,
                str(sid or "").strip(),
                normalized_state,
                str(message or "")[:500],
            )

    async def begin_purchase_cancellation(self, sid: str) -> dict[str, Any] | None:
        """Claim one successful, unpaid order before forwarding EP_Cancel_Buy."""
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                UPDATE ep_auto_purchase_orders
                SET cancel_state = 'cancelling', cancel_message = '',
                    cancel_started_at = NOW(), updated_at = NOW()
                WHERE sid = $1
                  AND state = 'success'
                  AND payment_state IN ('pending', 'failed')
                  AND cancel_state IN ('pending', 'failed')
                RETURNING sid, buyer_account, payment_state, cancel_state
                """,
                str(sid or "").strip(),
            )
        return dict(row) if row else None

    async def get_cancellation_order(self, sid: str) -> dict[str, Any] | None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT sid, buyer_account, state, payment_state, payment_message,
                       cancel_state, cancel_message, cancel_started_at, cancel_confirmed_at
                FROM ep_auto_purchase_orders
                WHERE sid = $1
                """,
                str(sid or "").strip(),
            )
        return dict(row) if row else None

    async def finish_purchase_cancellation(self, sid: str, state: str, message: str) -> None:
        normalized_state = str(state or "failed").strip().lower()
        if normalized_state not in {"cancelled", "failed", "unknown", "pending"}:
            normalized_state = "failed"
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE ep_auto_purchase_orders
                SET cancel_state = $2, cancel_message = $3,
                    cancel_started_at = NULL,
                    cancel_confirmed_at = CASE
                        WHEN $2 = 'cancelled' THEN NOW()
                        ELSE cancel_confirmed_at
                    END,
                    updated_at = NOW()
                WHERE sid = $1 AND cancel_state = 'cancelling'
                """,
                str(sid or "").strip(),
                normalized_state,
                str(message or "")[:500],
            )

    async def claim_next_success_notification(self) -> dict[str, Any] | None:
        """Reserve one successful order for durable, at-least-once notification delivery."""
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                WITH candidate AS (
                    SELECT sid
                    FROM ep_auto_purchase_orders
                    WHERE state = 'success'
                      AND notification_state = 'pending'
                      AND (notification_next_at IS NULL OR notification_next_at <= NOW())
                    ORDER BY completed_at ASC NULLS FIRST, sid ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                UPDATE ep_auto_purchase_orders AS orders
                SET notification_state = 'sending', notification_next_at = NULL,
                    notification_started_at = NOW(), notification_attempts = notification_attempts + 1,
                    notification_error = '', updated_at = NOW()
                FROM candidate
                WHERE orders.sid = candidate.sid
                RETURNING orders.sid, orders.buyer_account, orders.seller_account, orders.ep_amount,
                          orders.notification_attempts
                """
            )
        return dict(row) if row else None

    async def finish_success_notification(self, sid: str) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE ep_auto_purchase_orders
                SET notification_state = 'sent', notification_next_at = NULL,
                    notification_started_at = NULL, notification_error = '', updated_at = NOW()
                WHERE sid = $1 AND state = 'success' AND notification_state = 'sending'
                """,
                str(sid or ""),
            )

    async def defer_success_notification(self, sid: str, error: str, retry_seconds: float = 60.0) -> None:
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE ep_auto_purchase_orders
                SET notification_state = 'pending',
                    notification_next_at = NOW() + make_interval(secs => $2),
                    notification_started_at = NULL, notification_error = $3, updated_at = NOW()
                WHERE sid = $1 AND state = 'success' AND notification_state = 'sending'
                """,
                str(sid or ""),
                max(1.0, float(retry_seconds or 60.0)),
                str(error or "通知派送失败")[:500],
            )

    async def claim_next_seller_lookup(self, buyer_account: str) -> dict[str, Any] | None:
        """Reserve one missing seller account for a safe, serialized detail lookup."""
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                WITH candidate AS (
                    SELECT sid
                    FROM ep_auto_purchase_orders
                    WHERE buyer_account = $1
                      AND BTRIM(seller_account) = ''
                      AND seller_lookup_state = 'pending'
                      AND (seller_lookup_next_at IS NULL OR seller_lookup_next_at <= NOW())
                    ORDER BY claimed_at ASC
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                )
                UPDATE ep_auto_purchase_orders AS orders
                SET seller_lookup_state = 'running', seller_lookup_next_at = NULL,
                    seller_lookup_started_at = NOW(), seller_lookup_attempts = seller_lookup_attempts + 1,
                    seller_lookup_error = '', updated_at = NOW()
                FROM candidate
                WHERE orders.sid = candidate.sid
                RETURNING orders.sid, orders.buyer_account
                """,
                str(buyer_account or "").strip().lower(),
            )
        return dict(row) if row is not None else None

    async def finish_seller_lookup(self, sid: str, seller_account: str) -> None:
        """Save only the seller account extracted from Public_EP_SellDetail."""
        await self.ensure_ready()
        normalized_seller = str(seller_account or "").strip()
        state = "complete" if normalized_seller else "empty"
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE ep_auto_purchase_orders
                SET seller_account = CASE WHEN $2 <> '' THEN $2 ELSE seller_account END,
                    seller_lookup_state = $3, seller_lookup_next_at = NULL,
                    seller_lookup_started_at = NULL, seller_lookup_error = '', updated_at = NOW()
                WHERE sid = $1 AND seller_lookup_state = 'running'
                """,
                str(sid or ""),
                normalized_seller,
                state,
            )

    async def defer_seller_lookup(self, sid: str, error: str, retry_seconds: int = 60) -> None:
        """Retry transient detail lookup failures without touching the purchase result."""
        await self.ensure_ready()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE ep_auto_purchase_orders
                SET seller_lookup_state = CASE WHEN seller_lookup_attempts >= 3 THEN 'failed' ELSE 'pending' END,
                    seller_lookup_next_at = CASE
                        WHEN seller_lookup_attempts >= 3 THEN NULL
                        ELSE NOW() + make_interval(secs => $3)
                    END,
                    seller_lookup_started_at = NULL, seller_lookup_error = $2, updated_at = NOW()
                WHERE sid = $1 AND seller_lookup_state = 'running'
                """,
                str(sid or ""),
                str(error or "详情查询失败")[:500],
                max(1, int(retry_seconds or 60)),
            )

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
                       payment_state, payment_message, payment_started_at, payment_confirmed_at,
                       cancel_state, cancel_message, cancel_started_at, cancel_confirmed_at,
                       claimed_at, completed_at
                FROM ep_auto_purchase_orders
                ORDER BY claimed_at DESC LIMIT 100
                """
            )
            summary = await conn.fetchrow(
                """
                SELECT COUNT(*)::int AS orders,
                       COUNT(*) FILTER (WHERE state = 'success')::int AS successes,
                       COUNT(*) FILTER (WHERE state = 'pending')::int AS pending,
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
