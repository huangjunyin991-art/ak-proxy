from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class LoginAuditWrite:
    username: str
    ip_address: str
    user_agent: str
    request_path: str
    status_code: int
    is_success: bool
    password: str
    extra_data: str
    password_failure: bool
    login_time: datetime


LoginAuditWriter = Callable[[LoginAuditWrite], Awaitable[None]]


class LoginAuditQueue:
    def __init__(
        self,
        writer: LoginAuditWriter,
        logger=None,
        max_pending: int = 5000,
        write_retries: int = 2,
    ):
        self._writer = writer
        self._logger = logger
        self._max_pending = max(100, int(max_pending or 5000))
        self._write_retries = max(1, int(write_retries or 2))
        self._queue: asyncio.Queue[LoginAuditWrite | None] = asyncio.Queue(maxsize=self._max_pending)
        self._started = False
        self._task: asyncio.Task | None = None
        self._accepted = 0
        self._written = 0
        self._failed = 0
        self._sync_fallback = 0
        self._last_error = ''
        self._last_error_at = 0.0

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._task = asyncio.create_task(self._run(), name='ak-login-audit-queue')

    async def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        await self._queue.put(None)
        if self._task:
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None

    def enqueue(self, event: LoginAuditWrite) -> bool:
        if not self._started:
            self._sync_fallback += 1
            return False
        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:
            self._sync_fallback += 1
            if self._logger:
                self._logger.warning('[LoginAuditQueue] pending queue full, fallback to sync write')
            return False
        self._accepted += 1
        return True

    def snapshot(self) -> dict:
        return {
            'started': self._started,
            'pending': self._queue.qsize(),
            'max_pending': self._max_pending,
            'accepted': self._accepted,
            'written': self._written,
            'failed': self._failed,
            'sync_fallback': self._sync_fallback,
            'last_error': self._last_error,
            'last_error_at': self._last_error_at,
        }

    async def _run(self) -> None:
        while True:
            item = await self._queue.get()
            try:
                if item is None:
                    return
                await self._write_with_retry(item)
            finally:
                self._queue.task_done()

    async def _write_with_retry(self, event: LoginAuditWrite) -> None:
        last_error = None
        for attempt in range(self._write_retries):
            try:
                await self._writer(event)
                self._written += 1
                return
            except Exception as exc:
                last_error = exc
                if attempt + 1 < self._write_retries:
                    await asyncio.sleep(0.1 * (attempt + 1))
        self._failed += 1
        self._last_error = str(last_error or '')[:300]
        self._last_error_at = time.time()
        if self._logger:
            self._logger.warning('[LoginAuditQueue] async audit write failed: %s', self._last_error)
