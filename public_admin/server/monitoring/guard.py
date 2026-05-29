from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ALLOWED_RANGES = {"24h", "7d", "30d"}
DEFAULT_RANGE = "7d"
MAX_LIMIT_GROUPS = 100
MAX_LIMIT_FILE_ASSETS = 100


@dataclass
class GuardError(Exception):
    code: str
    message: str

    def __str__(self) -> str:
        return self.message


def validate_range(range_name: str | None) -> str:
    value = str(range_name or DEFAULT_RANGE).strip().lower()
    if value not in ALLOWED_RANGES:
        raise GuardError("invalid_range", f"时间窗口仅支持 {', '.join(sorted(ALLOWED_RANGES))}，默认 {DEFAULT_RANGE}")
    return value


def validate_limit(kind: Literal["groups", "file_assets"], limit: int | None) -> int:
    try:
        normalized = int(limit or 0)
    except Exception:
        raise GuardError("invalid_limit", "limit 必须是数字")

    if normalized <= 0:
        raise GuardError("invalid_limit", "limit 必须大于 0")

    cap = MAX_LIMIT_GROUPS if kind == "groups" else MAX_LIMIT_FILE_ASSETS
    if normalized > cap:
        raise GuardError("limit_exceeded", f"{kind} 的 limit 不能超过 {cap}")
    return normalized
