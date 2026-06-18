from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any


@dataclass
class AkTradeDayBatch:
    date_key: date
    items: list[dict[str, Any]] = field(default_factory=list)

    @property
    def trade_ids(self) -> list[int]:
        return sorted({int(item.get("trade_id") or 0) for item in self.items if int(item.get("trade_id") or 0) > 0}, reverse=True)

    @property
    def is_contiguous(self) -> bool:
        ids = self.trade_ids
        if not ids:
            return False
        return len(ids) == ids[0] - ids[-1] + 1


class AkTradeDayBuffer:
    """Collect consecutive fetched trades until the scanner crosses into an older day."""

    def __init__(self) -> None:
        self._date_key: date | None = None
        self._items: list[dict[str, Any]] = []

    @property
    def date_key(self) -> date | None:
        return self._date_key

    @property
    def count(self) -> int:
        return len(self._items)

    @property
    def trade_ids(self) -> list[int]:
        return sorted({int(item.get("trade_id") or 0) for item in self._items if int(item.get("trade_id") or 0) > 0}, reverse=True)

    def add(self, item: dict[str, Any]) -> AkTradeDayBatch | None:
        item_day = item.get("date")
        if not isinstance(item_day, date):
            return None
        if self._date_key is None:
            self._date_key = item_day
        if item_day != self._date_key:
            closed = self.flush()
            self._date_key = item_day
            self._items = [item]
            return closed
        self._items.append(item)
        return None

    def flush(self) -> AkTradeDayBatch | None:
        if self._date_key is None or not self._items:
            self._date_key = None
            self._items = []
            return None
        closed = AkTradeDayBatch(self._date_key, self._items)
        self._date_key = None
        self._items = []
        return closed
