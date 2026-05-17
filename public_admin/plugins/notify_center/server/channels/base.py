from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ChannelSendResult:
    success: bool
    provider_message_id: str = ''
    provider_record_id: str = ''
    error: str = ''
    subscription_expired: bool = False
    raw: dict[str, Any] = field(default_factory=dict)
