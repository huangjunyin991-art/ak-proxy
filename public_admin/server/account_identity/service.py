from __future__ import annotations

from typing import Any, Callable


def normalize_account_username(value: str) -> str:
    return str(value or "").strip().lower()


class AccountIdentityService:
    def __init__(self, pool_supplier: Callable[[], Any]):
        self._pool_supplier = pool_supplier

    async def ensure_schema(self, conn=None) -> None:
        if conn is not None:
            await self._ensure_schema(conn)
            return
        pool = self._pool_supplier()
        async with pool.acquire() as owned_conn:
            await self._ensure_schema(owned_conn)

    async def _ensure_schema(self, conn) -> None:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS account_identities (
                account_id BIGSERIAL PRIMARY KEY,
                canonical_username TEXT NOT NULL UNIQUE,
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
                last_renamed_at TIMESTAMP
            )
            """
        )
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS account_username_aliases (
                username TEXT PRIMARY KEY,
                account_id BIGINT NOT NULL REFERENCES account_identities(account_id) ON DELETE CASCADE,
                is_canonical BOOLEAN NOT NULL DEFAULT FALSE,
                created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
            """
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_account_username_aliases_account_id "
            "ON account_username_aliases(account_id)"
        )
        await conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_account_username_aliases_account_canonical "
            "ON account_username_aliases(account_id) WHERE is_canonical = TRUE"
        )

    async def ensure_identity(self, username: str) -> dict[str, Any]:
        normalized = normalize_account_username(username)
        if not normalized:
            return {}
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                return await self._ensure_identity_tx(conn, normalized)

    async def resolve_identity(self, username: str, auto_create: bool = False) -> dict[str, Any]:
        normalized = normalize_account_username(username)
        if not normalized:
            return {}
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await self._fetch_identity_row(conn, normalized)
                if row:
                    return await self._build_identity(conn, row)
                if not auto_create:
                    return {}
                return await self._ensure_identity_tx(conn, normalized)

    async def list_identity_usernames(self, username: str = "", account_id: int = 0) -> list[str]:
        normalized = normalize_account_username(username)
        if not normalized and not account_id:
            return []
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            resolved_account_id = int(account_id or 0)
            if not resolved_account_id:
                row = await self._fetch_identity_row(conn, normalized)
                if not row:
                    return []
                resolved_account_id = int(row["account_id"] or 0)
            return await self._list_usernames(conn, resolved_account_id)

    async def record_username_change(self, old_username: str, new_username: str) -> dict[str, Any]:
        source_username = normalize_account_username(old_username)
        target_username = normalize_account_username(new_username)
        if not source_username or not target_username:
            return {}
        if source_username == target_username:
            return await self.ensure_identity(source_username)
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            async with conn.transaction():
                current = await self._ensure_identity_tx(conn, source_username)
                account_id = int(current.get("account_id") or 0)
                existing_target = await self._fetch_identity_row(conn, target_username)
                if existing_target and int(existing_target["account_id"] or 0) != account_id:
                    existing_target_account_id = int(existing_target["account_id"] or 0)
                    alias_count = int(
                        await conn.fetchval(
                            "SELECT COUNT(*) FROM account_username_aliases WHERE account_id = $1",
                            existing_target_account_id,
                        )
                        or 0
                    )
                    if alias_count > 1:
                        raise ValueError("target_username_belongs_to_other_identity")
                    await conn.execute(
                        "DELETE FROM account_username_aliases WHERE username = $1",
                        target_username,
                    )
                    await conn.execute(
                        "DELETE FROM account_identities WHERE account_id = $1",
                        existing_target_account_id,
                    )
                await conn.execute(
                    "UPDATE account_username_aliases SET is_canonical = FALSE WHERE account_id = $1",
                    account_id,
                )
                await conn.execute(
                    """
                    INSERT INTO account_username_aliases (username, account_id, is_canonical, created_at, updated_at)
                    VALUES ($1, $2, TRUE, NOW(), NOW())
                    ON CONFLICT (username) DO UPDATE SET
                        account_id = EXCLUDED.account_id,
                        is_canonical = TRUE,
                        updated_at = NOW()
                    """,
                    target_username,
                    account_id,
                )
                await conn.execute(
                    """
                    UPDATE account_identities
                    SET canonical_username = $2,
                        updated_at = NOW(),
                        last_renamed_at = NOW()
                    WHERE account_id = $1
                    """,
                    account_id,
                    target_username,
                )
                refreshed = await self._fetch_identity_row(conn, target_username)
                return await self._build_identity(conn, refreshed)

    async def _ensure_identity_tx(self, conn, username: str) -> dict[str, Any]:
        row = await self._fetch_identity_row(conn, username)
        if row:
            return await self._build_identity(conn, row)
        created = await conn.fetchrow(
            """
            INSERT INTO account_identities (canonical_username, created_at, updated_at)
            VALUES ($1, NOW(), NOW())
            ON CONFLICT (canonical_username) DO UPDATE SET
                updated_at = account_identities.updated_at
            RETURNING account_id, canonical_username
            """,
            username,
        )
        account_id = int(created["account_id"] or 0)
        await conn.execute(
            """
            INSERT INTO account_username_aliases (username, account_id, is_canonical, created_at, updated_at)
            VALUES ($1, $2, TRUE, NOW(), NOW())
            ON CONFLICT (username) DO NOTHING
            """,
            username,
            account_id,
        )
        await conn.execute(
            "UPDATE account_username_aliases SET is_canonical = CASE WHEN username = $2 THEN TRUE ELSE FALSE END "
            "WHERE account_id = $1",
            account_id,
            username,
        )
        row = await self._fetch_identity_row(conn, username)
        return await self._build_identity(conn, row)

    async def _fetch_identity_row(self, conn, username: str):
        return await conn.fetchrow(
            """
            SELECT a.account_id,
                   a.username AS matched_username,
                   a.is_canonical,
                   i.canonical_username
            FROM account_username_aliases a
            JOIN account_identities i ON i.account_id = a.account_id
            WHERE a.username = $1
            """,
            username,
        )

    async def _list_usernames(self, conn, account_id: int) -> list[str]:
        rows = await conn.fetch(
            """
            SELECT username
            FROM account_username_aliases
            WHERE account_id = $1
            ORDER BY is_canonical DESC, updated_at DESC, username ASC
            """,
            account_id,
        )
        return [normalize_account_username(row["username"]) for row in rows if normalize_account_username(row["username"])]

    async def _build_identity(self, conn, row) -> dict[str, Any]:
        account_id = int(row["account_id"] or 0)
        canonical_username = normalize_account_username(row["canonical_username"])
        matched_username = normalize_account_username(row["matched_username"])
        usernames = await self._list_usernames(conn, account_id)
        return {
            "account_id": account_id,
            "canonical_username": canonical_username,
            "matched_username": matched_username,
            "is_canonical_match": bool(row["is_canonical"]),
            "usernames": usernames,
        }
