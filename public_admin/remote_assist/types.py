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
class AssistSession:
    session_id: str
    site_type: str
    target_username: str
    admin_username: str
    browse_session_id: str = ""
    status: AssistStatus = AssistStatus.PENDING
    readonly: bool = True
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    last_route: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    participants: dict[str, AssistParticipant] = field(default_factory=dict)

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
            "readonly": self.readonly,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "last_route": self.last_route,
            "metadata": dict(self.metadata or {}),
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
