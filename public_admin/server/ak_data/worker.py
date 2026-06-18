from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import asdict, dataclass
from datetime import date, datetime
from typing import Any

from .config import AkDataConfig, normalize_config
from .day_buffer import AkTradeDayBatch, AkTradeDayBuffer
from .repository import AkDataRepository
from .upstream import AkUpstreamClient


@dataclass
class AkBackfillState:
    status: str = "idle"
    message: str = "历史回填未启动"
    mode: str = ""
    started_at: float = 0
    finished_at: float = 0
    current_trade_id: int = 0
    start_trade_id: int = 0
    target_date: str = ""
    processed: int = 0
    saved: int = 0
    buyer_rows: int = 0
    failed: int = 0
    forbidden: int = 0
    missing: int = 0
    last_error: str = ""
    stop_reason: str = ""
    cooldown_until: float = 0
    current_account: str = ""
    request_interval_ms: int = 1000
    retry_rounds: int = 10
    retry_round: int = 0
    pending_count: int = 0
    current_day: str = ""
    day_buffer_count: int = 0
    committed_days: int = 0
    pipeline_concurrency: int = 2
    account_switch_count: int = 0
    stop_requested: bool = False

    def snapshot(self) -> dict[str, Any]:
        data = asdict(self)
        data["running"] = self.status == "running"
        return data


