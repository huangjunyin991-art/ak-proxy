# -*- coding: utf-8 -*-
"""Small policy helpers for ntfy-triggered IM identity exchange."""

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class NtfyIdentityExchangePolicy:
    result_ttl_seconds: int = 8
    wait_timeout_seconds: float = 6.0
    wait_poll_seconds: float = 0.12


DEFAULT_NTFY_IDENTITY_EXCHANGE_POLICY = NtfyIdentityExchangePolicy()


def is_same_token_collision(consume_result: dict[str, Any], username: str, conversation_id: int) -> bool:
    if str(consume_result.get("reason") or "") != "already_used":
        return False
    if str(consume_result.get("username") or "").strip().lower() != str(username or "").strip().lower():
        return False
    try:
        return int(consume_result.get("conversation_id") or 0) == int(conversation_id or 0)
    except Exception:
        return False


def build_reused_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    data = dict(snapshot) if isinstance(snapshot, dict) else {}
    if not data:
        return data
    data["success"] = True
    data["tokenExchangeReused"] = True
    return data
