from __future__ import annotations

import asyncio
import re
import time
from dataclasses import asdict, dataclass
from typing import Any, Iterable

from .admin_index_plan import ADMIN_INDEX_PLAN, AdminIndexDefinition, get_admin_index_plan


_INDEX_TABLE_RE = re.compile(r"\bON\s+([a-zA-Z_][\w.]*)\b", re.IGNORECASE)
_TRIGRAM_MARKERS = ("gin_trgm_ops", "gist_trgm_ops")


@dataclass
class IndexRunResult:
    name: str
    status: str
    message: str = ""
    elapsed_ms: float = 0.0
    finished_at: float = 0.0


class AdminIndexRunner:
    def __init__(self, plan: Iterable[AdminIndexDefinition] = ADMIN_INDEX_PLAN):
        self._plan = list(plan)
        self._by_name = {item.name: item for item in self._plan}
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._running = False
        self._started_at = 0.0
        self._finished_at = 0.0
        self._current_name = ""
        self._planned_names: list[str] = []
        self._completed = 0
        self._failed = 0
        self._skipped = 0
        self._last_error = ""
        self._recent_results: list[IndexRunResult] = []

    def snapshot(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "started_at": self._started_at,
            "finished_at": self._finished_at,
            "current_name": self._current_name,
            "planned_names": list(self._planned_names),
            "completed": self._completed,
            "failed": self._failed,
            "skipped": self._skipped,
            "last_error": self._last_error,
            "recent_results": [asdict(item) for item in self._recent_results[-20:]],
        }

    async def inspect(self, pool) -> dict[str, Any]:
        async with pool.acquire() as conn:
            extension_ready = await _has_pg_trgm(conn)
            indexes = await _fetch_index_meta(conn)
            tables = await _fetch_table_status(conn, self._plan)
        items = [
            _build_status_item(item, indexes, tables, extension_ready)
            for item in self._plan
        ]
        summary = {
            "total": len(items),
            "ready": sum(1 for item in items if item["status"] in ("exists", "installed")),
            "missing": sum(1 for item in items if item["status"] == "missing"),
            "blocked": sum(1 for item in items if item["status"].startswith("blocked") or item["status"] == "missing_table"),
            "invalid": sum(1 for item in items if item["status"] == "invalid"),
            "runnable": sum(1 for item in items if item.get("runnable")),
        }
        return {
            "success": True,
            "executable": True,
            "items": items,
            "summary": summary,
            "runner": self.snapshot(),
        }

    async def start(self, pool, limit: int = 1, names: Iterable[str] | None = None) -> dict[str, Any]:
        async with self._lock:
            if self._running:
                status = await self.inspect(pool)
                status["accepted"] = False
                status["message"] = "index runner already running"
                return status

            status = await self.inspect(pool)
            selected = self._select_names(status["items"], limit=limit, names=names)
            if not selected:
                status["accepted"] = False
                status["message"] = "no runnable indexes"
                return status

            self._running = True
            self._started_at = time.time()
            self._finished_at = 0.0
            self._current_name = ""
            self._planned_names = selected
            self._completed = 0
            self._failed = 0
            self._skipped = 0
            self._last_error = ""
            self._task = asyncio.create_task(self._run_batch(pool, selected), name="ak-admin-index-runner")

            status = await self.inspect(pool)
            status["accepted"] = True
            status["message"] = "index runner started"
            return status

    def _select_names(self, items: list[dict[str, Any]], limit: int, names: Iterable[str] | None) -> list[str]:
        normalized_limit = max(1, min(int(limit or 1), 5))
        requested = [str(name or "").strip() for name in (names or []) if str(name or "").strip()]
        if requested:
            result = []
            runnable = {item["name"]: item for item in items if item.get("runnable")}
            for name in requested:
                if name in runnable and name not in result:
                    result.append(name)
                if len(result) >= normalized_limit:
                    break
            return result
        return [item["name"] for item in items if item.get("runnable")][:normalized_limit]

    async def _run_batch(self, pool, names: list[str]) -> None:
        try:
            for name in names:
                item = self._by_name.get(name)
                if item is None:
                    self._record_result(IndexRunResult(name=name, status="skipped", message="unknown index"))
                    self._skipped += 1
                    continue
                self._current_name = name
                started = time.monotonic()
                try:
                    async with pool.acquire() as conn:
                        await conn.execute("SET lock_timeout TO '5s'")
                        try:
                            await conn.execute(item.sql, timeout=1800)
                        finally:
                            await conn.execute("RESET lock_timeout")
                    elapsed_ms = (time.monotonic() - started) * 1000
                    self._completed += 1
                    self._record_result(IndexRunResult(
                        name=name,
                        status="ok",
                        elapsed_ms=round(elapsed_ms, 2),
                        finished_at=time.time(),
                    ))
                except Exception as exc:
                    elapsed_ms = (time.monotonic() - started) * 1000
                    self._failed += 1
                    self._last_error = str(exc)[:300]
                    self._record_result(IndexRunResult(
                        name=name,
                        status="failed",
                        message=self._last_error,
                        elapsed_ms=round(elapsed_ms, 2),
                        finished_at=time.time(),
                    ))
        finally:
            self._current_name = ""
            self._running = False
            self._finished_at = time.time()

    def _record_result(self, result: IndexRunResult) -> None:
        if not result.finished_at:
            result.finished_at = time.time()
        self._recent_results.append(result)
        self._recent_results = self._recent_results[-50:]


