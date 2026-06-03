from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class IMCallStatus(str, Enum):
    IDLE = 'idle'
    DIALING = 'dialing'
    RINGING = 'ringing'
    ACTIVE = 'active'
    ENDED = 'ended'
    FAILED = 'failed'
    BUSY = 'busy'
    TIMEOUT = 'timeout'


@dataclass
class IMCallSession:
    call_id: str
    conversation_id: int
    caller_username: str
    callee_username: str
    call_kind: str = 'audio'
    status: IMCallStatus = IMCallStatus.DIALING
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    ringing_at: float = 0.0
    accepted_at: float = 0.0
    connected_at: float = 0.0
    ended_at: float = 0.0
    caller_ws_id: str = ''
    callee_ws_id: str = ''
    caller_page_id: str = ''
    callee_page_id: str = ''
    caller_muted: bool = False
    callee_muted: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def touch(self) -> None:
        self.updated_at = time.time()

    def to_dict(self) -> dict[str, Any]:
        return {
            'call_id': self.call_id,
            'conversation_id': self.conversation_id,
            'caller_username': self.caller_username,
            'callee_username': self.callee_username,
            'call_kind': self.call_kind,
            'status': self.status.value,
            'created_at': self.created_at,
            'updated_at': self.updated_at,
            'ringing_at': self.ringing_at or None,
            'accepted_at': self.accepted_at or None,
            'connected_at': self.connected_at or None,
            'ended_at': self.ended_at or None,
            'caller_muted': self.caller_muted,
            'callee_muted': self.callee_muted,
            'metadata': dict(self.metadata or {}),
        }
