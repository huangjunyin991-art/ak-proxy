from dataclasses import dataclass, asdict
from typing import Any


@dataclass(frozen=True)
class LoginProtectionPolicy:
    enabled: bool = True
    min_interval_seconds: int = 5
    window_seconds: int = 60
    max_requests_per_window: int = 20
    short_interval_block_enabled: bool = True
    short_interval_ban_threshold: int = 3
    ban_base_seconds: int = 3600
    ignore_loopback: bool = True

    @classmethod
    def from_mapping(cls, payload: dict | None) -> "LoginProtectionPolicy":
        data = dict(payload or {})
        return cls(
            enabled=bool(data.get("enabled", True)),
            min_interval_seconds=_int_range(data.get("min_interval_seconds"), 1, 3600, 5),
            window_seconds=_int_range(data.get("window_seconds"), 5, 86400, 60),
            max_requests_per_window=_int_range(data.get("max_requests_per_window"), 1, 10000, 20),
            short_interval_block_enabled=bool(data.get("short_interval_block_enabled", True)),
            short_interval_ban_threshold=_int_range(data.get("short_interval_ban_threshold"), 1, 1000, 3),
            ban_base_seconds=_int_range(data.get("ban_base_seconds"), 60, 30 * 86400, 3600),
            ignore_loopback=bool(data.get("ignore_loopback", True)),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class LoginProtectionDecision:
    allowed: bool
    code: str = "ok"
    message: str = ""
    count: int = 0
    short_interval_count: int = 0
    interval_seconds: float = 0.0
    duration_seconds: int = 0
    level: int = 0
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _int_range(value, minimum: int, maximum: int, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))
