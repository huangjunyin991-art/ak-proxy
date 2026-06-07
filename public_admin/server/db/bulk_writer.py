from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from typing import Any, Iterable, Sequence


class BulkWriterMetrics:
    def __init__(self, recent_limit: int = 20):
        self._lock = threading.Lock()
        self._recent_limit = max(1, int(recent_limit or 20))
        self._operations: dict[str, dict[str, Any]] = defaultdict(self._new_operation)
        self._recent: deque[dict[str, Any]] = deque(maxlen=self._recent_limit)

    @staticmethod
    def _new_operation() -> dict[str, Any]:
        return {
            "calls": 0,
            "rows": 0,
            "failed": 0,
            "slow_count": 0,
            "total_ms": 0.0,
            "max_ms": 0.0,
            "max_rows": 0,
            "last_ms": 0.0,
            "last_rows": 0,
            "last_error": "",
            "last_error_at": 0.0,
        }

    def record(
        self,
        operation: str,
        rows: int,
        elapsed_ms: float,
        *,
        error: BaseException | None = None,
        slow_ms: float = 250.0,
    ) -> None:
        name = str(operation or "bulk").strip() or "bulk"
        row_count = max(0, int(rows or 0))
        elapsed = max(0.0, float(elapsed_ms or 0.0))
        now = time.time()
        with self._lock:
            item = self._operations[name]
            item["calls"] += 1
            item["rows"] += row_count
            item["total_ms"] += elapsed
            item["max_ms"] = max(float(item["max_ms"]), elapsed)
            item["max_rows"] = max(int(item["max_rows"]), row_count)
            item["last_ms"] = elapsed
            item["last_rows"] = row_count
            if elapsed >= slow_ms:
                item["slow_count"] += 1
            if error is not None:
                item["failed"] += 1
                item["last_error"] = str(error)[:300]
                item["last_error_at"] = now
            sample = {
                "operation": name,
                "rows": row_count,
                "elapsed_ms": round(elapsed, 2),
                "failed": error is not None,
                "error": type(error).__name__ if error is not None else "",
                "ts": now,
            }
            if elapsed >= slow_ms or error is not None:
                self._recent.append(sample)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            operations = {}
            total_calls = 0
            total_rows = 0
            total_failed = 0
            for name, item in self._operations.items():
                calls = int(item["calls"] or 0)
                rows = int(item["rows"] or 0)
                total_calls += calls
                total_rows += rows
                total_failed += int(item["failed"] or 0)
                operations[name] = {
                    "calls": calls,
                    "rows": rows,
                    "failed": int(item["failed"] or 0),
                    "slow_count": int(item["slow_count"] or 0),
                    "avg_ms": round(float(item["total_ms"] or 0.0) / max(1, calls), 2),
                    "avg_rows": round(rows / max(1, calls), 2),
                    "max_ms": round(float(item["max_ms"] or 0.0), 2),
                    "max_rows": int(item["max_rows"] or 0),
                    "last_ms": round(float(item["last_ms"] or 0.0), 2),
                    "last_rows": int(item["last_rows"] or 0),
                    "last_error": str(item["last_error"] or ""),
                    "last_error_at": float(item["last_error_at"] or 0.0),
                }
            return {
                "calls": total_calls,
                "rows": total_rows,
                "failed": total_failed,
                "operations": operations,
                "recent": list(self._recent),
            }


_DEFAULT_METRICS = BulkWriterMetrics()


def rows_to_columns(rows: Iterable[Sequence[Any]], column_count: int) -> list[list[Any]]:
    count = max(0, int(column_count or 0))
    columns: list[list[Any]] = [[] for _ in range(count)]
    for row in rows or []:
        if len(row) != count:
            raise ValueError(f"bulk row has {len(row)} columns, expected {count}")
        for index, value in enumerate(row):
            columns[index].append(value)
    return columns


async def execute_bulk_unnest(
    conn,
    sql: str,
    columns: Sequence[Sequence[Any]],
    *,
    operation: str,
    row_count: int | None = None,
    slow_ms: float = 250.0,
):
    rows = int(row_count if row_count is not None else (len(columns[0]) if columns else 0))
    started = time.perf_counter()
    try:
        result = await conn.execute(sql, *columns)
    except BaseException as exc:
        _DEFAULT_METRICS.record(operation, rows, (time.perf_counter() - started) * 1000.0, error=exc, slow_ms=slow_ms)
        raise
    _DEFAULT_METRICS.record(operation, rows, (time.perf_counter() - started) * 1000.0, slow_ms=slow_ms)
    return result


def get_bulk_writer_snapshot() -> dict[str, Any]:
    return _DEFAULT_METRICS.snapshot()

