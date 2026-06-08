from __future__ import annotations

from typing import Any

from public_admin.server.security.url_fetch_gateway import UrlFetchGateway
from ..base import ChannelSendResult
from .client import NtfyClient, normalize_server_url, normalize_topic
from .payload import build_ntfy_payload


class NtfyChannel:
    def __init__(self, *, timeout_seconds: int = 8, fetch_gateway: UrlFetchGateway | None = None):
        self._client = NtfyClient(timeout_seconds=timeout_seconds, fetch_gateway=fetch_gateway)

    def validate_server_url(self, server_url: str) -> str:
        return self._client.validate_server_url(server_url)

    async def send(self, *, binding: dict[str, Any], notification: dict[str, Any]) -> ChannelSendResult:
        if not binding:
            return ChannelSendResult(success=False, error='ntfy 未绑定')
        if not binding.get('enabled'):
            return ChannelSendResult(success=False, error='ntfy 绑定已关闭')
        try:
            server_url = normalize_server_url(str(binding.get('server_url') or ''))
            topic = normalize_topic(str(binding.get('topic') or ''))
        except ValueError as exc:
            return ChannelSendResult(success=False, error=str(exc))
        payload = build_ntfy_payload(notification)
        return await self._client.send(
            server_url=server_url,
            topic=topic,
            title=payload.get('title') or '',
            message=payload.get('message') or '',
            click_url=payload.get('click_url') or '',
            priority=payload.get('priority') or 'default',
            tags=payload.get('tags') or '',
        )
