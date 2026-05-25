from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class AkUserKeyValidationResult:
    valid: bool
    reason: str = ''
    status_code: int = 0
    payload: dict[str, Any] = field(default_factory=dict)
    elapsed_ms: int = 0


@dataclass(frozen=True)
class AkLoginFastPathResult:
    success: bool
    reason: str = ''
    login_payload: dict[str, Any] = field(default_factory=dict)
    cookies: dict[str, str] = field(default_factory=dict)
    userkey: str = ''
    user_id: str = ''
    username: str = ''
    validation: AkUserKeyValidationResult | None = None
