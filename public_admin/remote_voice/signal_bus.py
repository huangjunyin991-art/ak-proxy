from __future__ import annotations

import asyncio
import secrets
from collections import defaultdict
from typing import Optional

from fastapi import WebSocket


class RemoteVoiceSignalBus:
    def __init__(self):
        self._connections: dict[str, dict[str, tuple[str, WebSocket]]] = defaultdict(dict)
        self._lock = asyncio.Lock()

    async def connect(self, voice_session_id: str, role: str, websocket: WebSocket) -> str:
        connection_id = f"vw_{secrets.token_urlsafe(8)}"
        await websocket.accept()
        async with self._lock:
            self._connections[(voice_session_id or "").strip()][connection_id] = ((role or "").strip(), websocket)
        return connection_id

    async def disconnect(self, voice_session_id: str, connection_id: str) -> None:
        session_key = (voice_session_id or "").strip()
        async with self._lock:
            bucket = self._connections.get(session_key)
            if not bucket:
                return
            bucket.pop((connection_id or "").strip(), None)
            if not bucket:
                self._connections.pop(session_key, None)

    async def publish(
        self,
        voice_session_id: str,
        payload: dict,
        include_roles: Optional[set[str]] = None,
        exclude_connection_id: str = "",
    ) -> None:
        dead: list[str] = []
        session_key = (voice_session_id or "").strip()
        async with self._lock:
            bucket = dict(self._connections.get(session_key, {}))
        for connection_id, (role, websocket) in bucket.items():
            if exclude_connection_id and connection_id == exclude_connection_id:
                continue
            if include_roles and role not in include_roles:
                continue
            try:
                await websocket.send_json(dict(payload or {}))
            except Exception:
                dead.append(connection_id)
        for connection_id in dead:
            await self.disconnect(session_key, connection_id)

    async def send(self, voice_session_id: str, connection_id: str, payload: dict) -> bool:
        session_key = (voice_session_id or "").strip()
        async with self._lock:
            bucket = self._connections.get(session_key, {})
            target = bucket.get((connection_id or "").strip())
        if not target:
            return False
        try:
            await target[1].send_json(dict(payload or {}))
            return True
        except Exception:
            await self.disconnect(session_key, connection_id)
            return False

    async def get_roles(self, voice_session_id: str) -> set[str]:
        session_key = (voice_session_id or "").strip()
        async with self._lock:
            bucket = dict(self._connections.get(session_key, {}))
        return {str(role or "").strip() for role, _websocket in bucket.values() if str(role or "").strip()}


remote_voice_signal_bus = RemoteVoiceSignalBus()
