from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

from .service import compute_next_auto_run_at


class AccountIdentitySyncScheduler:
    def __init__(self, service, logger=None, poll_seconds: float = 30.0):
        self._service = service
        self._logger = logger
        self._poll_seconds = max(5.0, float(poll_seconds or 30.0))
        self._task: asyncio.Task | None = None
        self._last_tick_at: datetime | None = None
        self._last_auto_trigger_at: datetime | None = None
        self._last_auto_run_day = ""
        if hasattr(service, "attach_scheduler"):
            service.attach_scheduler(self)

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._run_loop(), name="account-identity-sync-scheduler")

    async def stop(self) -> None:
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    def snapshot(self) -> dict[str, Any]:
        try:
            current_run = self._service.get_current_run_snapshot()
        except Exception:
            current_run = None
        return {
            "running": bool(self._task is not None and not self._task.done()),
            "last_tick_at": _serialize_time(self._last_tick_at),
            "last_auto_trigger_at": _serialize_time(self._last_auto_trigger_at),
            "last_auto_run_day": self._last_auto_run_day,
            "current_run": current_run,
        }

    async def _run_loop(self) -> None:
        while True:
            await asyncio.sleep(self._poll_seconds)
            self._last_tick_at = datetime.now()
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if self._logger is not None:
                    self._logger.warning(f"[AccountIdentitySyncScheduler] tick failed: {exc}")

    async def _tick(self) -> None:
        policy = await self._service.get_policy()
        if not policy.get("enabled"):
            return
        now = datetime.now()
        next_run_at = compute_next_auto_run_at(policy, now=now)
        if next_run_at is None:
            return
        target_hour = int(str(policy.get("daily_time") or "00:00").split(":", 1)[0])
        target_minute = int(str(policy.get("daily_time") or "00:00").split(":", 1)[1])
        target_today = now.replace(hour=target_hour, minute=target_minute, second=0, microsecond=0)
        today_key = now.strftime("%Y-%m-%d")
        if now < target_today or self._last_auto_run_day == today_key:
            return
        result = await self._service.start_sync(
            triggered_by="system:auto",
            trigger_mode="auto",
            phase_key="",
            dry_run=False,
            limit_per_spec=int(policy.get("limit_per_spec") or 0),
        )
        if result.get("started"):
            self._last_auto_trigger_at = now
            self._last_auto_run_day = today_key
            if self._logger is not None:
                self._logger.info(
                    "[AccountIdentitySyncScheduler] auto sync started daily_time=%s",
                    policy.get("daily_time"),
                )


def _serialize_time(value: Any) -> str:
    if not value:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat(sep=" ", timespec="seconds")
    return str(value)
