from dataclasses import dataclass
from datetime import date, datetime
from typing import Any


@dataclass(frozen=True)
class LoginAuditEvent:
    username: str
    ip_address: str
    user_agent: str
    request_path: str
    status_code: int
    is_success: bool
    extra_data: str
    login_time: datetime
    login_record_id: int | None = None
    password_present: bool = False


@dataclass(frozen=True)
class LoginAggregateDelta:
    login_record_id: int | None
    username: str
    ip_address: str
    request_path: str
    status_code: int
    is_success: bool
    login_time: datetime
    login_day: date
    login_hour: int
    login_minute: datetime
    password_present: bool = False


@dataclass(frozen=True)
class LoginDeltaFlushResult:
    claimed: int = 0
    processed: int = 0
    users: int = 0
    ips: int = 0


@dataclass(frozen=True)
class LoginDeltaBackfillResult:
    inserted: int = 0
    last_login_record_id: int = 0
    completed: bool = False


def row_to_dict(row: Any) -> dict[str, Any]:
    if row is None:
        return {}
    if isinstance(row, dict):
        return dict(row)
    return dict(row)
