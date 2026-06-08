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
    def __init__(self, repository, *, ttl_seconds: int = 45, logger: Any = None, diagnostics_policy: Any = None):
        self.repository = repository
        self.ttl_seconds = max(10, min(300, int(ttl_seconds or 45)))
        self.logger = logger
        self.diagnostics_policy = diagnostics_policy

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
        await self._record_event_safe(
            event_type="issue",
            code="ok",
            claims=claim_model,
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
            await self.record_event(
                event_type="reject",
                code="missing_ticket",
                audience=normalized_audience,
                consume_ip=consume_ip,
                user_agent=consume_user_agent,
            )
            raise WsTicketError("missing_ticket", "missing websocket ticket")
        row = await self.repository.consume_ticket(
            token_hash=self.hash_token(normalized_ticket),
            audience=normalized_audience,
            consume_ip=consume_ip,
            consume_user_agent=consume_user_agent,
        )
        if not row:
            await self.record_event(
                event_type="reject",
                code="invalid_ticket",
                audience=normalized_audience,
                consume_ip=consume_ip,
                user_agent=consume_user_agent,
            )
            raise WsTicketError("invalid_ticket", "websocket ticket is invalid, expired, or already used")
        claims = WsTicketClaims.from_row(row)
        if claims.audience != normalized_audience:
            await self._record_event_safe(
                event_type="reject",
                code="audience_mismatch",
                claims=claims,
                client_ip=consume_ip,
                user_agent=consume_user_agent,
            )
            raise WsTicketError("audience_mismatch", "websocket ticket audience mismatch")
        await self._record_event_safe(
            event_type="consume",
            code="ok",
            claims=claims,
            client_ip=consume_ip,
            user_agent=consume_user_agent,
        )
        return claims

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
        consume_ip: str = "",
        user_agent: str = "",
    ) -> None:
        claims = WsTicketClaims(
            audience=str(audience or "").strip().lower(),
            subject=str(subject or "").strip().lower(),
            role=str(role or "").strip().lower(),
            resource_type=str(resource_type or "").strip(),
            resource_id=str(resource_id or "").strip(),
            site=str(site or "").strip(),
        )
        await self._record_event_safe(
            event_type=event_type,
            code=code,
            claims=claims,
            client_ip=consume_ip,
            user_agent=user_agent,
        )

    async def _record_event_safe(
        self,
        *,
        event_type: str,
        code: str,
        claims: WsTicketClaims,
        client_ip: str = "",
        user_agent: str = "",
    ) -> None:
        if not self.repository or not hasattr(self.repository, "record_event"):
            return
        if not await self._diagnostics_enabled():
            return
        try:
            await self.repository.record_event(
                event_type=event_type,
                code=code,
                audience=claims.audience,
                subject=claims.subject,
                role=claims.role,
                resource_type=claims.resource_type,
                resource_id=claims.resource_id,
                site=claims.site,
                client_ip=client_ip,
                user_agent=user_agent,
            )
        except Exception as exc:
            if self.logger is not None:
                try:
                    self.logger.debug("[WsTicket] event_record_failed type=%s code=%s err=%s", event_type, code, exc)
                except Exception:
                    pass

    async def _diagnostics_enabled(self) -> bool:
        if self.diagnostics_policy is None:
            return False
        try:
            if hasattr(self.diagnostics_policy, "is_enabled"):
                return bool(await self.diagnostics_policy.is_enabled())
            if callable(self.diagnostics_policy):
                result = self.diagnostics_policy()
                if hasattr(result, "__await__"):
                    result = await result
                return bool(result)
        except Exception as exc:
            if self.logger is not None:
                try:
                    self.logger.debug("[WsTicket] diagnostics_policy_check_failed err=%s", exc)
                except Exception:
                    pass
        return False

    @staticmethod
    def hash_token(token: str) -> str:
        return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()

    @staticmethod
    def _normalize_required(value: str, field: str) -> str:
        normalized = str(value or "").strip()
        if not normalized:
            raise WsTicketError(f"missing_{field}", f"missing {field}")
        return normalized
