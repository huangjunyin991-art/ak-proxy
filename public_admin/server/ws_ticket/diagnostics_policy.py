from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable


CONFIG_KEY = "ws_ticket_diagnostics_policy"
DEFAULT_RETENTION_DAYS = 3
DEFAULT_AUTO_CLOSE_MINUTES = 30


class WsTicketDiagnosticsPolicyStore:
    def __init__(self, pool_supplier: Callable[[], Any], *, cache_ttl_seconds: int = 5, logger: Any = None):
        self._pool_supplier = pool_supplier
        self._cache_ttl_seconds = max(1, min(60, int(cache_ttl_seconds or 5)))
        self._logger = logger
        self._cache: dict[str, Any] | None = None
        self._cache_time = 0.0
        self._lock = asyncio.Lock()

    async def get_policy(self, *, force: bool = False) -> dict[str, Any]:
        now = time.time()
        async with self._lock:
            if not force and self._cache is not None and now - self._cache_time < self._cache_ttl_seconds:
                return dict(self._cache)
        policy = await self._read_policy()
        async with self._lock:
            self._cache = dict(policy)
            self._cache_time = now
        return dict(policy)

    async def set_policy(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        policy = normalize_ws_ticket_diagnostics_policy(payload or {})
        await self._ensure_table()
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO system_config (key, value, description, updated_at)
                VALUES ($1, $2::jsonb, $3, NOW())
                ON CONFLICT (key) DO UPDATE SET
                    value = $2::jsonb,
                    description = $3,
                    updated_at = NOW()
                """,
                CONFIG_KEY,
                json.dumps(_persisted_policy(policy), ensure_ascii=False),
                "WebSocket ticket diagnostics policy",
            )
        await self.prune_events(policy.get("retention_days") or DEFAULT_RETENTION_DAYS)
        async with self._lock:
            self._cache = dict(policy)
            self._cache_time = time.time()
        return dict(policy)

    async def is_enabled(self) -> bool:
        try:
            policy = await self.get_policy()
            return bool(policy.get("effective_enabled"))
        except Exception as exc:
            if self._logger is not None:
                try:
                    self._logger.debug("[WsTicket] diagnostics_policy_read_failed err=%s", exc)
                except Exception:
                    pass
            return False

    async def prune_events(self, retention_days: int) -> dict[str, Any]:
        days = max(1, min(30, int(retention_days or DEFAULT_RETENTION_DAYS)))
        try:
            pool = self._pool_supplier()
            async with pool.acquire() as conn:
                has_events = bool(await conn.fetchval("SELECT to_regclass($1)", "public.ws_ticket_events"))
                if not has_events:
                    return {"deleted": 0, "retention_days": days}
                result = await conn.execute(
                    "DELETE FROM ws_ticket_events WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')",
                    days,
                )
                deleted = _parse_deleted_count(result)
                return {"deleted": deleted, "retention_days": days}
        except Exception:
            return {"deleted": 0, "retention_days": days}

    async def _read_policy(self) -> dict[str, Any]:
        try:
            await self._ensure_table()
            pool = self._pool_supplier()
            async with pool.acquire() as conn:
                row = await conn.fetchrow("SELECT value FROM system_config WHERE key = $1", CONFIG_KEY)
            if not row:
                return normalize_ws_ticket_diagnostics_policy({})
            value = row["value"]
            if isinstance(value, str):
                try:
                    value = json.loads(value)
                except Exception:
                    value = {}
            if not isinstance(value, dict):
                value = {}
            return normalize_ws_ticket_diagnostics_policy(value)
        except Exception as exc:
            if self._logger is not None:
                try:
                    self._logger.debug("[WsTicket] diagnostics_policy_load_failed err=%s", exc)
                except Exception:
                    pass
            return normalize_ws_ticket_diagnostics_policy({})

    async def _ensure_table(self) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS system_config (
                    key VARCHAR(100) PRIMARY KEY,
                    value JSONB NOT NULL,
                    description TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            await conn.execute("CREATE INDEX IF NOT EXISTS idx_system_config_key ON system_config(key)")


def normalize_ws_ticket_diagnostics_policy(payload: dict[str, Any] | None, *, now: datetime | None = None) -> dict[str, Any]:
    data = payload if isinstance(payload, dict) else {}
    current = _aware_utc(now)
    enabled = _bool_value(data.get("enabled"), False)
    retention_days = max(1, min(30, _int_value(data.get("retention_days"), DEFAULT_RETENTION_DAYS)))
    auto_close_minutes = max(0, min(24 * 60, _int_value(data.get("auto_close_minutes"), 0)))
    enabled_until_value = str(data.get("enabled_until") or "").strip()

    enabled_until = None
    if enabled and not enabled_until_value and auto_close_minutes <= 0:
        auto_close_minutes = DEFAULT_AUTO_CLOSE_MINUTES
    if enabled and auto_close_minutes > 0:
        enabled_until = current + timedelta(minutes=auto_close_minutes)
    elif enabled and enabled_until_value:
        enabled_until = _parse_datetime(enabled_until_value)

    enabled_until_iso = _iso(enabled_until)
    expired = bool(enabled and (enabled_until is None or enabled_until <= current))
    effective_enabled = bool(enabled and not expired)
    remaining_seconds = 0
    if effective_enabled and enabled_until is not None:
        remaining_seconds = max(0, int((enabled_until - current).total_seconds()))

    return {
        "enabled": enabled,
        "effective_enabled": effective_enabled,
        "expired": expired,
        "enabled_until": enabled_until_iso,
        "remaining_seconds": remaining_seconds,
        "retention_days": retention_days,
        "default_auto_close_minutes": DEFAULT_AUTO_CLOSE_MINUTES,
        "updated_at": current.isoformat(),
    }


def _persisted_policy(policy: dict[str, Any]) -> dict[str, Any]:
    return {
        "enabled": bool(policy.get("enabled")),
        "enabled_until": str(policy.get("enabled_until") or ""),
        "retention_days": max(1, min(30, _int_value(policy.get("retention_days"), DEFAULT_RETENTION_DAYS))),
    }


def _bool_value(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _int_value(value: Any, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _parse_datetime(value: str) -> datetime | None:
    normalized = str(value or "").strip()
    if not normalized:
        return None
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except Exception:
        return None
    return _aware_utc(parsed)


def _aware_utc(value: datetime | None) -> datetime:
    item = value or datetime.now(timezone.utc)
    if item.tzinfo is None:
        return item.replace(tzinfo=timezone.utc)
    return item.astimezone(timezone.utc)


def _iso(value: datetime | None) -> str:
    if value is None:
        return ""
    return _aware_utc(value).replace(microsecond=0).isoformat()


def _parse_deleted_count(result: str) -> int:
    try:
        return int(str(result or "").split()[-1])
    except Exception:
        return 0
