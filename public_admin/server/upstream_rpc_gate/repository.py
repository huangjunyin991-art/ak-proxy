from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Callable


class UpstreamRpcGateRepository:
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
                    CREATE TABLE IF NOT EXISTS upstream_rpc_call_locks (
                        lock_key TEXT PRIMARY KEY,
                        holder TEXT NOT NULL DEFAULT '',
                        lease_expires_at TIMESTAMP NULL,
                        external_priority_until TIMESTAMP NULL,
                        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
                    )
                    """
                )
            self._ready = True

    async def try_claim(
        self,
        identity: str,
        holder: str,
        *,
        external: bool,
    ) -> bool:
        await self.ensure_ready()
        account_key = "account:" + (str(identity or "").strip() or "unknown")
        # The historical __global__ row is intentionally left in the schema
        # for in-place upgrades, but is no longer part of the active lock.
        keys = [account_key]
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                for key in keys:
                    await conn.execute(
                        "INSERT INTO upstream_rpc_call_locks (lock_key) VALUES ($1) ON CONFLICT DO NOTHING",
                        key,
                    )
                rows = await conn.fetch(
                    """
                    SELECT lock_key, lease_expires_at
                    FROM upstream_rpc_call_locks
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
                    UPDATE upstream_rpc_call_locks
                    SET holder = $2, lease_expires_at = NOW() + INTERVAL '30 seconds', updated_at = NOW()
                    WHERE lock_key = ANY($1::text[])
                    """,
                    keys,
                    holder,
                )
        return True

    async def release(self, identity: str, holder: str) -> None:
        await self.ensure_ready()
        account_key = "account:" + (str(identity or "").strip() or "unknown")
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE upstream_rpc_call_locks
                SET holder = '', lease_expires_at = NULL, updated_at = NOW()
                WHERE lock_key = ANY($1::text[]) AND holder = $2
                """,
                [account_key],
                holder,
            )