def _is_extension_item(item: AdminIndexDefinition) -> bool:
    return item.sql.strip().lower().startswith("create extension")


def _requires_pg_trgm(item: AdminIndexDefinition) -> bool:
    sql = item.sql.lower()
    return any(marker in sql for marker in _TRIGRAM_MARKERS)


def _extract_table_name(item: AdminIndexDefinition) -> str:
    match = _INDEX_TABLE_RE.search(item.sql)
    if not match:
        return ""
    return match.group(1).strip().strip('"')


async def _has_pg_trgm(conn) -> bool:
    value = await conn.fetchval("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm')")
    return bool(value)


async def _fetch_index_meta(conn) -> dict[str, dict[str, Any]]:
    rows = await conn.fetch("""
        SELECT c.relname AS name,
               i.indisvalid AS valid,
               i.indisready AS ready,
               pg_get_indexdef(c.oid) AS definition
        FROM pg_class c
        JOIN pg_index i ON i.indexrelid = c.oid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
    """)
    return {str(row["name"]): dict(row) for row in rows}


async def _fetch_table_status(conn, plan: list[AdminIndexDefinition]) -> dict[str, bool]:
    names = sorted({
        _extract_table_name(item)
        for item in plan
        if not _is_extension_item(item) and _extract_table_name(item)
    })
    if not names:
        return {}
    rows = await conn.fetch("""
        SELECT name, to_regclass(name) IS NOT NULL AS exists
        FROM unnest($1::text[]) AS name
    """, names)
    return {str(row["name"]): bool(row["exists"]) for row in rows}


def _build_status_item(
    item: AdminIndexDefinition,
    indexes: dict[str, dict[str, Any]],
    tables: dict[str, bool],
    pg_trgm_ready: bool,
) -> dict[str, Any]:
    base = {
        "name": item.name,
        "sql": item.sql,
        "purpose": item.purpose,
        "risk": item.risk,
        "table": _extract_table_name(item),
        "status": "missing",
        "runnable": False,
        "message": "",
    }
    if _is_extension_item(item):
        base["status"] = "installed" if pg_trgm_ready else "missing"
        base["runnable"] = not pg_trgm_ready
        return base

    table_name = base["table"]
    if table_name and not tables.get(table_name, False):
        base["status"] = "missing_table"
        base["message"] = f"table {table_name} does not exist"
        return base

    meta = indexes.get(item.name)
    if meta:
        if bool(meta.get("valid")) and bool(meta.get("ready")):
            base["status"] = "exists"
        else:
            base["status"] = "invalid"
            base["message"] = "index exists but is not valid/ready; manual cleanup may be required"
        return base

    if _requires_pg_trgm(item) and not pg_trgm_ready:
        base["status"] = "blocked_extension"
        base["message"] = "pg_trgm extension is not installed"
        return base

    base["status"] = "missing"
    base["runnable"] = True
    return base


_RUNNER = AdminIndexRunner()


async def get_admin_index_plan_status(pool) -> dict[str, Any]:
    return await _RUNNER.inspect(pool)


async def start_admin_index_plan_run(pool, limit: int = 1, names: Iterable[str] | None = None) -> dict[str, Any]:
    return await _RUNNER.start(pool, limit=limit, names=names)


def get_admin_index_runner_snapshot() -> dict[str, Any]:
    return _RUNNER.snapshot()


__all__ = [
    "AdminIndexRunner",
    "get_admin_index_plan",
    "get_admin_index_plan_status",
    "get_admin_index_runner_snapshot",
    "start_admin_index_plan_run",
]
