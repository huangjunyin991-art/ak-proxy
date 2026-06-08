from __future__ import annotations

from typing import Any

from public_admin.server.security.url_fetch_gateway import UrlFetchGateway
from ..base import ChannelSendResult
from .client import PushDeerClient, normalize_server_url
from .payload import build_pushdeer_payload


class PushDeerChannel:
    def __init__(self, *, timeout_seconds: int = 8, fetch_gateway: UrlFetchGateway | None = None):
        self._client = PushDeerClient(timeout_seconds=timeout_seconds, fetch_gateway=fetch_gateway)

    def validate_server_url(self, server_url: str) -> str:
        return self._client.validate_server_url(server_url)

    async def send(self, *, binding: dict[str, Any], notification: dict[str, Any]) -> ChannelSendResult:
        if not binding:
            return ChannelSendResult(success=False, error='PushDeer 未绑定')
        if not binding.get('enabled'):
            return ChannelSendResult(success=False, error='PushDeer 绑定已关闭')
        payload = build_pushdeer_payload(notification)
        try:
            server_url = normalize_server_url(str(binding.get('server_url') or ''))
        except ValueError as exc:
            return ChannelSendResult(success=False, error=str(exc))
        return await self._client.send(
            server_url=server_url,
            pushkey=str(binding.get('pushkey') or ''),
            text=payload.get('text') or '',
            desp=payload.get('desp') or '',
            message_type=payload.get('type') or 'markdown',
        )
