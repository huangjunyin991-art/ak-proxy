from __future__ import annotations

import asyncio
import secrets
from collections import defaultdict
from typing import Optional

from fastapi import WebSocket

from .types import AssistEvent


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
        for connection_id, (role, websocket) in bucket.items():
            if exclude_connection_id and connection_id == exclude_connection_id:
                continue
            if include_roles and role not in include_roles:
                continue
            try:
                await websocket.send_json(payload)
            except Exception:
                dead.append(connection_id)
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
