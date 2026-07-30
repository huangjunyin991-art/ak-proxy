from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta, timezone


BEIJING_TIMEZONE = timezone(timedelta(hours=8), name="Asia/Shanghai")


class AKSellClock:
    """Single server-side time source for the AK sell API contract."""

    def __init__(self, now_factory: Callable[[], datetime] | None = None) -> None:
        self._now_factory = now_factory or (lambda: datetime.now(timezone.utc))

    def snapshot(self) -> dict[str, str | int]:
        now = self._now_factory()
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        utc_time = now.astimezone(timezone.utc)
        beijing_time = utc_time.astimezone(BEIJING_TIMEZONE)
        return {
            "epoch_ms": int(utc_time.timestamp() * 1000),
            "utc": utc_time.isoformat().replace("+00:00", "Z"),
            "beijing": beijing_time.isoformat(),
            "v": self.make_v(beijing_time),
        }

    @staticmethod
    def make_v(beijing_time: datetime) -> str:
        return str(
            beijing_time.year
            + beijing_time.month
            + beijing_time.day
            + beijing_time.hour
            + beijing_time.minute
        )
