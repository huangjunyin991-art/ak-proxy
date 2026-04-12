from __future__ import annotations

import secrets
import time
from typing import Any, Optional

from .settings_store import DEFAULT_MAX_ACTIVE_SESSIONS, RemoteVoiceSettingsStore
from .types import COUNTED_VOICE_SESSION_STATUSES, VoiceSession, VoiceSessionStatus


class RemoteVoiceFacade:
    INVITE_TIMEOUT_SECONDS = 30
    CONNECTING_TIMEOUT_SECONDS = 45

    def __init__(self, settings_store: Optional[RemoteVoiceSettingsStore] = None):
        self.settings_store = settings_store or RemoteVoiceSettingsStore()
        self.config = self.settings_store.load()
        self.sessions: dict[str, VoiceSession] = {}
        self.assist_to_voice: dict[str, str] = {}

    def _next_session_id(self) -> str:
        return f"voice_{secrets.token_hex(8)}"

    def _get_limit(self) -> int:
        value = int((self.config or {}).get('max_active_sessions') or DEFAULT_MAX_ACTIVE_SESSIONS)
        return max(1, value)

    def prune(self) -> None:
        now = time.time()
        expired_assist_ids: list[str] = []
        for assist_session_id, voice_session_id in list(self.assist_to_voice.items()):
            session = self.sessions.get(voice_session_id)
            if not session:
                expired_assist_ids.append(assist_session_id)
                continue
            if session.status in {VoiceSessionStatus.CLOSED, VoiceSessionStatus.REJECTED, VoiceSessionStatus.TIMEOUT, VoiceSessionStatus.FAILED}:
                expired_assist_ids.append(assist_session_id)
                continue
            if session.status in {VoiceSessionStatus.RESERVED, VoiceSessionStatus.RINGING}:
                if now - (session.ringing_at or session.created_at) >= self.INVITE_TIMEOUT_SECONDS:
                    session.status = VoiceSessionStatus.TIMEOUT
                    session.ended_at = now
                    session.touch()
                    expired_assist_ids.append(assist_session_id)
                continue
            if session.status == VoiceSessionStatus.CONNECTING:
                if now - (session.accepted_at or session.updated_at or session.created_at) >= self.CONNECTING_TIMEOUT_SECONDS:
                    session.status = VoiceSessionStatus.TIMEOUT
                    session.ended_at = now
                    session.touch()
                    expired_assist_ids.append(assist_session_id)
        for assist_session_id in expired_assist_ids:
            self.assist_to_voice.pop(assist_session_id, None)

    def get_session(self, voice_session_id: str) -> Optional[VoiceSession]:
        self.prune()
        return self.sessions.get(str(voice_session_id or '').strip())

    def get_session_by_assist(self, assist_session_id: str) -> Optional[VoiceSession]:
        self.prune()
        voice_session_id = self.assist_to_voice.get(str(assist_session_id or '').strip())
        if not voice_session_id:
            return None
        return self.sessions.get(voice_session_id)

    def start_session(
        self,
        assist_session_id: str,
        site_type: str,
        admin_username: str,
        target_username: str,
        admin_role: str = '',
        request_chat_ws_id: str = '',
        request_chat_page_id: str = '',
        metadata: Optional[dict[str, Any]] = None,
    ) -> tuple[Optional[VoiceSession], bool, str]:
        self.prune()
        normalized_assist_id = str(assist_session_id or '').strip()
        if not normalized_assist_id:
            return None, False, 'invalid_assist_session'
        existing = self.get_session_by_assist(normalized_assist_id)
        if existing and existing.status in COUNTED_VOICE_SESSION_STATUSES:
            if request_chat_ws_id:
                existing.request_chat_ws_id = str(request_chat_ws_id)
            if request_chat_page_id:
                existing.request_chat_page_id = str(request_chat_page_id)
            existing.touch()
            return existing, False, ''
        current_sessions = self.current_count()
        limit = self._get_limit()
        if current_sessions >= limit:
            return None, False, 'voice_limit_reached'
        session = VoiceSession(
            voice_session_id=self._next_session_id(),
            assist_session_id=normalized_assist_id,
            site_type=str(site_type or '').strip() or 'ak_web',
            admin_username=str(admin_username or '').strip(),
            target_username=str(target_username or '').strip(),
            admin_role=str(admin_role or '').strip(),
            status=VoiceSessionStatus.RINGING,
            request_chat_ws_id=str(request_chat_ws_id or '').strip(),
            request_chat_page_id=str(request_chat_page_id or '').strip(),
            metadata=dict(metadata or {}),
        )
        session.ringing_at = session.created_at
        self.sessions[session.voice_session_id] = session
        self.assist_to_voice[normalized_assist_id] = session.voice_session_id
        return session, True, ''

    def accept_session(
        self,
        voice_session_id: str,
        bound_chat_ws_id: str = '',
        bound_chat_page_id: str = '',
    ) -> Optional[VoiceSession]:
        self.prune()
        session = self.sessions.get(str(voice_session_id or '').strip())
        if not session or session.status not in COUNTED_VOICE_SESSION_STATUSES:
            return None
        now = time.time()
        session.status = VoiceSessionStatus.CONNECTING
        session.accepted_at = session.accepted_at or now
        session.bound_chat_ws_id = str(bound_chat_ws_id or '').strip()
        session.bound_chat_page_id = str(bound_chat_page_id or '').strip()
        session.last_user_heartbeat = now
        session.touch()
        return session

    def reject_session(self, voice_session_id: str) -> Optional[VoiceSession]:
        return self.close_session(voice_session_id, status=VoiceSessionStatus.REJECTED)

    def mark_failed(self, voice_session_id: str) -> Optional[VoiceSession]:
        return self.close_session(voice_session_id, status=VoiceSessionStatus.FAILED)

    def mark_active(self, voice_session_id: str) -> Optional[VoiceSession]:
        self.prune()
        session = self.sessions.get(str(voice_session_id or '').strip())
        if not session or session.status not in COUNTED_VOICE_SESSION_STATUSES:
            return None
        now = time.time()
        session.status = VoiceSessionStatus.ACTIVE
        session.connected_at = session.connected_at or now
        session.last_admin_heartbeat = session.last_admin_heartbeat or now
        session.last_user_heartbeat = session.last_user_heartbeat or now
        session.touch()
        return session

    def close_session(self, voice_session_id: str, status: VoiceSessionStatus = VoiceSessionStatus.CLOSED) -> Optional[VoiceSession]:
        self.prune()
        session = self.sessions.get(str(voice_session_id or '').strip())
        if not session:
            return None
        session.status = status
        session.ended_at = session.ended_at or time.time()
        session.touch()
        self.assist_to_voice.pop(session.assist_session_id, None)
        return session

    def close_by_assist_session(self, assist_session_id: str, status: VoiceSessionStatus = VoiceSessionStatus.CLOSED) -> Optional[VoiceSession]:
        session = self.get_session_by_assist(assist_session_id)
        if not session:
            return None
        return self.close_session(session.voice_session_id, status=status)

    def set_mute_state(self, voice_session_id: str, role: str, muted: bool) -> Optional[VoiceSession]:
        self.prune()
        session = self.sessions.get(str(voice_session_id or '').strip())
        if not session or session.status not in COUNTED_VOICE_SESSION_STATUSES:
            return None
        role_name = str(role or '').strip().lower()
        if role_name == 'admin':
            session.admin_muted = bool(muted)
        elif role_name == 'user':
            session.user_muted = bool(muted)
        session.touch()
        return session

    def heartbeat(self, voice_session_id: str, role: str) -> Optional[VoiceSession]:
        self.prune()
        session = self.sessions.get(str(voice_session_id or '').strip())
        if not session or session.status not in COUNTED_VOICE_SESSION_STATUSES:
            return None
        now = time.time()
        role_name = str(role or '').strip().lower()
        if role_name == 'admin':
            session.last_admin_heartbeat = now
        elif role_name == 'user':
            session.last_user_heartbeat = now
        session.touch()
        return session

    def current_count(self) -> int:
        self.prune()
        return sum(1 for session in self.sessions.values() if session.status in COUNTED_VOICE_SESSION_STATUSES)

    def get_usage_snapshot(self, include_sessions: bool = True) -> dict[str, Any]:
        self.prune()
        now = time.time()
        counted_sessions = [session for session in self.sessions.values() if session.status in COUNTED_VOICE_SESSION_STATUSES]
        ringing_sessions = [session for session in counted_sessions if session.status in {VoiceSessionStatus.RESERVED, VoiceSessionStatus.RINGING}]
        active_sessions = [session for session in counted_sessions if session.status in {VoiceSessionStatus.CONNECTING, VoiceSessionStatus.ACTIVE}]
        snapshot: dict[str, Any] = {
            'success': True,
            'max_active_sessions': self._get_limit(),
            'current_sessions': len(counted_sessions),
            'current_participants': len(counted_sessions) * 2,
            'ringing_sessions': len(ringing_sessions),
            'active_sessions': len(active_sessions),
            'available_slots': max(0, self._get_limit() - len(counted_sessions)),
            'updated_at': float((self.config or {}).get('updated_at') or 0),
            'updated_by': str((self.config or {}).get('updated_by') or ''),
        }
        if include_sessions:
            ordered_sessions = sorted(
                counted_sessions,
                key=lambda item: (0 if item.status in COUNTED_VOICE_SESSION_STATUSES else 1, -float(item.created_at or 0)),
            )
            snapshot['sessions'] = [session.to_usage_dict(now) for session in ordered_sessions]
        return snapshot

    def get_config_snapshot(self) -> dict[str, Any]:
        return self.get_usage_snapshot(include_sessions=False)

    def update_limit(self, max_active_sessions: int, updated_by: str = '') -> dict[str, Any]:
        value = max(1, int(max_active_sessions))
        self.config = self.settings_store.save(value, updated_by=updated_by)
        return self.get_usage_snapshot(include_sessions=False)


remote_voice = RemoteVoiceFacade()
