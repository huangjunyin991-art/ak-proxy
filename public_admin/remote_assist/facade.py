from __future__ import annotations

from typing import Any, Optional, Tuple

from .adapters import AkWebAdapter
from .event_bus import RemoteAssistEventBus
from .flags import load_flags
from .session_manager import RemoteAssistSessionManager
from .types import AssistConsentStatus, AssistEvent, AssistRole, AssistSession


class RemoteAssistFacade:
    def __init__(self):
        self.flags = load_flags()
        self.sessions = RemoteAssistSessionManager(self.flags)
        self.event_bus = RemoteAssistEventBus()
        self.adapters = {"ak_web": AkWebAdapter()}

    def reload_flags(self) -> None:
        self.flags = load_flags()
        self.sessions.reload_flags(self.flags)

    def is_enabled(self) -> bool:
        return bool(self.flags.enabled)

    def supports_site(self, site_type: str) -> bool:
        if not self.is_enabled():
            return False
        if site_type == "ak_web":
            return bool(self.flags.enable_ak_web)
        return False

    def get_adapter(self, site_type: str):
        return self.adapters.get((site_type or "").strip())

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
        if not self.supports_site(site_type):
            return None
        return self.sessions.create_session(
            site_type=site_type,
            target_username=target_username,
            admin_username=admin_username,
            browse_session_id=browse_session_id,
            readonly=readonly,
            consent_status=consent_status,
            metadata=metadata,
        )

    def get_session(self, session_id: str) -> Optional[AssistSession]:
        return self.sessions.get_session(session_id)

    def find_session_by_target_username(self, username: str) -> Optional[AssistSession]:
        return self.sessions.find_by_target_username(username)

    def close_session(self, session_id: str) -> Optional[AssistSession]:
        return self.sessions.close_session(session_id)

    def update_consent_status(self, session_id: str, consent_status: AssistConsentStatus) -> Optional[AssistSession]:
        return self.sessions.update_consent_status(session_id, consent_status)

    def attach_browse_session(self, session_id: str, browse_session_id: str) -> Optional[AssistSession]:
        return self.sessions.attach_browse_session(session_id, browse_session_id)

    def update_route(self, session_id: str, route: str) -> Optional[AssistSession]:
        return self.sessions.update_route(session_id, route)

    def update_snapshot(self, session_id: str, snapshot_payload: Optional[dict[str, Any]] = None) -> Optional[AssistSession]:
        return self.sessions.update_snapshot(session_id, dict(snapshot_payload or {}))

    def build_bridge_script(
        self,
        site_type: str,
        session_id: str,
        ws_endpoint: str,
        role: str,
        readonly: bool = True,
        extra: Optional[dict[str, Any]] = None,
    ) -> str:
        session = self.get_session(session_id)
        adapter = self.get_adapter(site_type)
        if not session or not adapter:
            return ""
        return adapter.build_bridge_script(
            session=session,
            ws_endpoint=ws_endpoint,
            role=role,
            readonly=readonly,
            extra=extra,
        )

    def build_event(
        self,
        event_type: str,
        session_id: str,
        site_type: str,
        source: str,
        payload: Optional[dict[str, Any]] = None,
    ) -> AssistEvent:
        event = AssistEvent(
            type=event_type,
            session_id=(session_id or "").strip(),
            site=(site_type or "").strip(),
            source=(source or "").strip(),
            payload=dict(payload or {}),
        )
        self.sessions.append_event(event)
        if event.type == "route_changed":
            route = str(event.payload.get("route") or "").strip()
            if route:
                self.sessions.update_route(event.session_id, route)
        elif event.type == "snapshot_replace":
            self.sessions.update_snapshot(event.session_id, event.payload)
        return event

    async def publish_event(
        self,
        event_type: str,
        session_id: str,
        site_type: str,
        source: str,
        payload: Optional[dict[str, Any]] = None,
        include_roles: Optional[set[str]] = None,
        exclude_connection_id: str = "",
    ) -> AssistEvent:
        event = self.build_event(event_type, session_id, site_type, source, payload)
        await self.event_bus.publish(event, include_roles=include_roles, exclude_connection_id=exclude_connection_id)
        return event

    async def connect_websocket(
        self,
        session_id: str,
        role: AssistRole,
        websocket,
        participant_id: str,
        readonly: bool = True,
        capabilities: Optional[list[str]] = None,
        client_meta: Optional[dict[str, Any]] = None,
    ) -> Tuple[Optional[AssistSession], str]:
        session = self.sessions.ensure_active(session_id, role=role)
        if not session:
            return None, ""
        connection_id = await self.event_bus.connect(session_id, role.value, websocket)
        self.sessions.bind_participant(
            session_id=session_id,
            participant_id=participant_id,
            role=role,
            websocket_id=connection_id,
            readonly=readonly,
            capabilities=capabilities,
            client_meta=client_meta,
        )
        return session, connection_id

    async def disconnect_websocket(self, session_id: str, participant_id: str, connection_id: str) -> None:
        self.sessions.unbind_participant(session_id, participant_id)
        await self.event_bus.disconnect(session_id, connection_id)

    def heartbeat(self, session_id: str, participant_id: str) -> Optional[AssistSession]:
        return self.sessions.heartbeat(session_id, participant_id)


remote_assist = RemoteAssistFacade()
