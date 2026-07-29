"""Connection-failure penalty policy for outbound exits."""

from __future__ import annotations


CONNECTION_FAILURE_FREEZE_SCHEDULE = (10, 30, 60, 180, 300, 900, 3600)


def connection_failure_freeze_seconds(failure_level: int) -> int:
    level = max(1, int(failure_level or 1))
    return CONNECTION_FAILURE_FREEZE_SCHEDULE[
        min(level - 1, len(CONNECTION_FAILURE_FREEZE_SCHEDULE) - 1)
    ]
