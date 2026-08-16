from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class BalanceSnapshot:
    value: int | None
    error: str = ""


class AKSellBalanceConfirmationService:
    """Persists and verifies only write requests whose upstream outcome is unknown."""

    def __init__(
        self,
        repository,
        ledger_service,
        balance_probe: Callable[[Mapping[str, Any]], Awaitable[BalanceSnapshot]],
        logger,
    ) -> None:
        self._repository = repository
        self._ledger_service = ledger_service
        self._balance_probe = balance_probe
        self._logger = logger
        self._task: asyncio.Task | None = None
        self._stopped = asyncio.Event()

    async def enqueue_unknown(
        self,
        *,
        account: str,
        endpoint: str,
        request_data: Mapping[str, Any],
        initial_balance: int | None,
        source: str,
        error: str,
        request_id: str = "",
        trace_id: str = "",
        event_id: str = "",
    ) -> bool:
        normalized_account = str(account or "").strip().lower()
        amount = self._positive_int(request_data.get("count"))
        baseline = self._positive_or_zero_int(initial_balance)
        if not normalized_account or amount is None or baseline is None:
            return False
        attempt_event_id = str(event_id or "").strip() or self._attempt_event_id({
            "trace_id": trace_id,
            "request_id": request_id,
        })
        queued = await self._repository.enqueue_balance_confirmation({
            "task_id": f"ak-sell-confirm:{uuid.uuid4().hex}",
            "event_id": attempt_event_id,
            "trace_id": str(trace_id or "").strip(),
            "request_id": str(request_id or "").strip(),
            "account": normalized_account,
            "endpoint": str(endpoint or "").strip(),
            "sub_account_id": str(request_data.get("sonId") or "").strip(),
            "amount": str(amount),
            "initial_balance": str(baseline),
            "source": str(source or "ak_sell_api"),
            "last_error": str(error or "unknown upstream result"),
        })
        if queued:
            await self._record_attempt(
                account=normalized_account,
                endpoint=endpoint,
                request_data=request_data,
                source=source,
                state="pending_confirmation",
                message=error,
                trace_id=trace_id,
                request_id=request_id,
                event_id=attempt_event_id,
                confirmation_method="balance_delta",
                last_stage="confirmation_enqueued",
                diagnostics={
                    "initial_balance": baseline,
                    "expected_balance": baseline - amount,
                },
            )
        return queued

    async def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._stopped.clear()
        self._task = asyncio.create_task(self._run(), name="ak-sell-balance-confirmation")

    async def stop(self) -> None:
        self._stopped.set()
        task = self._task
        self._task = None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def run_once(self) -> int:
        tasks = await self._repository.claim_due_balance_confirmations(limit=3)
        if tasks:
            await asyncio.gather(*(self._process(task) for task in tasks))
        return len(tasks)

    async def _run(self) -> None:
        while not self._stopped.is_set():
            try:
                await self.run_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._logger.warning("[AKSellLedger] balance confirmation loop failed: %s", str(exc)[:300])
            try:
                await asyncio.wait_for(self._stopped.wait(), timeout=3)
            except TimeoutError:
                continue

    async def _process(self, task: Mapping[str, Any]) -> None:
        task_id = str(task.get("task_id") or "")
        try:
            snapshot = await self._balance_probe(task)
        except Exception as exc:
            snapshot = BalanceSnapshot(value=None, error=f"probe exception: {exc}")
        baseline = self._positive_or_zero_int(task.get("initial_balance"))
        amount = self._positive_int(task.get("amount"))
        expected = baseline - amount if baseline is not None and amount is not None else None
        if snapshot.value is not None and snapshot.value == expected:
            recorded = await self._ledger_service.record_success(
                account=str(task.get("account") or ""),
                endpoint=str(task.get("endpoint") or ""),
                request_data={
                    "sonId": str(task.get("sub_account_id") or ""),
                    "count": str(task.get("amount") or ""),
                },
                payload={
                    "Error": False,
                    "Msg": "余额确认挂卖成功",
                    "Confirmation": {
                        "initial_balance": baseline,
                        "current_balance": snapshot.value,
                        "expected_balance": expected,
                    },
                },
                source=str(task.get("source") or "ak_sell_api"),
                confirmation_method="balance_delta",
                event_id=f"ak-sell-balance:{task_id}",
            )
            if recorded:
                await self._repository.mark_balance_confirmation_confirmed(task_id)
                await self._record_attempt(
                    account=str(task.get("account") or ""),
                    endpoint=str(task.get("endpoint") or ""),
                    request_data={
                        "sonId": str(task.get("sub_account_id") or ""),
                        "count": str(task.get("amount") or ""),
                    },
                    source=str(task.get("source") or "ak_sell_api"),
                    state="success",
                    message="余额确认挂卖成功",
                    trace_id=str(task.get("trace_id") or ""),
                    request_id=str(task.get("request_id") or ""),
                    event_id=self._attempt_event_id(task),
                    confirmation_method="balance_delta",
                    last_stage="confirmation_succeeded",
                    diagnostics={
                        "initial_balance": baseline,
                        "current_balance": snapshot.value,
                        "expected_balance": expected,
                    },
                )
                self._logger.info(
                    "[AKSellLedger] balance confirmation succeeded account=%s endpoint=%s task=%s",
                    str(task.get("account") or ""),
                    str(task.get("endpoint") or ""),
                    task_id,
                )
                return
            await self._repository.retry_balance_confirmation(task_id, "ledger record failed")
            return

        if snapshot.value is None:
            detail = snapshot.error or "balance unavailable"
        else:
            detail = f"balance={snapshot.value}, expected={expected}"
        state = await self._repository.retry_balance_confirmation(task_id, detail)
        await self._record_attempt(
            account=str(task.get("account") or ""),
            endpoint=str(task.get("endpoint") or ""),
            request_data={
                "sonId": str(task.get("sub_account_id") or ""),
                "count": str(task.get("amount") or ""),
            },
            source=str(task.get("source") or "ak_sell_api"),
            state="expired" if state == "expired" else "pending_confirmation",
            message=detail,
            trace_id=str(task.get("trace_id") or ""),
            request_id=str(task.get("request_id") or ""),
            event_id=self._attempt_event_id(task),
            confirmation_method="balance_delta",
            last_stage="confirmation_retry" if state != "expired" else "confirmation_expired",
            diagnostics={
                "initial_balance": baseline,
                "current_balance": snapshot.value,
                "expected_balance": expected,
            },
        )
        if state == "expired":
            self._logger.info(
                "[AKSellLedger] balance confirmation expired account=%s endpoint=%s task=%s detail=%s",
                str(task.get("account") or ""),
                str(task.get("endpoint") or ""),
                task_id,
                detail,
            )

    @staticmethod
    def _positive_int(value: Any) -> int | None:
        try:
            number = int(str(value or "").strip())
        except (TypeError, ValueError):
            return None
        return number if number > 0 else None

    @staticmethod
    def _positive_or_zero_int(value: Any) -> int | None:
        try:
            number = int(str(value).strip())
        except (TypeError, ValueError):
            return None
        return number if number >= 0 else None

    async def _record_attempt(self, **payload: Any) -> None:
        recorder = getattr(self._ledger_service, "record_attempt", None)
        if not callable(recorder):
            return
        try:
            await recorder(**payload)
        except Exception as exc:
            self._logger.warning("[AKSellLedger] attempt confirmation update failed: %s", str(exc)[:300])

    @staticmethod
    def _attempt_event_id(task: Mapping[str, Any]) -> str:
        explicit = str(task.get("event_id") or "").strip()
        if explicit:
            return explicit
        trace_id = str(task.get("trace_id") or "").strip()
        if trace_id:
            return f"ak-sell-trace:{trace_id}"
        request_id = str(task.get("request_id") or "").strip()
        if request_id:
            return f"ak-sell-request:{request_id}"
        task_id = str(task.get("task_id") or "").strip()
        return f"ak-sell-confirm:{task_id or uuid.uuid4().hex}"
