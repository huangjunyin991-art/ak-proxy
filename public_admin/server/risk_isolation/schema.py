from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class RiskIsolationScope:
    role: str
    sub_name: str
    added_by: str
    requested_sub_admin: str
    is_super_admin: bool


@dataclass(frozen=True)
class RiskIsolationMutation:
    usernames: list[str]
    reason: str
    operator: str
    operator_role: str
    added_by: str | None


def normalize_username(value: Any) -> str:
    return str(value or '').strip().lower()


def serialize_time(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.replace(microsecond=0).isoformat(sep=' ')
    return value
