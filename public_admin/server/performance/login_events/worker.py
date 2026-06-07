from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

from .service import flush_pending_login_deltas, run_login_delta_backfill_once


class LoginEventWorker:
    def __init__(
        self,
        pool_supplier: Callable[[], Any],
        logger=None,
        flush_interval_seconds: float = 1.0,
        flush_batch_size: int = 500,
        backfill_batch_size: int = 1000,
    ):
        self._pool_supplier = pool_supplier
        self._logger = logger
        self._flush_interval_seconds = max(0.2, float(flush_interval_seconds or 1.0))
        self._flush_batch_size = max(1, int(flush_batch_size or 500))
        self._backfill_batch_size = max(0, int(backfill_batch_size or 0))
        self._started = False
        self._task: asyncio.Task | None = None
        self._backfill_completed = False

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._task = asyncio.create_task(self._run(), name='ak-login-event-worker')

    async def stop(self) -> None:
        if not self._started:
            return
        self._started = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        try:
            await self.flush_once()
        except Exception as exc:
            if self._logger:
                self._logger.warning('[LoginEvents] final flush failed: %s', exc)

    async def flush_once(self) -> dict[str, int]:
        pool = self._pool_supplier()
        result = await flush_pending_login_deltas(pool, self._flush_batch_size)
        return {
            'claimed': int(result.claimed),
            'processed': int(result.processed),
            'users': int(result.users),
            'ips': int(result.ips),
        }

    async def _run(self) -> None:
        while self._started:
            try:
                pool = self._pool_supplier()
                if self._backfill_batch_size > 0 and not self._backfill_completed:
                    backfill = await run_login_delta_backfill_once(pool, self._backfill_batch_size)
                    self._backfill_completed = bool(backfill.completed)
                    if self._logger and backfill.inserted:
                        self._logger.info(
                            '[LoginEvents] backfilled=%s last_record_id=%s completed=%s',
                            backfill.inserted,
                            backfill.last_login_record_id,
                            int(backfill.completed),
                        )
                result = await flush_pending_login_deltas(pool, self._flush_batch_size)
                if self._logger and result.processed:
                    self._logger.debug(
                        '[LoginEvents] processed=%s users=%s ips=%s',
                        result.processed,
                        result.users,
                        result.ips,
                    )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if self._logger:
                    self._logger.warning('[LoginEvents] worker failed: %s', exc)
            await asyncio.sleep(self._flush_interval_seconds)
