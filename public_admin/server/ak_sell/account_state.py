from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class CachedAKAccountAuth:
    """The minimum AK identity reconstructed from the shared user_stats state."""

    account: str
    userkey: str
    user_id: str


class UserStatsAKAccountState:
    """Read the existing proxy login state without creating another credential store."""

    def __init__(
        self,
        *,
        load_auth_state: Callable[[str], Awaitable[Mapping[str, Any] | None]],
        get_password: Callable[[str], Awaitable[str | None]],
        clear_auth_state: Callable[[str], Awaitable[bool]],
    ) -> None:
        self._load_auth_state = load_auth_state
        self._get_password = get_password
        self._clear_auth_state = clear_auth_state

    async def get_auth(self, account: str) -> CachedAKAccountAuth | None:
        normalized = self.normalize_account(account)
        if not normalized:
            return None
        state = await self._load_auth_state(normalized)
        if not isinstance(state, Mapping):
            return None
        userkey = self._first_text(
            state.get("userkey"),
            self._payload_value(state.get("login_result"), "Key", "key", "UserKey", "userkey"),
        )
        user_id = self._first_text(
            self._payload_value(state.get("login_result"), "UserID", "userId", "userid", "Id", "ID", "id"),
            self._payload_value(self._payload_value(state.get("login_result"), "UserData", "userData", "data"), "Id", "ID", "id", "UserID", "userId", "userid"),
        )
        if not userkey or not user_id:
            return None
        return CachedAKAccountAuth(account=normalized, userkey=userkey, user_id=user_id)

    async def get_password(self, account: str) -> str:
        normalized = self.normalize_account(account)
        if not normalized:
            return ""
        return str(await self._get_password(normalized) or "").strip()

    async def invalidate_auth(self, account: str) -> None:
        normalized = self.normalize_account(account)
        if normalized:
            await self._clear_auth_state(normalized)

    @staticmethod
    def normalize_account(account: object) -> str:
        return str(account or "").strip().lower()

    @staticmethod
    def _first_text(*values: object) -> str:
        for value in values:
            text = str(value or "").strip()
            if text:
                return text
        return ""

    @staticmethod
    def _payload_value(payload: object, *names: str) -> object:
        if not isinstance(payload, Mapping):
            return ""
        for name in names:
            if name in payload:
                return payload[name]
        return ""
