"""轻量级在途请求登记，用于定位尚未完成的卡住请求。"""

from __future__ import annotations

import contextvars
import os
import time
import uuid
from threading import RLock
from typing import Any


_current_request_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "ak_request_metrics_id", default=""
)


class InFlightRequestRegistry:
    def __init__(self, max_records: int | None = None) -> None:
        try:
            configured = int(max_records or os.environ.get("AK_INFLIGHT_REQUEST_MAX", "2000"))
        except (TypeError, ValueError):
            configured = 2000
        self.max_records = max(100, min(configured, 10000))
        self._records: dict[str, dict[str, Any]] = {}
        self._lock = RLock()

    def begin(self, method: str, path: str, *, request_id: str = "") -> str:
        token = str(request_id or "").strip() or f"req-{uuid.uuid4().hex[:16]}"
        now = time.time()
        with self._lock:
            if len(self._records) >= self.max_records:
                oldest = min(self._records, key=lambda key: self._records[key]["started_at"])
                self._records.pop(oldest, None)
            self._records[token] = {
                "request_id": token,
                "method": str(method or "GET").upper(),
                "path": str(path or "-")[:240],
                "stage": "request_received",
                "started_at": now,
                "updated_at": now,
            }
        return token

    def update(self, token: str, stage: str, **fields: Any) -> bool:
        token = str(token or "").strip()
        if not token:
            return False
        with self._lock:
            record = self._records.get(token)
            if record is None:
                return False
            record["stage"] = str(stage or "unknown")[:80]
            record["updated_at"] = time.time()
            for key, value in fields.items():
                if value is not None:
                    record[str(key)] = str(value)[:240] if isinstance(value, str) else value
            return True

    def finish(self, request_id: str, *, status_code: int = 0, error: str = "") -> bool:
        token = str(request_id or "").strip()
        if not token:
            return False
        with self._lock:
            record = self._records.pop(token, None)
        return record is not None

    def snapshot(self, limit: int = 200, stale_after_ms: int = 0) -> list[dict[str, Any]]:
        now = time.time()
        with self._lock:
            rows = []
            for record in self._records.values():
                item = dict(record)
                item["age_ms"] = max(0, int((now - float(record.get("started_at") or now)) * 1000))
                item["idle_ms"] = max(0, int((now - float(record.get("updated_at") or now)) * 1000))
                if stale_after_ms and item["age_ms"] < int(stale_after_ms):
                    continue
                rows.append(item)
        rows.sort(key=lambda item: (item.get("age_ms", 0), item.get("request_id", "")), reverse=True)
        return rows[: max(1, min(int(limit or 200), 1000))]

    def count(self) -> int:
        with self._lock:
            return len(self._records)


_default_registry = InFlightRequestRegistry()


def begin_current_request(method: str, path: str, *, request_id: str = "") -> str:
    token = _default_registry.begin(method, path, request_id=request_id)
    _current_request_id.set(token)
    return token


def finish_current_request(*, status_code: int = 0, error: str = "") -> bool:
    token = _current_request_id.get()
    try:
        return _default_registry.finish(token, status_code=status_code, error=error)
    finally:
        _current_request_id.set("")


def mark_current_request_stage(stage: str, **fields: Any) -> bool:
    return _default_registry.update(_current_request_id.get(), stage, **fields)


def get_inflight_snapshot(limit: int = 200, stale_after_ms: int = 0) -> list[dict[str, Any]]:
    return _default_registry.snapshot(limit=limit, stale_after_ms=stale_after_ms)


def get_inflight_count() -> int:
    return _default_registry.count()
