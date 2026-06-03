from __future__ import annotations

import secrets
import time
from typing import Any, Optional

from .types import IMCallSession, IMCallStatus


class IMCallFacade:
    CALL_TIMEOUT_SECONDS = 30
    ACTIVE_TIMEOUT_SECONDS = 45

    def __init__(self):
        self.sessions: dict[str, IMCallSession] = {}
        self.conversation_to_call: dict[int, str] = {}

    def _next_call_id(self) -> str:
        return f'imcall_{secrets.token_hex(8)}'

    def prune(self) -> None:
        now = time.time()
        for call_id, session in list(self.sessions.items()):
            if session.status in {IMCallStatus.ENDED, IMCallStatus.FAILED, IMCallStatus.BUSY, IMCallStatus.TIMEOUT}:
                if now - session.updated_at > 3600:
                    self.sessions.pop(call_id, None)
                continue
            if session.status in {IMCallStatus.DIALING, IMCallStatus.RINGING} and now - session.created_at >= self.CALL_TIMEOUT_SECONDS:
                session.status = IMCallStatus.TIMEOUT
                session.ended_at = now
                session.touch()
            if session.status == IMCallStatus.ACTIVE and now - (session.connected_at or session.accepted_at or session.created_at) >= self.ACTIVE_TIMEOUT_SECONDS:
                session.status = IMCallStatus.TIMEOUT
                session.ended_at = now
                session.touch()

    def get_session(self, call_id: str) -> Optional[IMCallSession]:
        self.prune()
        return self.sessions.get(str(call_id or '').strip())

    def get_by_conversation(self, conversation_id: int) -> Optional[IMCallSession]:
        self.prune()
        call_id = self.conversation_to_call.get(int(conversation_id or 0))
        return self.sessions.get(call_id) if call_id else None

    def start_call(self, *, conversation_id: int, caller_username: str, callee_username: str, call_kind: str = 'audio', metadata: Optional[dict[str, Any]] = None) -> IMCallSession:
        self.prune()
        session = IMCallSession(
            call_id=self._next_call_id(),
            conversation_id=int(conversation_id or 0),
            caller_username=str(caller_username or '').strip(),
            callee_username=str(callee_username or '').strip(),
            call_kind='video' if str(call_kind or '').strip().lower() == 'video' else 'audio',
            status=IMCallStatus.RINGING,
            ringing_at=time.time(),
            metadata=dict(metadata or {}),
        )
        self.sessions[session.call_id] = session
        self.conversation_to_call[session.conversation_id] = session.call_id
        return session

    def accept_call(self, call_id: str) -> Optional[IMCallSession]:
        self.prune()
        session = self.sessions.get(str(call_id or '').strip())
        if not session:
            return None
        session.status = IMCallStatus.ACTIVE
        now = time.time()
        session.accepted_at = session.accepted_at or now
        session.connected_at = session.connected_at or now
        session.touch()
        return session

    def reject_call(self, call_id: str) -> Optional[IMCallSession]:
        return self.close_call(call_id, IMCallStatus.FAILED)

    def hangup_call(self, call_id: str) -> Optional[IMCallSession]:
        return self.close_call(call_id, IMCallStatus.ENDED)

    def close_call(self, call_id: str, status: IMCallStatus) -> Optional[IMCallSession]:
        self.prune()
        session = self.sessions.get(str(call_id or '').strip())
        if not session:
            return None
        session.status = status
        session.ended_at = session.ended_at or time.time()
        session.touch()
        self.conversation_to_call.pop(session.conversation_id, None)
        return session

    def set_mute(self, call_id: str, role: str, muted: bool) -> Optional[IMCallSession]:
        self.prune()
        session = self.sessions.get(str(call_id or '').strip())
        if not session:
            return None
        role_name = str(role or '').strip().lower()
        if role_name == 'caller':
            session.caller_muted = bool(muted)
        elif role_name == 'callee':
            session.callee_muted = bool(muted)
        session.touch()
        return session


im_call = IMCallFacade()
