from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class SecurityResult:
    success: bool
    event: str
    reason: str = ''
    role: Optional[str] = None
    sub_name: str = ''
