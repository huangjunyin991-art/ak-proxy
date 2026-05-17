from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class ChannelSendResult:
    success: bool
    provider_message_id: str = ''
    provider_record_id: str = ''
    error: str = ''
    raw: dict[str, Any] | None = None


@dataclass(frozen=True)
class ChannelQrCodeResult:
    success: bool
    code: str = ''
    url: str = ''
    short_url: str = ''
    expires_in: int = 0
    error: str = ''
    raw: dict[str, Any] | None = None


class NotifyChannel(Protocol):
    async def send(self, *, target_id: str, title: str, content: str, summary: str, url: str = '') -> ChannelSendResult:
        ...

    async def create_bind_qrcode(self, *, extra: str, valid_seconds: int) -> ChannelQrCodeResult:
        ...
