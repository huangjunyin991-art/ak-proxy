from __future__ import annotations

import asyncio
import uuid
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from .parser import build_attempt_record, build_record
from .repository import AKSellLedgerRepository, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS


class AKSellLedgerService:
    MAX_BACKGROUND_TASKS = 2000

    def __init__(self, repository: AKSellLedgerRepository, logger=None) -> None:
        self.repository = repository
        self.logger = logger
        # A request audit must never delay the sell dispatch.  Keep a short
        # per-event task chain so a late "received" write cannot overwrite a
        # terminal response for the same trace.
        self._attempt_tails: dict[str, asyncio.Task] = {}
        self._background_tasks: set[asyncio.Task] = set()

    async def record_success(
        self,
        *,
        account: str,
        endpoint: str,
        request_data: Mapping[str, Any],
        payload: Mapping[str, Any],
        source: str,
        request_id: str = "",
        confirmation_method: str = "upstream_response",
        event_id: str = "",
    ) -> bool:
        record = build_record(
            account=account,
            endpoint=endpoint,
            request_data=request_data,
            payload=payload,
            source=source,
            request_id=request_id,
            confirmation_method=confirmation_method,
        )
        if record is None:
            return False
        record["event_id"] = event_id.strip() or request_id.strip() or f"ak-sell:{uuid.uuid4().hex}"
        try:
            return await self.repository.record(record)
        except Exception as exc:
            if self.logger:
                self.logger.warning("[AKSellLedger] record failed: %s", str(exc)[:300])
            return False

    def enqueue_success(self, **kwargs: Any) -> asyncio.Task:
        """Persist a confirmed sale in the background."""
        async def write() -> bool:
            return await self.record_success(**kwargs)
        task = asyncio.create_task(write(), name="ak_sell_ledger_success")
        self._background_tasks.add(task)
        if self.logger:
            task.add_done_callback(self._log_background_failure)
        task.add_done_callback(self._background_tasks.discard)
        return task

    def _log_background_failure(self, completed: asyncio.Task) -> None:
        if completed.cancelled() or not self.logger:
            return
        try:
            error = completed.exception()
        except Exception:
            error = None
        if error is not None:
            self.logger.warning("[AKSellLedger] queued success failed: %s", str(error)[:300])

    async def record_attempt(
        self,
        *,
        account: str = "",
        endpoint: str = "",
        request_data: Mapping[str, Any] | None = None,
        payload: Mapping[str, Any] | None = None,
        source: str,
        state: str = "",
        message: str = "",
        trace_id: str = "",
        request_id: str = "",
        confirmation_method: str = "",
        status_code: int | None = None,
        exit_name: str = "",
        upstream_ms: int | None = None,
        response_bytes: int | None = None,
        last_stage: str = "",
        diagnostics: Mapping[str, Any] | None = None,
        event_id: str = "",
    ) -> bool:
        event_key = (
            event_id.strip()
            or (f"ak-sell-trace:{trace_id.strip()}" if trace_id.strip() else "")
            or (f"ak-sell-request:{request_id.strip()}" if request_id.strip() else "")
            or f"ak-sell-attempt:{uuid.uuid4().hex}"
        )
        record = build_attempt_record(
            event_id=event_key,
            trace_id=trace_id,
            request_id=request_id,
            account=account,
            endpoint=endpoint,
            request_data=request_data,
            payload=payload,
            source=source,
            state=state,
            message=message,
            confirmation_method=confirmation_method,
            status_code=status_code,
            exit_name=exit_name,
            upstream_ms=upstream_ms,
            response_bytes=response_bytes,
            last_stage=last_stage,
            diagnostics=diagnostics,
        )
        try:
            return await self.repository.record_attempt(record)
        except Exception as exc:
            if self.logger:
                self.logger.warning("[AKSellLedger] attempt record failed: %s", str(exc)[:300])
            return False

    def enqueue_attempt(self, **kwargs: Any) -> asyncio.Task:
        """Queue an attempt write without putting the request path behind PostgreSQL.

        Writes for one event are intentionally serialized.  The repository
        upsert has one aggregate row per event, so preserving producer order
        matters when an early diagnostic write is slower than the final one.
        """
        state = str(kwargs.get("state") or "").strip().lower()
        terminal_states = {"success", "rejected", "unknown", "failed", "auth_expired", "success_unresolved_account"}
        if len(self._background_tasks) >= self.MAX_BACKGROUND_TASKS and state not in terminal_states:
            if self.logger:
                self.logger.warning(
                    "[AKSellLedger] dropping early diagnostic because background queue is full pending=%s",
                    len(self._background_tasks),
                )
            async def dropped() -> bool:
                return False
            return asyncio.create_task(dropped(), name="ak_sell_ledger_attempt_dropped")

        event_key = self._attempt_event_key(kwargs)
        previous = self._attempt_tails.get(event_key)

        async def write_after_previous() -> bool:
            if previous is not None:
                try:
                    await asyncio.shield(previous)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # record_attempt already logs repository failures.  A
                    # previous diagnostic failure must not drop this update.
                    pass
            return await self.record_attempt(**kwargs)

        task = asyncio.create_task(write_after_previous(), name="ak_sell_ledger_attempt")
        self._attempt_tails[event_key] = task
        self._background_tasks.add(task)

        def clear_tail(completed: asyncio.Task) -> None:
            if self._attempt_tails.get(event_key) is completed:
                self._attempt_tails.pop(event_key, None)
            self._background_tasks.discard(completed)
            if completed.cancelled():
                return
            try:
                error = completed.exception()
            except Exception:
                error = None
            if error is not None and self.logger:
                self.logger.warning("[AKSellLedger] queued attempt failed: %s", str(error)[:300])

        task.add_done_callback(clear_tail)
        return task

    async def flush_pending(self, timeout_seconds: float = 3.0) -> int:
        """Best-effort drain used during a graceful server shutdown."""
        pending = tuple(self._background_tasks)
        if not pending:
            return 0
        done, still_pending = await asyncio.wait(
            pending,
            timeout=max(0.0, float(timeout_seconds or 0.0)),
        )
        if still_pending and self.logger:
            self.logger.warning(
                "[AKSellLedger] shutdown drain timed out pending=%s",
                len(still_pending),
            )
        return len(done)

    @staticmethod
    def _attempt_event_key(values: Mapping[str, Any]) -> str:
        event_id = str(values.get("event_id") or "").strip()
        if event_id:
            return event_id
        trace_id = str(values.get("trace_id") or "").strip()
        if trace_id:
            return "ak-sell-trace:" + trace_id
        request_id = str(values.get("request_id") or "").strip()
        if request_id:
            return "ak-sell-request:" + request_id
        return "ak-sell-attempt:" + uuid.uuid4().hex

    async def submit_status(self, request_id: str) -> dict[str, Any]:
        record = await self.repository.get_attempt_by_request_id(request_id)
        if record is None:
            return {"found": False, "state": "not_found", "message": "尚未记录到提交结果"}
        return {
            "found": True,
            "state": str(record.get("state") or "unknown"),
            "message": str(record.get("message") or ""),
            "confirmation_method": str(record.get("confirmation_method") or ""),
            "updated_at": record.get("updated_at").isoformat() if record.get("updated_at") else "",
        }

    async def dashboard(self, account: str = "", source: str = "", page: int = 1, page_size: int = 50) -> dict[str, Any]:
        return {"success": True, **await self.repository.dashboard(account=account, source=source, page=page, page_size=page_size)}

    async def config(self) -> dict[str, Any]:
        return {"success": True, "config": await self.repository.get_config()}

    async def save_config(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        days = int(payload.get("retention_days") or 0)
        if days < MIN_RETENTION_DAYS or days > MAX_RETENTION_DAYS:
            raise ValueError(f"retention_days must be between {MIN_RETENTION_DAYS} and {MAX_RETENTION_DAYS}")
        return {"success": True, "config": await self.repository.save_config(days)}

    async def cleanup(self) -> dict[str, Any]:
        result = await self.repository.cleanup()
        result["success"] = True
        if isinstance(result.get("cutoff"), datetime):
            result["cutoff"] = result["cutoff"].isoformat(sep=" ", timespec="seconds")
        return result
