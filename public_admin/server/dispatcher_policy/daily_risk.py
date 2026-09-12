"""Local-calendar boundaries for per-exit HTTP risk statistics."""

from __future__ import annotations

import time
from datetime import datetime


def current_local_day(now: float | None = None) -> str:
    """Return the server-local ISO date for a wall-clock timestamp."""
    timestamp = time.time() if now is None else float(now)
    return datetime.fromtimestamp(timestamp).astimezone().date().isoformat()


def is_current_local_day(value: object, now: float | None = None) -> bool:
    return str(value or "").strip() == current_local_day(now)