class AkDataWorker:
    def __init__(self, repository: AkDataRepository):
        self.repository = repository
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self._state = AkBackfillState()

    def snapshot(self) -> dict[str, Any]:
        if self._state.status == "cooldown" and self._state.cooldown_until:
            remaining = int(max(0, self._state.cooldown_until - time.time()))
            if remaining <= 0:
                self._state.status = "idle"
                self._state.message = "冷却已结束，可重新开始任务"
                self._state.cooldown_until = 0
                self._state.stop_reason = "cooldown_finished"
            else:
                data = self._state.snapshot()
                data["cooldown_remaining_seconds"] = remaining
                return data
        return self._state.snapshot()

    async def start_backfill(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        async with self._lock:
            if self._task and not self._task.done():
                return self.snapshot()
            payload = dict(payload or {})
            config = normalize_config(await self.repository.load_config())
            start_trade_id = self._int(payload.get("start_trade_id"), 0)
            if start_trade_id <= 0:
                start_trade_id = await self.repository.get_latest_trade_id()
            if start_trade_id <= 0:
                return self._set_error("缺少起始订单 ID，且数据库没有可推断的最大订单 ID")
            target_date = self._date_text(payload.get("target_date"), config.default_target_date)
            interval = self._int(payload.get("request_interval_ms"), config.request_interval_ms)
            self._state = AkBackfillState(
                status="running",
                message="历史回填已启动",
                mode="backfill",
                started_at=time.time(),
                current_trade_id=start_trade_id,
                start_trade_id=start_trade_id,
                target_date=target_date,
                request_interval_ms=max(300, min(interval, 10000)),
                retry_rounds=max(1, int(config.retry_rounds)),
                pipeline_concurrency=max(1, int(config.pipeline_concurrency)),
            )
            await self.repository.update_runtime(
                running=True,
                direction="backward",
                current_trade_id=start_trade_id,
                target_trade_id=None,
                status="running",
                last_error="",
                current_account_username="",
                account_switch_count=0,
                started_at=datetime.now(),
                finished_at=None,
            )
            self._task = asyncio.create_task(self._run_backfill(config), name="ak-data-backfill")
            return self.snapshot()

    async def start_probe(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        async with self._lock:
            if self._task and not self._task.done():
                return self.snapshot()
            payload = dict(payload or {})
            config = normalize_config(await self.repository.load_config())
            start_trade_id = self._int(payload.get("start_trade_id"), 0)
            if start_trade_id <= 0:
                start_trade_id = await self.repository.get_latest_trade_id()
            if start_trade_id <= 0:
                return self._set_error("缺少探测起始订单 ID")
            limit = max(1, min(self._int(payload.get("limit"), 300), 1000))
            interval = max(300, min(self._int(payload.get("request_interval_ms"), config.request_interval_ms), 10000))
            key = str(payload.get("key") or "").strip()
            user_id = str(payload.get("user_id") or payload.get("UserID") or "").strip()
            self._state = AkBackfillState(
                status="running",
                message=f"限流探测已启动：{limit} 笔",
                mode="probe",
                started_at=time.time(),
                current_trade_id=start_trade_id,
                start_trade_id=start_trade_id,
                request_interval_ms=interval,
                retry_rounds=max(1, int(config.retry_rounds)),
                pipeline_concurrency=max(1, int(config.pipeline_concurrency)),
            )
            self._task = asyncio.create_task(
                self._run_probe(config, start_trade_id, limit, interval, key, user_id, stop_on_403=True),
                name="ak-data-probe",
            )
            return self.snapshot()

    async def pause(self) -> dict[str, Any]:
        self._state.stop_requested = True
        self._state.message = "正在停止任务..."
        return self.snapshot()

    async def cleanup(self) -> dict[str, Any]:
        config = normalize_config(await self.repository.load_config())
        result = await self.repository.delete_old_data(config.summary_retention_days, config.buyer_retention_days)
        return {"success": True, **result}

    async def _run_probe(self, config: AkDataConfig, start_trade_id: int, limit: int, interval: int,
                         key: str, user_id: str, stop_on_403: bool = False) -> None:
        try:
            account = await self._resolve_account(config, key=key, user_id=user_id)
            client = self._client(config)
            rounds = max(1, int(config.retry_rounds))
            candidate_ids = [start_trade_id - offset for offset in range(limit)]
            for round_index in range(1, rounds + 1):
                if self._state.stop_requested:
                    self._finish("paused", "探测已停止")
                    return
                self._state.retry_round = round_index
                self._state.pending_count = len(candidate_ids)
                batch = await self._run_pipeline_round(
                    client,
                    account,
                    config,
                    candidate_ids,
                    persist=False,
                    interval_ms=interval,
                    stop_on_403=stop_on_403,
                )
                if batch.get("paused"):
                    self._finish("paused", "探测已停止")
                    return
                if batch.get("forbidden"):
                    self._finish("finished", f"探测命中 403，已停止：{self._state.processed} 笔")
                    return
                failed_ids = [int(item.get("trade_id") or 0) for item in batch.get("failed") or [] if int(item.get("trade_id") or 0) > 0]
                if not failed_ids:
                    self._finish("finished", f"探测完成：{self._state.processed} 笔，403 {self._state.forbidden} 次")
                    return
                candidate_ids = failed_ids
                self._state.message = f"探测第 {round_index} 轮结束，待重试 {len(candidate_ids)} 笔"
            self._finish("finished", f"探测结束：仍有 {len(candidate_ids)} 笔未成功，403 {self._state.forbidden} 次")
        except Exception as exc:
            self._finish("error", f"探测失败：{exc}", str(exc))

    async def _run_backfill(self, config: AkDataConfig) -> None:
        try:
            if not config.enabled:
                self._finish("error", "AK 数据采集未启用", "disabled")
                return
            accounts = await self._resolve_account_candidates(config)
            account_index = 0
            account = accounts[account_index]
            await self.repository.update_runtime(
                current_account_username=account.get("username") or "",
                account_switch_count=0,
                status="running",
            )
            client = self._client(config)
            target_day = date.fromisoformat(self._state.target_date)
            current = int(self._state.current_trade_id or 0)
            if current <= 0:
                self._finish("error", "缺少起始订单 ID", "missing_start_trade_id")
                return
            buffer = AkTradeDayBuffer()
            rounds = max(1, int(config.retry_rounds))
            while current > 0:
                if self._state.stop_requested:
                    self._finish("paused", "历史回填已暂停，未跨日的当日缓存未提交")
                    return
                self._state.current_trade_id = current
                self._state.current_day = buffer.date_key.isoformat() if buffer.date_key else ""
                self._state.day_buffer_count = buffer.count
                result = await self._fetch_full_trade_with_retries(client, account, config, current, rounds)
                if result.get("paused"):
                    self._finish("paused", "历史回填已暂停，未跨日的当日缓存未提交")
                    return
                if result.get("forbidden"):
                    self._apply_fetch_result(result)
                    if account_index + 1 < len(accounts):
                        failed_account = account.get("username") or "-"
                        account_index += 1
                        account = accounts[account_index]
                        self._state.account_switch_count += 1
                        self._state.current_account = account.get("username") or ""
                        self._state.message = (
                            f"账号 {failed_account} 返回 403，已切换到 {self._state.current_account or '-'} "
                            f"重试订单 {current}"
                        )
                        await self.repository.update_runtime(
                            current_trade_id=current,
                            current_account_username=self._state.current_account,
                            account_switch_count=self._state.account_switch_count,
                            status="running",
                            last_error=str(result.get("error") or "")[:500],
                        )
                        await self._sleep_interval(self._state.request_interval_ms)
                        continue
                    await self._cooldown(config, current, result)
                    return
                if not result.get("ok"):
                    await self.repository.mark_trade_placeholder(current, status="pending", error=str(result.get("error") or "fetch failed"))
                    await self.repository.update_runtime(
                        current_trade_id=current,
                        status="running",
                        last_error=str(result.get("error") or "")[:500],
                    )
                    self._apply_fetch_result(result)
                    self._state.message = f"订单 {current} 未完整获取，已记录待补，继续向前回填"
                    current -= 1
                    await self._sleep_interval(self._state.request_interval_ms)
                    continue
                closed = buffer.add(result)
                self._state.processed += 1
                self._state.current_day = buffer.date_key.isoformat() if buffer.date_key else ""
                self._state.day_buffer_count = buffer.count
                self._state.message = f"采集中：{self._state.current_day or '-'} 已缓存 {self._state.day_buffer_count} 笔"
                if closed:
                    committed = await self._commit_day_batch(config, closed)
                    self._state.message = f"已提交 {closed.date_key.isoformat()}：{committed['orders']} 笔，买家明细 {committed['buyers']} 条"
                    if closed.date_key <= target_day:
                        self._finish("finished", f"已完整回填到目标日期 {self._state.target_date}")
                        return
                current -= 1
                await self._sleep_interval(self._state.request_interval_ms)
            self._finish("finished", "历史回填完成，最后一天未跨日确认所以未提交")
        except Exception as exc:
            self._finish("error", f"历史回填失败：{exc}", str(exc))

    async def _fetch_full_trade_with_retries(self, client: AkUpstreamClient, account: dict[str, str],
                                             config: AkDataConfig, trade_id: int, rounds: int) -> dict[str, Any]:
        last_result: dict[str, Any] = {"ok": False, "trade_id": trade_id, "error": "not fetched"}
        for attempt in range(1, max(1, int(rounds or 1)) + 1):
            if self._state.stop_requested:
                return {"paused": True, "trade_id": trade_id}
            self._state.retry_round = attempt
            self._state.message = f"正在获取订单 {trade_id}，第 {attempt}/{rounds} 轮"
            result = await self._fetch_full_trade(client, account, config, trade_id)
            if result.get("ok") or result.get("forbidden"):
                return result
            last_result = result
            self._state.last_error = str(result.get("error") or "")[:500]
            if attempt < rounds:
                await self._sleep_interval(self._state.request_interval_ms)
        return last_result

    async def _fetch_full_trade(self, client: AkUpstreamClient, account: dict[str, str],
                                config: AkDataConfig, trade_id: int) -> dict[str, Any]:
        detail = await self._fetch_detail(client, account, trade_id)
        if not detail.get("ok"):
            return detail
        buyers: list[dict[str, Any]] = []
        if config.save_buyers and detail.get("seller_user_id"):
            buyer_result = await self._fetch_buyers(client, account, config, detail)
            if not buyer_result.get("ok"):
                return buyer_result
            buyers = buyer_result.get("buyers") or []
        detail["buyers"] = buyers
        return detail

    async def _commit_day_batch(self, config: AkDataConfig, batch: AkTradeDayBatch) -> dict[str, int]:
        if not batch.is_contiguous:
            ids = batch.trade_ids
            raise RuntimeError(
                f"AK 日批次订单 ID 不连续: day={batch.date_key} max={ids[0] if ids else 0} "
                f"min={ids[-1] if ids else 0} count={len(ids)}"
            )
        result = await self.repository.commit_trade_day_batch(batch.date_key, batch.items, save_buyers=config.save_buyers)
        self._state.saved += int(result.get("orders") or 0)
        self._state.buyer_rows += int(result.get("buyers") or 0)
        self._state.committed_days += 1
        self._state.day_buffer_count = 0
        return result

    async def _sleep_interval(self, interval_ms: int) -> None:
        await asyncio.sleep(max(0.1, float(interval_ms or 1000) / 1000.0))

    async def _run_pipeline_round(self, client: AkUpstreamClient, account: dict[str, str],
                                  config: AkDataConfig, trade_ids: list[int], persist: bool,
                                  interval_ms: int, stop_on_403: bool) -> dict[str, Any]:
        queue = deque(int(tid) for tid in trade_ids if int(tid or 0) > 0)

        def next_trade_id() -> int | None:
            return queue.popleft() if queue else None

        return await self._run_pipeline_source(
            client,
            account,
            config,
            next_trade_id,
            persist=persist,
            interval_ms=interval_ms,
            stop_on_403=stop_on_403,
        )

    async def _run_pipeline_source(self, client: AkUpstreamClient, account: dict[str, str],
                                   config: AkDataConfig, next_trade_id,
                                   persist: bool, interval_ms: int, stop_on_403: bool,
                                   on_success=None) -> dict[str, Any]:
        in_flight: dict[asyncio.Task, dict[str, Any]] = {}
        failed: list[dict[str, Any]] = []
        concurrency = max(1, min(int(config.pipeline_concurrency or 2), 5))
        interval = max(0.1, float(interval_ms or 1000) / 1000.0)
        last_detail_started = 0.0
        source_done = False

        while in_flight or not source_done:
            if self._state.stop_requested:
                return {"paused": True, "failed": failed}

            now = time.monotonic()
            if not source_done and len(in_flight) < concurrency and (now - last_detail_started >= interval or last_detail_started == 0):
                trade_id = next_trade_id()
                if trade_id is None:
                    source_done = True
                else:
                    self._state.current_trade_id = int(trade_id)
                    task = asyncio.create_task(self._fetch_detail(client, account, int(trade_id)))
                    in_flight[task] = {"stage": "detail", "trade_id": int(trade_id)}
                    last_detail_started = now
                    continue

            if not in_flight:
                await asyncio.sleep(0.05)
                continue

            done, _pending = await asyncio.wait(in_flight.keys(), timeout=0.1, return_when=asyncio.FIRST_COMPLETED)
            if not done:
                continue

            for task in done:
                meta = in_flight.pop(task)
                try:
                    result = task.result()
                except Exception as exc:
                    result = {
                        "ok": False,
                        "trade_id": int(meta.get("trade_id") or 0),
                        "stage": str(meta.get("stage") or ""),
                        "error": str(exc)[:500],
                    }
                trade_id = int(result.get("trade_id") or meta.get("trade_id") or 0)
                self._state.current_trade_id = trade_id
                if result.get("forbidden"):
                    if meta.get("stage") == "detail":
                        self._apply_fetch_result(result)
                    else:
                        self._apply_buyers_result(result)
                    failed.append(result)
                    if stop_on_403:
                        return {"forbidden": True, "failed": failed}
                    continue
                if meta.get("stage") == "detail":
                    if not result.get("ok"):
                        self._apply_fetch_result(result)
                        failed.append(result)
                        continue
                    partial = await self._persist_trade_detail(config, result, persist, complete=not config.save_buyers)
                    self._apply_fetch_result(partial)
                    if on_success:
                        await on_success(partial)
                    if not config.save_buyers:
                        continue
                    if config.save_buyers and result.get("seller_user_id"):
                        task = asyncio.create_task(self._fetch_buyers(client, account, config, result))
                        in_flight[task] = {"stage": "buyers", "trade_id": trade_id, "detail": result}
                    else:
                        final = await self._persist_trade_buyers(config, result, [], persist)
                        self._apply_buyers_result(final)
                else:
                    detail = meta.get("detail") or {}
                    if not result.get("ok"):
                        self._apply_buyers_result(result)
                        failed.append(result)
                        continue
                    final = await self._persist_trade_buyers(config, detail, result.get("buyers") or [], persist)
                    self._apply_buyers_result(final)
        return {"failed": failed}

    async def _fetch_detail(self, client: AkUpstreamClient, account: dict[str, str], trade_id: int) -> dict[str, Any]:
        key = account.get("key") or ""
        user_id = account.get("user_id") or ""
        detail_status, detail_payload = await client.detail(trade_id, key, user_id)
        if detail_status == 403:
            return {"ok": False, "forbidden": True, "trade_id": trade_id, "stage": "detail", "error": f"detail status={detail_status}"}
        if detail_status >= 400 or detail_status == 0:
            return {"ok": False, "trade_id": trade_id, "stage": "detail", "error": f"detail status={detail_status}: {self._payload_message(detail_payload)}"}
        detail = detail_payload.get("Data") if isinstance(detail_payload, dict) else None
        if not isinstance(detail, dict) or detail_payload.get("Error") is True:
            return {"ok": False, "missing": True, "trade_id": trade_id, "stage": "detail", "error": self._payload_message(detail_payload) or "detail empty"}
        user = detail.get("User") if isinstance(detail.get("User"), dict) else {}
        trade_time = self._parse_datetime(detail.get("CreateTime"))
        return {
            "ok": True,
            "trade_id": int(detail.get("Id") or trade_id),
            "stage": "detail",
            "detail": detail,
            "seller_flow": str(user.get("FlowNumber") or "").strip(),
            "seller_user_id": str(user.get("Id") or user.get("ID") or "").strip(),
            "date": trade_time.date() if trade_time else None,
        }

    async def _fetch_buyers(self, client: AkUpstreamClient, account: dict[str, str],
                            config: AkDataConfig, detail_result: dict[str, Any]) -> dict[str, Any]:
        trade_id = int(detail_result.get("trade_id") or 0)
        seller_user_id = str(detail_result.get("seller_user_id") or "").strip()
        key = account.get("key") or ""
        user_id = account.get("user_id") or ""
        buyers_status, buyers_payload = await client.buyers(
            trade_id,
            seller_user_id,
            key,
            user_id,
            page=1,
            page_size=config.buyer_page_size,
        )
        if buyers_status == 403:
            return {"ok": False, "forbidden": True, "trade_id": trade_id, "stage": "buyers", "error": f"buyers status={buyers_status}"}
        if buyers_status >= 400 or buyers_status == 0:
            return {"ok": False, "trade_id": trade_id, "stage": "buyers", "error": f"buyers status={buyers_status}: {self._payload_message(buyers_payload)}"}
        return {
            "ok": True,
            "trade_id": trade_id,
            "stage": "buyers",
            "buyers": self._normalize_buyers(buyers_payload),
        }

    async def _persist_trade_detail(self, config: AkDataConfig, detail_result: dict[str, Any],
                                    persist: bool, complete: bool = False) -> dict[str, Any]:
        trade_id = int(detail_result.get("trade_id") or 0)
        trade_time = None
        detail = detail_result.get("detail") if isinstance(detail_result.get("detail"), dict) else {}
        if detail:
            trade_time = self._parse_datetime(detail.get("CreateTime"))
        if persist and detail:
            await self.repository.upsert_trade_summary(
                detail,
                str(detail_result.get("seller_flow") or ""),
                complete=complete,
            )
            if trade_time:
                await self.repository.refresh_daily_summary(trade_time.date())
            await self.repository.update_runtime(
                current_trade_id=trade_id,
                last_saved_trade_id=trade_id,
                last_seen_create_time=trade_time,
                status="running",
            )
        return {
            "ok": True,
            "trade_id": trade_id,
            "buyers": 0,
            "date": trade_time.date() if trade_time else detail_result.get("date"),
        }

    async def _persist_trade_buyers(self, config: AkDataConfig, detail_result: dict[str, Any],
                                    buyers: list[dict[str, Any]], persist: bool) -> dict[str, Any]:
        trade_id = int(detail_result.get("trade_id") or 0)
        if persist and trade_id > 0:
            if config.save_buyers:
                await self.repository.replace_trade_buyers(trade_id, buyers)
            await self.repository.mark_trade_complete(trade_id)
        return {
            "ok": True,
            "trade_id": trade_id,
            "buyers": len(buyers),
            "date": detail_result.get("date"),
        }

    async def _cooldown(self, config: AkDataConfig, trade_id: int, result: dict[str, Any]) -> None:
        await self.repository.mark_trade_placeholder(
            int(trade_id),
            status="pending",
            error=str(result.get("error") or "403"),
        )
        cooldown = max(0, int(config.forbidden_cooldown_seconds))
        until = time.time() + cooldown if cooldown > 0 else 0
        await self.repository.update_runtime(
            running=False,
            status="cooldown",
            last_error=self._state.last_error or "upstream forbidden",
            last_check_skip_reason="403 cooldown",
            next_check_at=datetime.fromtimestamp(until) if until else None,
            last_check_skipped_at=datetime.now(),
        )
        self._state.cooldown_until = until
        self._finish("cooldown", f"遇到 403，进入冷却 {cooldown} 秒")

    async def _resolve_account(self, config: AkDataConfig, key: str = "", user_id: str = "") -> dict[str, str]:
        accounts = await self._resolve_account_candidates(config, key=key, user_id=user_id)
        return accounts[0]

    async def _resolve_account_candidates(self, config: AkDataConfig, key: str = "", user_id: str = "") -> list[dict[str, str]]:
        if key and user_id:
            account = {"username": "manual", "key": key, "user_id": user_id}
            self._state.current_account = account["username"]
            return [account]
        accounts = await self.repository.list_accounts(limit=200)
        fallback = config.fallback_username
        normal: list[dict[str, Any]] = []
        fallback_item = None
        seen: set[str] = set()
        for item in accounts:
            username = str(item.get("username") or "").strip().lower()
            if not username or username in seen:
                continue
            if not item.get("userkey") or not item.get("user_id"):
                continue
            seen.add(username)
            if fallback and username == fallback:
                fallback_item = item
            else:
                normal.append(item)

        max_attempts = max(1, int(config.max_account_switches or 0) + 1)
        selected_items = normal[:max_attempts]
        if fallback_item and all(item.get("username") != fallback for item in selected_items):
            if len(selected_items) < max_attempts:
                selected_items.append(fallback_item)
            elif max_attempts > 1:
                selected_items[-1] = fallback_item
            elif not selected_items:
                selected_items.append(fallback_item)
        if not selected_items:
            raise RuntimeError("没有可用 AK 登录态，请先让账号登录一次或配置兜底账号")
        candidates = [self._account_from_row(item) for item in selected_items]
        self._state.current_account = candidates[0].get("username") or ""
        return candidates

    @staticmethod
    def _account_from_row(row: dict[str, Any]) -> dict[str, str]:
        return {
            "username": str(row.get("username") or ""),
            "key": str(row.get("userkey") or ""),
            "user_id": str(row.get("user_id") or ""),
        }

    @staticmethod
    def _client(config: AkDataConfig) -> AkUpstreamClient:
        return AkUpstreamClient(
            timeout_seconds=config.upstream_timeout_seconds,
            retry_attempts=config.upstream_retry_attempts,
            retry_backoff_ms=config.upstream_retry_backoff_ms,
        )

    async def _fetch_one(self, client: AkUpstreamClient, account: dict[str, str], trade_id: int,
                         config: AkDataConfig, persist: bool) -> dict[str, Any]:
        key = account.get("key") or ""
        user_id = account.get("user_id") or ""
        detail_status, detail_payload = await client.detail(trade_id, key, user_id)
        if detail_status == 403:
            return {"ok": False, "forbidden": True, "error": f"detail status={detail_status}"}
        if detail_status >= 400:
            return {"ok": False, "error": f"detail status={detail_status}"}
        detail = detail_payload.get("Data") if isinstance(detail_payload, dict) else None
        if not isinstance(detail, dict) or detail_payload.get("Error") is True:
            return {"ok": False, "missing": True, "error": str((detail_payload or {}).get("Msg") or "detail empty")[:200]}
        user = detail.get("User") if isinstance(detail.get("User"), dict) else {}
        seller_flow = str(user.get("FlowNumber") or "").strip()
        seller_user_id = str(user.get("Id") or user.get("ID") or "").strip()
        buyers = []
        if config.save_buyers and seller_user_id:
            buyers_status, buyers_payload = await client.buyers(
                trade_id,
                seller_user_id,
                key,
                user_id,
                page=1,
                page_size=config.buyer_page_size,
            )
            if buyers_status == 403:
                return {"ok": False, "forbidden": True, "error": f"buyers status={buyers_status}"}
            if buyers_status < 400:
                buyers = self._normalize_buyers(buyers_payload)
        trade_time = self._parse_datetime(detail.get("CreateTime"))
        if persist:
            await self.repository.upsert_trade_summary(detail, seller_flow)
            if config.save_buyers:
                await self.repository.replace_trade_buyers(int(detail.get("Id") or trade_id), buyers)
            if trade_time:
                await self.repository.refresh_daily_summary(trade_time.date())
            await self.repository.update_runtime(
                current_trade_id=trade_id,
                last_saved_trade_id=int(detail.get("Id") or trade_id),
                last_seen_create_time=trade_time,
                current_account_username=account.get("username") or "",
                status="running",
            )
        return {"ok": True, "buyers": len(buyers), "date": trade_time.date() if trade_time else None}

    def _apply_fetch_result(self, result: dict[str, Any]) -> None:
        self._state.processed += 1
        if result.get("forbidden"):
            self._state.forbidden += 1
        if result.get("missing"):
            self._state.missing += 1
        if result.get("ok"):
            self._state.saved += 1
            self._state.buyer_rows += int(result.get("buyers") or 0)
            self._state.message = f"处理中：已保存 {self._state.saved} 笔，买家明细 {self._state.buyer_rows} 条"
        else:
            self._state.failed += 1
            self._state.last_error = str(result.get("error") or "")[:500]

    def _apply_buyers_result(self, result: dict[str, Any]) -> None:
        if result.get("forbidden"):
            self._state.forbidden += 1
        if result.get("ok"):
            self._state.buyer_rows += int(result.get("buyers") or 0)
            self._state.message = f"处理中：已保存 {self._state.saved} 笔，买家明细 {self._state.buyer_rows} 条"
        else:
            self._state.failed += 1
            self._state.last_error = str(result.get("error") or "")[:500]

    def _finish(self, status: str, message: str, error: str = "") -> None:
        self._state.status = status
        self._state.message = message
        self._state.finished_at = time.time()
        self._state.last_error = error or self._state.last_error
        self._state.stop_reason = status
        self._state.stop_requested = False
        try:
            asyncio.create_task(self.repository.update_runtime(
                running=False,
                status=status,
                last_error=self._state.last_error or "",
                finished_at=datetime.now(),
            ))
        except Exception:
            pass

    def _set_error(self, message: str) -> dict[str, Any]:
        self._state = AkBackfillState(status="error", message=message, last_error=message, finished_at=time.time())
        return self.snapshot()

    @staticmethod
    def _normalize_buyers(payload: dict[str, Any]) -> list[dict[str, Any]]:
        rows = payload.get("Data") if isinstance(payload, dict) else []
        if not isinstance(rows, list):
            return []
        result = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            user = row.get("User") if isinstance(row.get("User"), dict) else {}
            flow = str(user.get("FlowNumber") or "").strip()
            amount = int(row.get("AceAmount") or 0)
            if flow:
                result.append({"buyer_flow_number": flow, "ak_amount": amount})
        return result

    @staticmethod
    def _parse_datetime(value: Any) -> datetime | None:
        text = str(value or "").strip()
        for pattern in ("%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
            try:
                return datetime.strptime(text[:19], pattern)
            except Exception:
                pass
        return None

    @staticmethod
    def _payload_message(payload: Any) -> str:
        if isinstance(payload, dict):
            return str(payload.get("Msg") or payload.get("message") or payload.get("Error") or "")[:500]
        return str(payload or "")[:500]

    @staticmethod
    def _int(value: Any, default: int) -> int:
        try:
            return int(value)
        except Exception:
            return int(default)

    @staticmethod
    def _date_text(value: Any, default: str) -> str:
        try:
            return date.fromisoformat(str(value or "").strip()).isoformat()
        except Exception:
            return default
