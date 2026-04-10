from __future__ import annotations

import asyncio
import logging
import secrets
from collections import defaultdict
from typing import Optional

from fastapi import WebSocket

from .types import AssistEvent


logger = logging.getLogger("TransparentProxy")


def _should_log_scroll_publish(event: AssistEvent) -> bool:
    return str(getattr(event, "type", "") or "") == "scroll_changed"


def _summarize_publish_connection(connection_id: str, role: str) -> dict[str, str]:
    return {
        "connection_id": str(connection_id or ""),
        "role": str(role or ""),
    }


class RemoteAssistEventBus:
    def __init__(self):
        self._connections: dict[str, dict[str, tuple[str, WebSocket]]] = defaultdict(dict)
        self._lock = asyncio.Lock()

    async def connect(self, session_id: str, role: str, websocket: WebSocket) -> str:
        connection_id = f"aw_{secrets.token_urlsafe(8)}"
        await websocket.accept()
        async with self._lock:
            self._connections[(session_id or "").strip()][connection_id] = ((role or "").strip(), websocket)
        return connection_id

    async def disconnect(self, session_id: str, connection_id: str) -> None:
        async with self._lock:
            bucket = self._connections.get((session_id or "").strip())
            if not bucket:
                return
            bucket.pop((connection_id or "").strip(), None)
            if not bucket:
                self._connections.pop((session_id or "").strip(), None)

    async def publish(
        self,
        event: AssistEvent,
        include_roles: Optional[set[str]] = None,
        exclude_connection_id: str = "",
    ) -> None:
        dead: list[str] = []
        session_id = (event.session_id or "").strip()
        payload = event.to_dict()
        async with self._lock:
            bucket = dict(self._connections.get(session_id, {}))
        should_log_scroll_publish = _should_log_scroll_publish(event)
        skipped_excluded: list[dict[str, str]] = []
        skipped_role: list[dict[str, str]] = []
        delivered: list[dict[str, str]] = []
        failed: list[dict[str, str]] = []
        if should_log_scroll_publish:
            logger.warning(
                "[RemoteAssistBus] publish_start type=%s session=%s include_roles=%s exclude_connection_id=%s bucket=%s",
                str(event.type or ""),
                session_id or "-",
                sorted(include_roles) if include_roles else [],
                str(exclude_connection_id or ""),
                [_summarize_publish_connection(connection_id, role) for connection_id, (role, _websocket) in bucket.items()],
            )
        for connection_id, (role, websocket) in bucket.items():
            if exclude_connection_id and connection_id == exclude_connection_id:
                if should_log_scroll_publish:
                    skipped_excluded.append(_summarize_publish_connection(connection_id, role))
                continue
            if include_roles and role not in include_roles:
                if should_log_scroll_publish:
                    skipped_role.append(_summarize_publish_connection(connection_id, role))
                continue
            try:
                await websocket.send_json(payload)
                if should_log_scroll_publish:
                    delivered.append(_summarize_publish_connection(connection_id, role))
            except Exception:
                dead.append(connection_id)
                if should_log_scroll_publish:
                    failed.append(_summarize_publish_connection(connection_id, role))
        if should_log_scroll_publish:
            logger.warning(
                "[RemoteAssistBus] publish_result type=%s session=%s delivered=%s skipped_excluded=%s skipped_role=%s failed=%s dead=%s",
                str(event.type or ""),
                session_id or "-",
                delivered,
                skipped_excluded,
                skipped_role,
                failed,
                [str(connection_id or "") for connection_id in dead],
            )
        for connection_id in dead:
            await self.disconnect(session_id, connection_id)

    async def send(self, session_id: str, connection_id: str, payload: dict) -> bool:
        async with self._lock:
            bucket = self._connections.get((session_id or "").strip(), {})
            target = bucket.get((connection_id or "").strip())
        if not target:
            return False
        try:
            await target[1].send_json(payload)
            return True
        except Exception:
            await self.disconnect(session_id, connection_id)
            return False
