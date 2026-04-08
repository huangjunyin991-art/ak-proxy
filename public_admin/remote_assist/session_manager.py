from __future__ import annotations

import secrets
import time
from collections import deque
from typing import Any, Optional

from .flags import RemoteAssistFlags
from .types import AssistConsentStatus, AssistEvent, AssistParticipant, AssistRole, AssistSession, AssistSnapshot, AssistStatus


class RemoteAssistSessionManager:
    def __init__(self, flags: RemoteAssistFlags):
        self.flags = flags
        self.sessions: dict[str, AssistSession] = {}
        self.event_history: dict[str, deque[dict[str, Any]]] = {}

    def reload_flags(self, flags: RemoteAssistFlags) -> None:
        self.flags = flags

    def _next_session_id(self) -> str:
        return f"as_{secrets.token_urlsafe(9)}"

    def prune(self) -> None:
        now = time.time()
        expired = []
        for session_id, session in self.sessions.items():
            if session.status == AssistStatus.CLOSED:
                expired.append(session_id)
                continue
            if now - session.updated_at > self.flags.session_ttl_seconds:
                expired.append(session_id)
        for session_id in expired:
            self.sessions.pop(session_id, None)
            self.event_history.pop(session_id, None)

    def list_sessions(self) -> list[AssistSession]:
        self.prune()
        return sorted(self.sessions.values(), key=lambda item: item.updated_at, reverse=True)

    def get_session(self, session_id: str) -> Optional[AssistSession]:
        self.prune()
        session = self.sessions.get((session_id or "").strip())
        if session and session.status == AssistStatus.CLOSED:
            return None
        return session

    def create_session(
        self,
        site_type: str,
        target_username: str,
        admin_username: str,
        browse_session_id: str = "",
        readonly: bool = True,
        consent_status: AssistConsentStatus = AssistConsentStatus.ACCEPTED,
        metadata: Optional[dict[str, Any]] = None,
    ) -> Optional[AssistSession]:
        self.prune()
        if len(self.sessions) >= self.flags.max_sessions:
            return None
        session = AssistSession(
            session_id=self._next_session_id(),
            site_type=(site_type or "").strip(),
            target_username=(target_username or "").strip(),
            admin_username=(admin_username or "").strip(),
            browse_session_id=(browse_session_id or "").strip(),
            consent_status=consent_status,
            readonly=readonly,
            metadata=dict(metadata or {}),
        )
        self.sessions[session.session_id] = session
        self.event_history[session.session_id] = deque(maxlen=self.flags.max_events_per_session)
        return session

    def close_session(self, session_id: str) -> Optional[AssistSession]:
        session = self.get_session(session_id)
        if not session:
            return None
        session.status = AssistStatus.CLOSED
        session.touch()
        return session

    def ensure_active(self, session_id: str, role: Optional[AssistRole] = None) -> Optional[AssistSession]:
        session = self.get_session(session_id)
        if not session:
            return None
        if session.consent_status == AssistConsentStatus.REJECTED:
            return None
        if role == AssistRole.USER and session.consent_status != AssistConsentStatus.ACCEPTED:
            return None
        if role == AssistRole.ADMIN and session.status == AssistStatus.PENDING and session.consent_status != AssistConsentStatus.ACCEPTED:
            session.touch()
            return session
        if session.status in {AssistStatus.PENDING, AssistStatus.ACTIVE}:
            session.status = AssistStatus.ACTIVE
            session.touch()
        return session

    def bind_participant(
        self,
        session_id: str,
        participant_id: str,
        role: AssistRole,
        websocket_id: str = "",
        readonly: bool = True,
        capabilities: Optional[list[str]] = None,
        client_meta: Optional[dict[str, Any]] = None,
    ) -> Optional[AssistParticipant]:
        session = self.ensure_active(session_id, role=role)
        if not session:
            return None
        participant = AssistParticipant(
            participant_id=(participant_id or "").strip(),
            role=role,
            readonly=readonly,
            connected=True,
            websocket_id=(websocket_id or "").strip(),
            capabilities=list(capabilities or []),
            client_meta=dict(client_meta or {}),
        )
        session.participants[participant.participant_id] = participant
        session.touch()
        return participant

    def unbind_participant(self, session_id: str, participant_id: str) -> Optional[AssistSession]:
        session = self.get_session(session_id)
        if not session:
            return None
        participant = session.participants.get((participant_id or "").strip())
        if participant:
            participant.connected = False
            participant.websocket_id = ""
            participant.last_heartbeat = time.time()
        session.touch()
        return session

    def update_consent_status(self, session_id: str, consent_status: AssistConsentStatus) -> Optional[AssistSession]:
        session = self.get_session(session_id)
        if not session:
            return None
        session.consent_status = consent_status
        if consent_status == AssistConsentStatus.ACCEPTED and session.status == AssistStatus.PENDING:
            session.status = AssistStatus.ACTIVE
        session.touch()
        return session

    def set_request_chat_ws(
        self,
        session_id: str,
        websocket_id: str,
        page_client_id: Optional[str] = None,
    ) -> Optional[AssistSession]:
        session = self.get_session(session_id)
        if not session:
            return None
        session.request_chat_ws_id = (websocket_id or "").strip()
        if page_client_id is not None:
            session.request_chat_page_id = (page_client_id or "").strip()
        session.touch()
        return session

    def set_bound_chat_ws(
        self,
        session_id: str,
        websocket_id: str,
        page_client_id: Optional[str] = None,
    ) -> Optional[AssistSession]:
        session = self.get_session(session_id)
        if not session:
            return None
        ws_id = (websocket_id or "").strip()
        page_id = (page_client_id or "").strip() if page_client_id is not None else None
        session.bound_chat_ws_id = ws_id
        if page_id is not None:
            session.bound_chat_page_id = page_id
        if ws_id and not session.request_chat_ws_id:
            session.request_chat_ws_id = ws_id
        if page_id and not session.request_chat_page_id:
            session.request_chat_page_id = page_id
        session.touch()
        return session

    def clear_chat_ws_locks(
        self,
        session_id: str,
        websocket_id: str = "",
        clear_request: bool = True,
        clear_bound: bool = True,
        clear_request_page: bool = True,
        clear_bound_page: bool = True,
    ) -> Optional[AssistSession]:
        session = self.get_session(session_id)
        if not session:
            return None
        ws_id = (websocket_id or "").strip()
        if clear_request and (not ws_id or session.request_chat_ws_id == ws_id):
            session.request_chat_ws_id = ""
            if clear_request_page:
                session.request_chat_page_id = ""
        if clear_bound and (not ws_id or session.bound_chat_ws_id == ws_id):
            session.bound_chat_ws_id = ""
            if clear_bound_page:
                session.bound_chat_page_id = ""
        session.touch()
        return session

    def heartbeat(self, session_id: str, participant_id: str) -> Optional[AssistSession]:
        session = self.get_session(session_id)
        if not session:
            return None
        participant = session.participants.get((participant_id or "").strip())
        if participant:
            participant.last_heartbeat = time.time()
            participant.connected = True
        session.touch()
        return session

    def update_route(self, session_id: str, route: str) -> Optional[AssistSession]:
        session = self.get_session(session_id)
        if not session:
            return None
        session.last_route = (route or "").strip()
        session.touch()
        return session

    def update_snapshot(self, session_id: str, snapshot_payload: dict[str, Any]) -> Optional[AssistSession]:
        session = self.get_session(session_id)
        if not session:
            return None
        payload = dict(snapshot_payload or {})
        route = str(payload.get("route") or session.last_route or "").strip()
        session.latest_snapshot = AssistSnapshot(
            route=route,
            title=str(payload.get("title") or "").strip(),
            html=str(payload.get("html") or ""),
            viewport=dict(payload.get("viewport") or {}),
            scroll=dict(payload.get("scroll") or {}),
            node_count=int(payload.get("node_count") or 0),
            truncated=bool(payload.get("truncated", False)),
        )
        if route:
            session.last_route = route
        session.touch()
        return session

    def attach_browse_session(self, session_id: str, browse_session_id: str) -> Optional[AssistSession]:
        session = self.get_session(session_id)
        if not session:
            return None
        session.browse_session_id = (browse_session_id or "").strip()
        session.touch()
        return session

    def find_by_target_username(self, username: str) -> Optional[AssistSession]:
        wanted = (username or "").strip().lower()
        if not wanted:
            return None
        self.prune()
        for session in self.sessions.values():
            if session.status in {AssistStatus.PENDING, AssistStatus.ACTIVE} and session.target_username.lower() == wanted:
                return session
        return None

    def append_event(self, event: AssistEvent) -> None:
        queue = self.event_history.get(event.session_id)
        if queue is None:
            queue = deque(maxlen=self.flags.max_events_per_session)
            self.event_history[event.session_id] = queue
        queue.append(event.to_dict())
        session = self.sessions.get(event.session_id)
        if session:
            session.touch()

    def get_event_history(self, session_id: str) -> list[dict[str, Any]]:
        return list(self.event_history.get((session_id or "").strip(), []))
