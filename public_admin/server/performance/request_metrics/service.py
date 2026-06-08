import time
from collections import Counter, deque
from threading import RLock
from typing import Any

from .diagnostics import build_request_metrics_diagnostics
from .models import RequestMetricEvent, RequestMetricsPolicy


class RequestMetricsService:
    def __init__(self, policy: RequestMetricsPolicy | None = None):
        self._policy = policy or RequestMetricsPolicy()
        self._events = deque(maxlen=self._policy.max_records)
        self._lock = RLock()
        self._sequence = 0
        self._reset_counters_locked()

    def is_enabled(self) -> bool:
        return bool(self._policy.enabled)

    def get_policy(self) -> dict[str, Any]:
        return self._policy.to_dict()

    def update_policy(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        policy = RequestMetricsPolicy.from_mapping(payload)
        with self._lock:
            previous_enabled = self._policy.enabled
            self._policy = policy
            self._events = deque(list(self._events)[-policy.max_records:], maxlen=policy.max_records)
            if policy.enabled and not previous_enabled:
                self._reset_counters_locked()
        return self.snapshot()

    def clear(self) -> dict[str, Any]:
        with self._lock:
            self._events.clear()
            self._reset_counters_locked()
        return self.snapshot()

    def record(self, payload: dict[str, Any] | RequestMetricEvent) -> bool:
        if not self._policy.enabled:
            return False
        event = payload if isinstance(payload, RequestMetricEvent) else RequestMetricEvent.from_mapping(payload)
        with self._lock:
            if not self._policy.enabled:
                return False
            self._sequence += 1
            sequence = self._sequence
            item = event.to_dict(sequence)
            is_slow = event.total_ms >= self._policy.slow_threshold_ms
            is_error = bool(event.error) or event.status_code >= 500
            self._record_counter_locked(event, is_slow, is_error)
            if is_slow or is_error:
                item["slow"] = is_slow
                item["error_record"] = is_error
                self._events.append(item)
            return True

    def snapshot(self, limit: int = 80) -> dict[str, Any]:
        with self._lock:
            items = list(self._events)
            items.sort(key=lambda item: (int(item.get("total_ms") or 0), int(item.get("id") or 0)), reverse=True)
            limit = max(1, min(500, int(limit or 80)))
            diagnostics = build_request_metrics_diagnostics(items, self._policy)
            return {
                "available": True,
                "generated_at": time.time(),
                "policy": self._policy.to_dict(),
                "summary": {
                    "started_at": self._started_at,
                    "last_event_at": self._last_event_at,
                    "observed_count": self._observed_count,
                    "stored_count": len(self._events),
                    "slow_count": self._slow_count,
                    "error_count": self._error_count,
                    "avg_total_ms": round(self._total_ms_sum / self._observed_count, 1) if self._observed_count else 0,
                    "max_total_ms": self._max_total_ms,
                    "max_path": self._max_path,
                    "by_kind": dict(self._kind_counts),
                    "by_cache_state": dict(self._cache_counts),
                    "by_status_class": dict(self._status_counts),
                },
                "diagnostics": diagnostics,
                "items": items[:limit],
            }

    def _reset_counters_locked(self) -> None:
        self._started_at = time.time()
        self._last_event_at = 0.0
        self._observed_count = 0
        self._slow_count = 0
        self._error_count = 0
        self._total_ms_sum = 0
        self._max_total_ms = 0
        self._max_path = ""
        self._kind_counts = Counter()
        self._cache_counts = Counter()
        self._status_counts = Counter()

    def _record_counter_locked(self, event: RequestMetricEvent, is_slow: bool, is_error: bool) -> None:
        self._observed_count += 1
        self._last_event_at = event.ts
        self._total_ms_sum += event.total_ms
        if is_slow:
            self._slow_count += 1
        if is_error:
            self._error_count += 1
        if event.total_ms >= self._max_total_ms:
            self._max_total_ms = event.total_ms
            self._max_path = event.path
        self._kind_counts[event.kind or "unknown"] += 1
        self._cache_counts[event.cache_state or "NONE"] += 1
        self._status_counts[_status_class(event.status_code)] += 1


def _status_class(status_code: int) -> str:
    if status_code <= 0:
        return "unknown"
    return f"{int(status_code / 100)}xx"
