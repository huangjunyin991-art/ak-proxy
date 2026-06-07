from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any


MonitorReporter = Callable[[dict[str, Any]], Awaitable[None]]
AdminBroadcaster = Callable[[dict[str, Any]], Awaitable[Any]]


@dataclass(frozen=True)
class LoginSideEffect:
    monitor_payload: dict[str, Any]
    admin_message: dict[str, Any]


class LoginSideEffectQueue:
    def __init__(
        self,
        monitor_reporter: MonitorReporter,
        admin_broadcaster: AdminBroadcaster,
        logger=None,
        max_pending: int = 10000,
    ):
        self._monitor_reporter = monitor_reporter
        self._admin_broadcaster = admin_broadcaster
        self._logger = logger
        self._max_pending = max(100, int(max_pending or 10000))
        self._pending: list[LoginSideEffect] = []
        self._event = asyncio.Event()
        self._started = False
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._task = asyncio.create_task(self._run(), name='ak-login-side-effects')

    def schedule(self, monitor_payload: dict[str, Any], admin_message: dict[str, Any]) -> None:
        if len(self._pending) >= self._max_pending:
            self._pending.pop(0)
            if self._logger:
                self._logger.warning('[LoginSideEffects] pending queue full, dropped oldest event')
        self._pending.append(LoginSideEffect(dict(monitor_payload or {}), dict(admin_message or {})))
        self._event.set()

    async def stop(self) -> None:
        if not self._started:
            await self._flush_pending()
            return
        self._started = False
        self._event.set()
        if self._task:
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None

    async def _run(self) -> None:
        while self._started:
            try:
                await self._event.wait()
                self._event.clear()
                await self._flush_pending()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                if self._logger:
                    self._logger.warning('[LoginSideEffects] worker failed: %s', exc)
        await self._flush_pending()

    async def _flush_pending(self) -> None:
        if not self._pending:
            return
        pending = self._pending
        self._pending = []
        for item in pending:
            try:
                await self._monitor_reporter(item.monitor_payload)
            except Exception as exc:
                if self._logger:
                    self._logger.warning('[LoginSideEffects] monitor report failed: %s', exc)
            try:
                await self._admin_broadcaster(item.admin_message)
            except Exception as exc:
                if self._logger:
                    self._logger.warning('[LoginSideEffects] admin broadcast failed: %s', exc)
