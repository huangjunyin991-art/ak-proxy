from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class NotificationHistoryQuery:
    limit: int = 20
    offset: int = 0
    created_by: Optional[str] = None
