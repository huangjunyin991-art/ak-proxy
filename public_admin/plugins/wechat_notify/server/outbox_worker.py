from __future__ import annotations

import asyncio
import logging

from .service import WechatNotifyService


class WechatNotifyOutboxWorker:
    def __init__(self, *, service: WechatNotifyService, logger: logging.Logger | None = None):
        self._service = service
        self._logger = logger or logging.getLogger('WechatNotify')
        self._task: asyncio.Task | None = None
        self._stopped = asyncio.Event()

    async def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stopped.clear()
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stopped.set()
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        finally:
            self._task = None

    async def _run(self) -> None:
        interval = max(2, int(self._service.config.worker_interval_seconds or 10))
        while not self._stopped.is_set():
            try:
                result = await self._service.flush_outbox_once()
                if result.get('claimed'):
                    self._logger.info('[WechatNotify] outbox claimed=%s sent=%s failed=%s', result.get('claimed'), result.get('sent'), result.get('failed'))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._logger.warning('[WechatNotify] outbox worker failed: %s', exc)
            try:
                await asyncio.wait_for(self._stopped.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass
