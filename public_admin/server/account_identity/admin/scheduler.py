from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

from .service import compute_auto_run_window, compute_next_auto_run_at


class AccountIdentitySyncScheduler:
    def __init__(
        self,
        service,
        logger=None,
        poll_seconds: float = 30.0,
        auto_trigger_grace_seconds: float = 300.0,
        now_provider=None,
    ):
        self._service = service
        self._logger = logger
        self._poll_seconds = max(5.0, float(poll_seconds or 30.0))
        base_grace_seconds = max(60.0, float(auto_trigger_grace_seconds or 300.0))
        self._auto_trigger_grace_seconds = base_grace_seconds + min(self._poll_seconds, 60.0)
        self._now_provider = now_provider or datetime.now
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
        now = self._now_provider()
        await self._refresh_persisted_auto_run_state(now)
        next_run_at = compute_next_auto_run_at(policy, now=now)
        if next_run_at is None:
            return
        window = compute_auto_run_window(
            policy,
            now=now,
            grace_seconds=self._auto_trigger_grace_seconds,
        )
        if window is None:
            return
        target_today, trigger_deadline = window
        today_key = now.strftime("%Y-%m-%d")
        if now < target_today or now > trigger_deadline or self._last_auto_run_day == today_key:
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

    async def _refresh_persisted_auto_run_state(self, now: datetime) -> None:
        today_key = now.strftime("%Y-%m-%d")
        if self._last_auto_run_day == today_key and self._last_auto_trigger_at is not None:
            return
        if not hasattr(self._service, "get_latest_auto_sync_run_for_day"):
            return
        latest_run = await self._service.get_latest_auto_sync_run_for_day(now=now)
        if not isinstance(latest_run, dict):
            return
        started_at = latest_run.get("started_at")
        if not isinstance(started_at, datetime):
            return
        if started_at.strftime("%Y-%m-%d") != today_key:
            return
        self._last_auto_trigger_at = started_at
        self._last_auto_run_day = today_key


def _serialize_time(value: Any) -> str:
    if not value:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat(sep=" ", timespec="seconds")
    return str(value)
