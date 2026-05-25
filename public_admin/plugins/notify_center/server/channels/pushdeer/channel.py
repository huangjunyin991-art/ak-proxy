from __future__ import annotations

from typing import Any

from ..base import ChannelSendResult
from .client import PushDeerClient, normalize_server_url
from .payload import build_pushdeer_payload


class PushDeerChannel:
    def __init__(self, *, timeout_seconds: int = 8):
        self._client = PushDeerClient(timeout_seconds=timeout_seconds)

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
