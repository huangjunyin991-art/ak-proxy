from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any, Callable


class WsTicketRepository:
    def __init__(self, pool_supplier: Callable[[], Any]):
        self._pool_supplier = pool_supplier

    async def ensure_schema(self) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS ws_tickets (
                    token_hash TEXT PRIMARY KEY,
                    audience TEXT NOT NULL,
                    subject TEXT NOT NULL,
                    role TEXT DEFAULT '',
                    resource_type TEXT DEFAULT '',
                    resource_id TEXT DEFAULT '',
                    site TEXT DEFAULT '',
                    readonly BOOLEAN DEFAULT FALSE,
                    claims JSONB DEFAULT '{}'::jsonb,
                    issued_at TIMESTAMP NOT NULL,
                    expires_at TIMESTAMP NOT NULL,
                    consumed_at TIMESTAMP,
                    client_ip TEXT DEFAULT '',
                    user_agent TEXT DEFAULT '',
                    consume_ip TEXT DEFAULT '',
                    consume_user_agent TEXT DEFAULT ''
                )
            """)
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_ws_tickets_expires_at ON ws_tickets(expires_at)")
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_ws_tickets_subject_audience ON ws_tickets(subject, audience)")
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_ws_tickets_resource ON ws_tickets(audience, resource_type, resource_id)")
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS ws_ticket_events (
                    id BIGSERIAL PRIMARY KEY,
                    event_type TEXT NOT NULL,
                    code TEXT DEFAULT '',
                    audience TEXT DEFAULT '',
                    subject TEXT DEFAULT '',
                    role TEXT DEFAULT '',
                    resource_type TEXT DEFAULT '',
                    resource_id TEXT DEFAULT '',
                    site TEXT DEFAULT '',
                    client_ip TEXT DEFAULT '',
                    user_agent TEXT DEFAULT '',
                    created_at TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """)
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_ws_ticket_events_created_at ON ws_ticket_events(created_at DESC)")
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_ws_ticket_events_type_audience_created_at ON ws_ticket_events(event_type, audience, created_at DESC)")
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_ws_ticket_events_code_created_at ON ws_ticket_events(code, created_at DESC)")

    async def insert_ticket(
        self,
        *,
        token_hash: str,
        audience: str,
        subject: str,
        role: str,
        resource_type: str,
        resource_id: str,
        site: str,
        readonly: bool,
        claims: dict[str, Any],
        issued_at: datetime,
        expires_at: datetime,
        client_ip: str = "",
        user_agent: str = "",
    ) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO ws_tickets (
                    token_hash, audience, subject, role, resource_type, resource_id,
                    site, readonly, claims, issued_at, expires_at, client_ip, user_agent
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
                """,
                token_hash,
                audience,
                subject,
                role,
                resource_type,
                resource_id,
                site,
                bool(readonly),
                json.dumps(claims if isinstance(claims, dict) else {}, ensure_ascii=False),
                issued_at,
                expires_at,
                str(client_ip or "")[:120],
                str(user_agent or "")[:300],
            )

    async def consume_ticket(
        self,
        *,
        token_hash: str,
        audience: str,
        consume_ip: str = "",
        consume_user_agent: str = "",
        now: datetime | None = None,
    ):
        pool = self._pool_supplier()
        current = (now or datetime.now()).replace(microsecond=0)
        async with pool.acquire() as conn:
            try:
                await conn.execute(
                    "DELETE FROM ws_tickets WHERE expires_at < $1",
                    current - timedelta(hours=1),
                )
            except Exception:
                pass
            return await conn.fetchrow(
                """
                UPDATE ws_tickets
                SET consumed_at = $2,
                    consume_ip = $3,
                    consume_user_agent = $4
                WHERE token_hash = $1
                  AND audience = $5
                  AND consumed_at IS NULL
                  AND expires_at > $2
                RETURNING audience, subject, role, resource_type, resource_id, site,
                          readonly, claims, issued_at, expires_at
                """,
                token_hash,
                current,
                str(consume_ip or "")[:120],
                str(consume_user_agent or "")[:300],
                audience,
            )

    async def record_event(
        self,
        *,
        event_type: str,
        code: str = "",
        audience: str = "",
        subject: str = "",
        role: str = "",
        resource_type: str = "",
        resource_id: str = "",
        site: str = "",
        client_ip: str = "",
        user_agent: str = "",
        created_at: datetime | None = None,
    ) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO ws_ticket_events (
                    event_type, code, audience, subject, role, resource_type,
                    resource_id, site, client_ip, user_agent, created_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                """,
                str(event_type or "")[:40],
                str(code or "")[:80],
                str(audience or "")[:40],
                str(subject or "")[:120],
                str(role or "")[:40],
                str(resource_type or "")[:80],
                str(resource_id or "")[:160],
                str(site or "")[:80],
                str(client_ip or "")[:120],
                str(user_agent or "")[:300],
                (created_at or datetime.now()).replace(microsecond=0),
            )
