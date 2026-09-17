"""Small asynchronous aggregator for per-exit daily request counts.

Only counters are persisted. Request payloads, accounts, and paths are
intentionally outside this module so the statistics path stays cheap and
credential-free.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import date
from typing import Any, Callable


class ExitRequestStatsService:
    RETENTION_DAYS = 7

    def __init__(self, pool_supplier: Callable[[], Any], logger: logging.Logger | None = None) -> None:
        self._pool_supplier = pool_supplier
        self._logger = logger or logging.getLogger("TransparentProxy")
        self._lock = asyncio.Lock()
        self._pending: dict[tuple[str, str], dict[str, int | str]] = {}
        self._totals: dict[str, dict[str, int | str]] = {}
        self._wake = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._started = False

    @staticmethod
    def _today() -> str:
        return date.today().isoformat()

    @staticmethod
    def _identity(identity: str, name: str = "") -> str:
        return str(identity or name or "direct").strip() or "direct"

    @staticmethod
    def _blank(identity: str, name: str, exit_ip: str) -> dict[str, int | str]:
        return {
            "stat_date": date.today().isoformat(),
            "node_identity": identity,
            "node_name": str(name or ""),
            "exit_ip": str(exit_ip or ""),
            "total_requests": 0,
            "success_requests": 0,
            "error_requests": 0,
            "status_403": 0,
            "status_429": 0,
        }

    async def ensure_schema(self) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS exit_request_daily_stats (
                    stat_date DATE NOT NULL,
                    node_identity TEXT NOT NULL,
                    node_name TEXT NOT NULL DEFAULT '',
                    exit_ip TEXT NOT NULL DEFAULT '',
                    total_requests BIGINT NOT NULL DEFAULT 0,
                    success_requests BIGINT NOT NULL DEFAULT 0,
                    error_requests BIGINT NOT NULL DEFAULT 0,
                    status_403 BIGINT NOT NULL DEFAULT 0,
                    status_429 BIGINT NOT NULL DEFAULT 0,
                    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (stat_date, node_identity)
                )
                """
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_exit_request_daily_stats_date "
                "ON exit_request_daily_stats(stat_date)"
            )

    async def start(self) -> None:
        if self._started:
            return
        await self.ensure_schema()
        self._started = True
        await self._load_today()
        await self.cleanup()
        self._task = asyncio.create_task(self._run(), name="exit-request-stats")

    async def _load_today(self) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT stat_date,node_identity,node_name,exit_ip,total_requests,success_requests,"
                "error_requests,status_403,status_429 FROM exit_request_daily_stats WHERE stat_date=CURRENT_DATE"
            )
        self._totals = {str(row["node_identity"]): dict(row) for row in rows}

    def record(self, *, identity: str, name: str = "", exit_ip: str = "", status_code: int = 0) -> None:
        """Add one completed upstream attempt without doing I/O."""
        key_identity = self._identity(identity, name)
        day = self._today()
        key = (day, key_identity)
        row = self._pending.get(key)
        if row is None:
            row = self._blank(key_identity, name, exit_ip)
            self._pending[key] = row
        row["node_name"] = str(name or row.get("node_name") or "")
        row["exit_ip"] = str(exit_ip or row.get("exit_ip") or "")
        row["total_requests"] = int(row["total_requests"]) + 1
        status = int(status_code or 0)
        if 200 <= status < 400:
            row["success_requests"] = int(row["success_requests"]) + 1
        else:
            row["error_requests"] = int(row["error_requests"]) + 1
        if status == 403:
            row["status_403"] = int(row["status_403"]) + 1
        elif status == 429:
            row["status_429"] = int(row["status_429"]) + 1
        current = self._totals.get(key_identity)
        if current is None or str(current.get("stat_date") or "") != day:
            current = self._blank(key_identity, name, exit_ip)
            self._totals[key_identity] = current
        for field in ("node_name", "exit_ip"):
            if row[field]:
                current[field] = row[field]
        current["total_requests"] = int(current["total_requests"]) + 1
        if 200 <= status < 400:
            current["success_requests"] = int(current["success_requests"]) + 1
        else:
            current["error_requests"] = int(current["error_requests"]) + 1
        if status == 403:
            current["status_403"] = int(current["status_403"]) + 1
        elif status == 429:
            current["status_429"] = int(current["status_429"]) + 1
        self._wake.set()

    def snapshot(self, identity: str = "") -> dict[str, dict[str, int | str]]:
        if identity:
            item = self._totals.get(self._identity(identity))
            return {self._identity(identity): dict(item)} if item else {}
        return {key: dict(value) for key, value in self._totals.items()}

    async def _run(self) -> None:
        try:
            while self._started:
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=2.0)
                except asyncio.TimeoutError:
                    pass
                self._wake.clear()
                await self.flush()
        except asyncio.CancelledError:
            return

    async def flush(self) -> None:
        if not self._pending:
            return
        async with self._lock:
            batch = self._pending
            self._pending = {}
        pool = self._pool_supplier()
        try:
            async with pool.acquire() as conn:
                async with conn.transaction():
                    for row in batch.values():
                        await conn.execute(
                            """
                            INSERT INTO exit_request_daily_stats
                              (stat_date,node_identity,node_name,exit_ip,total_requests,success_requests,
                               error_requests,status_403,status_429,updated_at)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
                            ON CONFLICT (stat_date,node_identity) DO UPDATE SET
                              node_name=EXCLUDED.node_name, exit_ip=EXCLUDED.exit_ip,
                              total_requests=exit_request_daily_stats.total_requests+EXCLUDED.total_requests,
                              success_requests=exit_request_daily_stats.success_requests+EXCLUDED.success_requests,
                              error_requests=exit_request_daily_stats.error_requests+EXCLUDED.error_requests,
                              status_403=exit_request_daily_stats.status_403+EXCLUDED.status_403,
                              status_429=exit_request_daily_stats.status_429+EXCLUDED.status_429,
                              updated_at=NOW()
                            """,
                            row["stat_date"], row["node_identity"], row["node_name"], row["exit_ip"],
                            int(row["total_requests"]), int(row["success_requests"]), int(row["error_requests"]),
                            int(row["status_403"]), int(row["status_429"]),
                        )
        except Exception:
            async with self._lock:
                for key, row in batch.items():
                    previous = self._pending.get(key)
                    if previous is None:
                        self._pending[key] = row
                    else:
                        for field in ("total_requests", "success_requests", "error_requests", "status_403", "status_429"):
                            previous[field] = int(previous[field]) + int(row[field])
            self._logger.warning("[ExitRequestStats] flush failed", exc_info=True)

    async def cleanup(self) -> int:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM exit_request_daily_stats WHERE stat_date < CURRENT_DATE - 6"
            )
        return int(str(result).split()[-1])

    async def stop(self) -> None:
        if not self._started:
            await self.flush()
            return
        self._started = False
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
        await self.flush()
