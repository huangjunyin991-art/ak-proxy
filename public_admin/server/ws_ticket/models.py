from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class WsTicketClaims:
    audience: str
    subject: str
    role: str = ""
    resource_type: str = ""
    resource_id: str = ""
    site: str = ""
    readonly: bool = False
    claims: dict[str, Any] = field(default_factory=dict)
    issued_at: datetime | None = None
    expires_at: datetime | None = None

    @classmethod
    def from_row(cls, row: Any) -> "WsTicketClaims":
        claims = _row_get(row, "claims", {})
        if isinstance(claims, str):
            try:
                claims = json.loads(claims)
            except Exception:
                claims = {}
        if not isinstance(claims, dict):
            claims = {}
        return cls(
            audience=str(_row_get(row, "audience", "") or "").strip(),
            subject=str(_row_get(row, "subject", "") or "").strip().lower(),
            role=str(_row_get(row, "role", "") or "").strip().lower(),
            resource_type=str(_row_get(row, "resource_type", "") or "").strip(),
            resource_id=str(_row_get(row, "resource_id", "") or "").strip(),
            site=str(_row_get(row, "site", "") or "").strip(),
            readonly=bool(_row_get(row, "readonly", False)),
            claims=dict(claims),
            issued_at=_row_get(row, "issued_at", None),
            expires_at=_row_get(row, "expires_at", None),
        )

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "audience": self.audience,
            "subject": self.subject,
            "role": self.role,
            "resource_type": self.resource_type,
            "resource_id": self.resource_id,
            "site": self.site,
            "readonly": self.readonly,
            "expires_at": self.expires_at.isoformat() if self.expires_at else "",
        }


def _row_get(row: Any, key: str, default: Any = None) -> Any:
    if row is None:
        return default
    try:
        return row[key]
    except Exception:
        return default


@dataclass(frozen=True)
class WsTicketIssue:
    ticket: str
    token_hash: str
    claims: WsTicketClaims
    expires_in: int

    def to_response(self) -> dict[str, Any]:
        payload = self.claims.to_public_dict()
        payload.update({
            "success": True,
            "ticket": self.ticket,
            "expires_in": self.expires_in,
        })
        return payload
