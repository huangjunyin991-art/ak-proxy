from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class AssistRole(str, Enum):
    ADMIN = "admin"
    USER = "user"
    SYSTEM = "system"


class AssistStatus(str, Enum):
    PENDING = "pending"
    ACTIVE = "active"
    CLOSING = "closing"
    CLOSED = "closed"


class AssistConsentStatus(str, Enum):
    WAITING = "waiting"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


@dataclass
class AssistParticipant:
    participant_id: str
    role: AssistRole
    readonly: bool = True
    connected: bool = False
    websocket_id: str = ""
    capabilities: list[str] = field(default_factory=list)
    client_meta: dict[str, Any] = field(default_factory=dict)
    last_heartbeat: float = field(default_factory=time.time)


@dataclass
class AssistEvent:
    type: str
    session_id: str
    site: str
    source: str
    payload: dict[str, Any] = field(default_factory=dict)
    v: int = 1
    ts: int = field(default_factory=lambda: int(time.time() * 1000))

    def to_dict(self) -> dict[str, Any]:
        return {
            "v": self.v,
            "type": self.type,
            "session_id": self.session_id,
            "site": self.site,
            "source": self.source,
            "ts": self.ts,
            "payload": dict(self.payload or {}),
        }


@dataclass
class AssistSnapshot:
    route: str = ""
    title: str = ""
    html: str = ""
    viewport: dict[str, Any] = field(default_factory=dict)
    scroll: dict[str, Any] = field(default_factory=dict)
    node_count: int = 0
    truncated: bool = False
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "route": self.route,
            "title": self.title,
            "html": self.html,
            "viewport": dict(self.viewport or {}),
            "scroll": dict(self.scroll or {}),
            "node_count": self.node_count,
            "truncated": self.truncated,
            "created_at": self.created_at,
        }


@dataclass
class AssistSession:
    session_id: str
    site_type: str
    target_username: str
    admin_username: str
    browse_session_id: str = ""
    status: AssistStatus = AssistStatus.PENDING
    consent_status: AssistConsentStatus = AssistConsentStatus.ACCEPTED
    readonly: bool = True
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    last_route: str = ""
    request_chat_ws_id: str = ""
    bound_chat_ws_id: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    participants: dict[str, AssistParticipant] = field(default_factory=dict)
    latest_snapshot: AssistSnapshot = field(default_factory=AssistSnapshot)

    def touch(self) -> None:
        self.updated_at = time.time()

    def to_dict(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "site_type": self.site_type,
            "target_username": self.target_username,
            "admin_username": self.admin_username,
            "browse_session_id": self.browse_session_id,
            "status": self.status.value,
            "consent_status": self.consent_status.value,
            "readonly": self.readonly,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "last_route": self.last_route,
            "request_chat_ws_id": self.request_chat_ws_id,
            "bound_chat_ws_id": self.bound_chat_ws_id,
            "metadata": dict(self.metadata or {}),
            "latest_snapshot": self.latest_snapshot.to_dict() if self.latest_snapshot else {},
            "participants": {
                key: {
                    "participant_id": item.participant_id,
                    "role": item.role.value,
                    "readonly": item.readonly,
                    "connected": item.connected,
                    "websocket_id": item.websocket_id,
                    "capabilities": list(item.capabilities or []),
                    "client_meta": dict(item.client_meta or {}),
                    "last_heartbeat": item.last_heartbeat,
                }
                for key, item in self.participants.items()
            },
        }
