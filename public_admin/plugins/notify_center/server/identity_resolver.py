from __future__ import annotations

from dataclasses import dataclass

from fastapi import Request

from .config import NotifyCenterConfig
from .identity import get_identity_cookie_username


@dataclass(frozen=True)
class NotifyIdentity:
    username: str
    source: str

    @property
    def ok(self) -> bool:
        return bool(self.username)


class NotifyIdentityResolver:
    """Resolve notify user identity from server-signed state only."""

    def __init__(self, config: NotifyCenterConfig):
        self.config = config

    def resolve(self, request: Request) -> NotifyIdentity:
        username = get_identity_cookie_username(
            request,
            cookie_name=self.config.identity_cookie_name,
            secret=self.config.identity_secret,
        )
        if username:
            return NotifyIdentity(username=username, source="signed_cookie")
        return NotifyIdentity(username="", source="missing_or_invalid_signed_cookie")
