from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class VoiceSessionStatus(str, Enum):
    RESERVED = "reserved"
    RINGING = "ringing"
    CONNECTING = "connecting"
    ACTIVE = "active"
    REJECTED = "rejected"
    TIMEOUT = "timeout"
    CLOSED = "closed"
    FAILED = "failed"


COUNTED_VOICE_SESSION_STATUSES = {
    VoiceSessionStatus.RESERVED,
    VoiceSessionStatus.RINGING,
    VoiceSessionStatus.CONNECTING,
    VoiceSessionStatus.ACTIVE,
}


@dataclass
class VoiceSession:
    voice_session_id: str
    assist_session_id: str
    site_type: str
    admin_username: str
    target_username: str
    admin_role: str = ""
    status: VoiceSessionStatus = VoiceSessionStatus.RESERVED
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    ringing_at: float = 0.0
    accepted_at: float = 0.0
    connected_at: float = 0.0
    ended_at: float = 0.0
    request_chat_ws_id: str = ""
    bound_chat_ws_id: str = ""
    request_chat_page_id: str = ""
    bound_chat_page_id: str = ""
    admin_muted: bool = False
    user_muted: bool = False
    last_admin_heartbeat: float = 0.0
    last_user_heartbeat: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)

    def touch(self) -> None:
        self.updated_at = time.time()

    def is_counted(self) -> bool:
        return self.status in COUNTED_VOICE_SESSION_STATUSES

    def duration_seconds(self, now: float | None = None) -> int:
        current = now or time.time()
        start_at = self.connected_at or self.accepted_at or self.ringing_at or self.created_at
        end_at = self.ended_at or current
        return max(0, int(end_at - start_at))

    def to_usage_dict(self, now: float | None = None) -> dict[str, Any]:
        current = now or time.time()
        last_heartbeat = max(self.last_admin_heartbeat, self.last_user_heartbeat, 0.0)
        heartbeat_age = max(0, int(current - last_heartbeat)) if last_heartbeat else None
        return {
            "voice_session_id": self.voice_session_id,
            "assist_session_id": self.assist_session_id,
            "site_type": self.site_type,
            "admin_name": self.admin_username,
            "user_name": self.target_username,
            "admin_role": self.admin_role,
            "status": self.status.value,
            "started_at": self.created_at,
            "ringing_at": self.ringing_at or None,
            "accepted_at": self.accepted_at or None,
            "connected_at": self.connected_at or None,
            "duration_seconds": self.duration_seconds(current),
            "admin_muted": self.admin_muted,
            "user_muted": self.user_muted,
            "last_heartbeat_at": last_heartbeat or None,
            "last_heartbeat_age_seconds": heartbeat_age,
            "counted": self.is_counted(),
        }
