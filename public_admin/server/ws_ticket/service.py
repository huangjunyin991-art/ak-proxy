from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta
from typing import Any

from .models import WsTicketClaims, WsTicketIssue


class WsTicketError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class WsTicketService:
    def __init__(self, repository, *, ttl_seconds: int = 45, logger: Any = None):
        self.repository = repository
        self.ttl_seconds = max(10, min(300, int(ttl_seconds or 45)))
        self.logger = logger

    async def ensure_schema(self) -> None:
        if self.repository and hasattr(self.repository, "ensure_schema"):
            await self.repository.ensure_schema()

    async def issue(
        self,
        *,
        audience: str,
        subject: str,
        role: str = "",
        resource_type: str = "",
        resource_id: str = "",
        site: str = "",
        readonly: bool = False,
        claims: dict[str, Any] | None = None,
        client_ip: str = "",
        user_agent: str = "",
    ) -> WsTicketIssue:
        normalized_audience = self._normalize_required(audience, "audience").lower()
        normalized_subject = self._normalize_required(subject, "subject").lower()
        normalized_role = str(role or "").strip().lower()
        token = secrets.token_urlsafe(32)
        token_hash = self.hash_token(token)
        now = datetime.now().replace(microsecond=0)
        expires_at = now + timedelta(seconds=self.ttl_seconds)
        claim_model = WsTicketClaims(
            audience=normalized_audience,
            subject=normalized_subject,
            role=normalized_role,
            resource_type=str(resource_type or "").strip(),
            resource_id=str(resource_id or "").strip(),
            site=str(site or "").strip(),
            readonly=bool(readonly),
            claims=dict(claims or {}),
            issued_at=now,
            expires_at=expires_at,
        )
        await self.repository.insert_ticket(
            token_hash=token_hash,
            audience=claim_model.audience,
            subject=claim_model.subject,
            role=claim_model.role,
            resource_type=claim_model.resource_type,
            resource_id=claim_model.resource_id,
            site=claim_model.site,
            readonly=claim_model.readonly,
            claims=claim_model.claims,
            issued_at=now,
            expires_at=expires_at,
            client_ip=client_ip,
            user_agent=user_agent,
        )
        return WsTicketIssue(
            ticket=token,
            token_hash=token_hash,
            claims=claim_model,
            expires_in=self.ttl_seconds,
        )

    async def consume(
        self,
        *,
        ticket: str,
        audience: str,
        consume_ip: str = "",
        consume_user_agent: str = "",
    ) -> WsTicketClaims:
        normalized_ticket = str(ticket or "").strip()
        normalized_audience = self._normalize_required(audience, "audience").lower()
        if not normalized_ticket:
            raise WsTicketError("missing_ticket", "missing websocket ticket")
        row = await self.repository.consume_ticket(
            token_hash=self.hash_token(normalized_ticket),
            audience=normalized_audience,
            consume_ip=consume_ip,
            consume_user_agent=consume_user_agent,
        )
        if not row:
            raise WsTicketError("invalid_ticket", "websocket ticket is invalid, expired, or already used")
        claims = WsTicketClaims.from_row(row)
        if claims.audience != normalized_audience:
            raise WsTicketError("audience_mismatch", "websocket ticket audience mismatch")
        return claims

    @staticmethod
    def hash_token(token: str) -> str:
        return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()

    @staticmethod
    def _normalize_required(value: str, field: str) -> str:
        normalized = str(value or "").strip()
        if not normalized:
            raise WsTicketError(f"missing_{field}", f"missing {field}")
        return normalized
