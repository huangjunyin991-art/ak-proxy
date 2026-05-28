from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass(frozen=True)
class PasswordFailureEvent:
    username: str
    ip_address: str
    occurred_at: datetime
    login_record_id: Optional[int] = None
    is_success: bool = False
    is_password_failure: bool = False
