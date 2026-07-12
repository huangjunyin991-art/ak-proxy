from __future__ import annotations

import asyncio
import hashlib
import time
import uuid
from datetime import datetime
from typing import Any, Mapping

from ..notice_guidance.provider import DEFAULT_PAGE_SIZE, NoticeGuidanceProvider, make_v
from ..notice_guidance.service import parse_date_key, trim_string
from ..notice_guidance.cache_scope import build_guided_sale_cache_scope
from .parser import extract_auth_fields, find_latest_guided_sale, is_auth_error
from .repository import (
    DEFAULT_CACHE_RETENTION_DAYS,
    GLOBAL_NOTICE_CACHE_SECONDS,
    GLOBAL_NOTICE_PARSE_VERSION,
    OFFLINE_GRACE_SECONDS,
    GuidedSaleStatisticsRepository,
)


BACKGROUND_CALL_INTERVAL_SECONDS = 2.0
IDLE_POLL_SECONDS = 10.0
RETRY_SECONDS = 5 * 60
EXTERNAL_WAIT_SECONDS = 25.0


class RpcSlotBusy(RuntimeError):
    pass


class GuidedSaleStatisticsService:
    """Owns guided-sale jobs; API calls are serialized and resumable by page."""

    def __init__(
        self, repository: GuidedSaleStatisticsRepository, auth_store, system_config, logger=None,
        notice_cache_repository=None,
    ) -> None:
        self.repository = repository
        self.auth_store = auth_store
        self.system_config = system_config
        self.logger = logger
        self.notice_cache_repository = notice_cache_repository
        self.provider = NoticeGuidanceProvider()
        self.instance_id = "guided-sale-" + uuid.uuid4().hex
        self._task: asyncio.Task | None = None
        self._stopping = asyncio.Event()
        self._wake = asyncio.Event()
        self._last_cleanup_at = 0.0
        self._presence_write_at: dict[tuple[str, str], float] = {}

    async def ensure_ready(self) -> None:
        await self.repository.ensure_ready()

    async def start(self) -> None:
        await self.ensure_ready()
        if self._task is not None and not self._task.done():
            return
        self._stopping.clear()
        self._task = asyncio.create_task(self._run(), name="guided-sale-statistics-worker")

    async def stop(self) -> None:
        self._stopping.set()
        self._wake.set()
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def get_policy(self) -> dict[str, int]:
        raw = await self.system_config.get("guided_sale_statistics_policy", {})
        value = raw if isinstance(raw, Mapping) else {}
        try:
            days = int(value.get("cache_retention_days") or DEFAULT_CACHE_RETENTION_DAYS)
        except (TypeError, ValueError):
            days = DEFAULT_CACHE_RETENTION_DAYS
        return {
            "cache_retention_days": max(1, min(365, days))
        }

    async def save_policy(self, payload: Mapping[str, Any]) -> dict[str, int]:
        days = max(1, min(365, int(payload.get("cache_retention_days") or DEFAULT_CACHE_RETENTION_DAYS)))
        policy = {"cache_retention_days": days}
        await self.system_config.set(
            "guided_sale_statistics_policy", policy, "Guided sale statistics cache retention days"
        )
        await self.repository.cleanup_expired(days)
        return policy

    async def list_accounts(self, owner_scope: str, is_super_admin: bool) -> list[dict[str, Any]]:
        return await self.repository.list_scope_accounts(owner_scope, is_super_admin)

    async def configure_global_source(self, source_account: str) -> dict[str, Any]:
        account = trim_string(source_account).lower()
        if not account:
            raise ValueError("missing global source account")
        if await self.repository.get_active_account(account) is None:
            raise ValueError("global source account is not an active authorized account")
        record = await self.repository.configure_global_source(account)
        self._wake.set()
        return self._serialize_global_notice(record, include_source=True)

    async def request_scan(self, owner_scope: str, is_super_admin: bool, source_account: str = "") -> dict[str, Any]:
        """Create this administrator's scan only after an explicit command."""
        return await self.dashboard(owner_scope, is_super_admin, start_scan=True)

    async def refresh_notice(self, owner_scope: str, is_super_admin: bool) -> dict[str, Any]:
        """Retry an expired or failed announcement fetch without creating scan jobs."""
        return await self.dashboard(owner_scope, is_super_admin, force_notice_retry=True)

    async def dashboard(
        self,
        owner_scope: str,
        is_super_admin: bool,
        source_account: str = "",
        *,
        start_scan: bool = False,
        force_notice_retry: bool = False,
    ) -> dict[str, Any]:
        policy = await self.get_policy()
        accounts = await self.repository.list_scope_accounts(owner_scope, is_super_admin)
        global_notice = await self._ensure_global_notice(force_retry=force_notice_retry)
        source = trim_string(global_notice.get("source_account")).lower()
        fresh_notice = self._global_notice_is_fresh(global_notice)
        if fresh_notice and start_scan:
            await self._ensure_owner_scan(owner_scope, source, global_notice, accounts, policy["cache_retention_days"])
        data = await self.repository.dashboard(owner_scope, source, policy["cache_retention_days"]) if source else {
            "run": None, "jobs": [], "rows": []
        }
        shared_results = await self._load_dashboard_shared_results(accounts, global_notice) if fresh_notice else {}
        jobs, rows = self._merge_dashboard_results(accounts, data, shared_results)
        completed = sum(1 for item in jobs if item.get("state") == "completed")
        pending = sum(1 for item in jobs if item.get("state") == "pending")
        return {
            "success": True,
            "policy": policy,
            "is_super_admin": bool(is_super_admin),
            "accounts": accounts,
            "source_configured": bool(source),
            "source_account": source if is_super_admin else "",
            "notice": self._serialize_global_notice(global_notice, include_source=is_super_admin),
            "run": self._serialize_run(data["run"]),
            "jobs": [self._serialize_job(item) for item in jobs],
            "rows": [self._serialize_row(item) for item in rows],
            "summary": {
                "whitelist_accounts": len(accounts),
                "completed_accounts": completed,
                "pending_accounts": pending,
                "matched_subaccounts": len(rows),
            },
        }

    async def _load_dashboard_shared_results(
        self, accounts: list[Mapping[str, Any]], notice: Mapping[str, Any]
    ) -> dict[str, dict[str, Any]]:
        """Read completed notice-viewer scans without creating jobs or calling upstream."""
        cache_repository = self.notice_cache_repository
        notice_id = trim_string(notice.get("notice_id"))
        start_date_key = int(notice.get("start_date_key") or 0)
        end_date_key = int(notice.get("end_date_key") or 0)
        usernames = [trim_string(item.get("username")).lower() for item in accounts]
        usernames = [item for item in usernames if item]
        if not cache_repository or not notice_id or not start_date_key or not end_date_key or not usernames:
            return {}
        try:
            account_user_ids = await self.repository.get_account_user_ids(usernames)
            cached_by_user_id = await cache_repository.get_completed_scans_for_users(
                list(account_user_ids.values()), notice_id, start_date_key, end_date_key
            )
        except (AttributeError, TypeError, ValueError):
            return {}
        except Exception as exc:
            self._log("dashboard shared cache lookup failed: %s", str(exc)[:300])
            return {}
        return {
            account: cached_by_user_id[user_id]
            for account, user_id in account_user_ids.items()
            if user_id in cached_by_user_id
        }

    @staticmethod
    def _merge_dashboard_results(
        accounts: list[Mapping[str, Any]], data: Mapping[str, Any], shared_results: Mapping[str, Mapping[str, Any]]
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        """Prefer a completed shared result over an unfinished local scan for the same account."""
        account_order = [trim_string(item.get("username")).lower() for item in accounts]
        account_order = [item for item in account_order if item]
        account_set = set(account_order)
        raw_jobs = [dict(item) for item in (data.get("jobs") or []) if isinstance(item, Mapping)]
        jobs_by_account = {
            trim_string(item.get("target_account")).lower(): item
            for item in raw_jobs
            if trim_string(item.get("target_account")).lower() in account_set
        }
        rows_by_account: dict[str, list[Mapping[str, Any]]] = {account: [] for account in account_order}
        for item in data.get("rows") or []:
            if not isinstance(item, Mapping):
                continue
            target = trim_string(item.get("target_account")).lower()
            if target in rows_by_account:
                rows_by_account[target].append(item)

        jobs: list[dict[str, Any]] = []
        rows: list[dict[str, str]] = []
        seen_rows: set[tuple[str, str]] = set()
        for account in account_order:
            job = jobs_by_account.get(account)
            shared = shared_results.get(account)
            use_shared = bool(shared) and trim_string(job.get("state") if job else "") != "completed"
            if use_shared:
                shared_rows = [item for item in (shared.get("rows") or []) if isinstance(item, Mapping)]
                shared_child_accounts = {
                    trim_string(item.get("child_account") or item.get("account")).lower()
                    for item in shared_rows
                    if trim_string(item.get("child_account") or item.get("account"))
                }
                jobs.append({
                    "target_account": account,
                    "state": "completed",
                    "next_page": max(1, int(shared.get("pages_scanned") or 0) + 1),
                    "matched_count": len(shared_child_accounts),
                    "completed_at": shared.get("completed_at"),
                })
                source_rows = shared_rows
            else:
                if job is not None:
                    jobs.append(job)
                source_rows = rows_by_account.get(account, [])
            for item in source_rows:
                child_account = trim_string(item.get("child_account") or item.get("account")).lower()
                if not child_account or (account, child_account) in seen_rows:
                    continue
                seen_rows.add((account, child_account))
                rows.append({
                    "target_account": account,
                    "child_account": child_account,
                    "create_time": trim_string(item.get("create_time") or item.get("createTime")),
                })
        return jobs, rows

    async def _ensure_global_notice(self, force_retry: bool = False) -> dict[str, Any]:
        current = await self.repository.get_global_notice()
        if self._global_notice_is_fresh(current):
            return current
        holder = "notice-refresh-" + uuid.uuid4().hex
        claimed = await self.repository.claim_global_notice_refresh(holder, force_retry=force_retry)
        if claimed is None:
            return await self.repository.get_global_notice()
        source_account = trim_string(claimed.get("source_account")).lower()
        try:
            if await self.repository.get_active_account(source_account) is None:
                raise RuntimeError("global source account is no longer active")
            async with self.provider.build_client() as client:
                auth = await self._load_auth(source_account)

                async def mark_refreshed() -> None:
                    return None

                payload, auth = await self._call_with_one_refresh(
                    client,
                    source_account,
                    auth,
                    endpoint="Notice_List",
                    data={"p": "1", "pageSize": str(DEFAULT_PAGE_SIZE), "v": make_v(), "lang": "cn"},
                    refresh_attempted=False,
                    mark_refresh_attempted=mark_refreshed,
                )
            notice = find_latest_guided_sale(payload)
            if notice is None:
                raise RuntimeError("no complete guided sale notice")
            await self.repository.cache_global_notice(holder, source_account, auth["user_id"], notice)
        except RpcSlotBusy:
            await self.repository.defer_global_notice_refresh(holder, 5)
        except Exception as exc:
            await self.repository.defer_global_notice_refresh(holder, RETRY_SECONDS, str(exc))
            self._log("global notice refresh failed account=%s error=%s", source_account, str(exc)[:300])
        return await self.repository.get_global_notice()

    async def _ensure_owner_scan(
        self,
        owner_scope: str,
        source_account: str,
        notice: Mapping[str, Any],
        accounts: list[Mapping[str, Any]],
        retention_days: int,
    ) -> None:
        if not source_account or not trim_string(notice.get("notice_id")):
            return
        targets = [trim_string(item.get("username")) for item in accounts]
        run = await self.repository.get_run(owner_scope, source_account)
        needs_rebuild = run is None
        if run is not None:
            written_at = run.get("cache_written_at")
            expired = bool(
                written_at
                and (datetime.now() - written_at).total_seconds() > max(1, retention_days) * 86400
            )
            needs_rebuild = (
                trim_string(run.get("notice_id")) != trim_string(notice.get("notice_id"))
                or int(run.get("start_date_key") or 0) != int(notice.get("start_date_key") or 0)
                or int(run.get("end_date_key") or 0) != int(notice.get("end_date_key") or 0)
                or trim_string(run.get("state")) in {"waiting_notice", "cancelled", "expired"}
                or expired
            )
        if run is None:
            run = await self.repository.create_or_get_run(owner_scope, source_account)
        if needs_rebuild:
            await self.repository.reset_run(int(run["id"]))
            await self.repository.complete_discovery(
                int(run["id"]), trim_string(notice.get("source_user_id")), notice, targets
            )
            self._wake.set()
            return
        await self.repository.ensure_run_jobs(int(run["id"]), targets)

    @staticmethod
    def _global_notice_is_fresh(record: Mapping[str, Any]) -> bool:
        cached_at = record.get("notice_cached_at") if isinstance(record, Mapping) else None
        try:
            parse_version = int(record.get("parse_version") or 0)
        except (TypeError, ValueError):
            parse_version = 0
        return bool(
            trim_string(record.get("notice_id"))
            and trim_string(record.get("title"))
            and trim_string(record.get("guidance_time"))
            and parse_version == GLOBAL_NOTICE_PARSE_VERSION
            and isinstance(cached_at, datetime)
            and (datetime.now() - cached_at).total_seconds() <= GLOBAL_NOTICE_CACHE_SECONDS
        )

    def _serialize_global_notice(self, record: Mapping[str, Any], *, include_source: bool) -> dict[str, Any]:
        cached_at = record.get("notice_cached_at") if isinstance(record, Mapping) else None
        fresh = self._global_notice_is_fresh(record)
        return {
            "state": trim_string(record.get("refresh_state")) or "unconfigured",
            "available": bool(trim_string(record.get("notice_id")) and trim_string(record.get("title"))),
            "fresh": fresh,
            "sale_count": max(0, int(record.get("sale_count") or 0)),
            "title": trim_string(record.get("title")),
            "guidance_time": trim_string(record.get("guidance_time")),
            "target_line": trim_string(record.get("target_line")),
            "start_date_label": trim_string(record.get("start_date_label")),
            "end_date_label": trim_string(record.get("end_date_label")),
            "cached_at": self._serialize_time(cached_at),
            "source_account": trim_string(record.get("source_account")) if include_source else "",
            "error": self._notice_error_message(trim_string(record.get("last_error"))),
        }

    @staticmethod
    def _notice_error_message(error: str) -> str:
        text = trim_string(error).lower()
        if not text:
            return ""
        if "no saved password" in text:
            return "全局绑定账号缺少可用登录凭据"
        if "no longer active" in text:
            return "全局绑定账号已失效"
        if "no complete guided sale notice" in text:
            return "未找到可解析的指导销售公告"
        if "timeout" in text:
            return "上游公告请求超时"
        if "auth" in text or "key" in text or "login" in text:
            return "全局绑定账号认证失败"
        return "公告同步失败，请稍后重试"

    async def handle_presence_event(self, event: str, username: str, connection_id: str) -> None:
        account = trim_string(username).lower()
        connection = trim_string(connection_id)
        if not account or not connection:
            return
        key = (account, connection)
        now = time.monotonic()
        if event != "offline" and now - self._presence_write_at.get(key, 0.0) < 20.0:
            return
        try:
            await self.repository.record_presence(account, self.instance_id, connection, event)
            if event == "offline":
                self._presence_write_at.pop(key, None)
            else:
                self._presence_write_at[key] = now
            self._wake.set()
        except Exception as exc:
            self._log("presence update failed: %s", str(exc)[:300])

    async def reserve_external_rpc(self, params: Mapping[str, Any]) -> tuple[str, str] | None:
        """Give a proxied user request priority over background scanning."""
        identity = self._request_identity(params)
        user_id = trim_string(params.get("UserID") or params.get("userId") or params.get("userid"))
        await self.repository.mark_external_activity(user_id)
        holder = "external-" + uuid.uuid4().hex
        deadline = time.monotonic() + EXTERNAL_WAIT_SECONDS
        while time.monotonic() < deadline:
            if await self.repository.try_claim_rpc_locks(identity, holder):
                return identity, holder
            await asyncio.sleep(0.2)
        return None

    async def release_external_rpc(self, lease: tuple[str, str] | None) -> None:
        if not lease:
            return
        try:
            await asyncio.sleep(BACKGROUND_CALL_INTERVAL_SECONDS)
            await self.repository.release_rpc_locks(lease[0], lease[1])
        except Exception as exc:
            self._log("external RPC lock release failed: %s", str(exc)[:300])

    async def _run(self) -> None:
        while not self._stopping.is_set():
            try:
                await self._cleanup_if_due()
                did_work = await self._run_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._log("worker iteration failed: %s", str(exc)[:500])
                did_work = False
            self._wake.clear()
            timeout = 0.3 if did_work else IDLE_POLL_SECONDS
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                pass

    async def _run_once(self) -> bool:
        job = await self.repository.claim_next_job(self.instance_id)
        if job is not None:
            await self._process_job(job)
            return True
        return False

    async def _process_job(self, job: Mapping[str, Any]) -> None:
        job_id = int(job["id"])
        owner_scope = trim_string(job.get("owner_scope"))
        target_account = trim_string(job.get("target_account")).lower()
        is_super_admin = owner_scope == "__super__"
        if await self.repository.get_scoped_account(owner_scope, is_super_admin, target_account) is None:
            await self.repository.cancel_job(job_id, "target account no longer in whitelist scope")
            return
        try:
            auth = await self._load_auth(target_account)
            target_user_id = auth["user_id"] or trim_string(job.get("target_user_id"))
            cached = await self._load_shared_completed_scan(job, target_user_id)
            if cached is not None:
                await self.repository.set_job_user_id(job_id, target_user_id)
                await self.repository.commit_page(
                    job_id,
                    cached["rows"],
                    max(1, int(job.get("next_page") or 1), int(cached.get("pages_scanned") or 0) + 1),
                    completed=True,
                )
                self._wake.set()
                return
        except Exception as exc:
            await self.repository.defer_job(
                job_id, RETRY_SECONDS, offline_since=job.get("offline_since"), error=str(exc)
            )
            self._log("shared cache preparation failed account=%s error=%s", target_account, str(exc)[:300])
            return
        ready, offline_since, delay = await self._offline_window_ready(target_account, job.get("offline_since"))
        if not ready:
            await self.repository.defer_job(job_id, delay, offline_since=offline_since)
            return
        try:
            async with self.provider.build_client() as client:
                page = max(1, int(job.get("next_page") or 1))
                payload, auth = await self._call_with_one_refresh(
                    client,
                    target_account,
                    auth,
                    endpoint="My_Subaccount",
                    data={"p": str(page), "size": str(DEFAULT_PAGE_SIZE), "v": make_v(), "lang": "cn"},
                    refresh_attempted=bool(job.get("auth_refresh_attempted")),
                    mark_refresh_attempted=lambda: self.repository.set_job_auth_refresh_attempted(job_id),
                )
                await self.repository.set_job_user_id(job_id, auth["user_id"])
            result = self._normalize_subaccount_page(payload)
            matches, reached_before_start = self._filter_page_rows(
                result["rows"],
                int(job.get("start_date_key") or 0),
                int(job.get("end_date_key") or 0),
            )
            completed = not result["rows"] or len(result["rows"]) < DEFAULT_PAGE_SIZE or reached_before_start
            await self.repository.commit_page(job_id, matches, page + 1, completed)
            if completed:
                await self._save_shared_completed_scan(job, job_id, auth, page, result["rows"], reached_before_start)
            self._wake.set()
        except RpcSlotBusy:
            await self.repository.defer_job(job_id, 5, offline_since=offline_since)
        except Exception as exc:
            await self.repository.defer_job(job_id, RETRY_SECONDS, offline_since=offline_since, error=str(exc))
            self._log("subaccount scan failed account=%s error=%s", target_account, str(exc)[:300])

    async def _load_shared_completed_scan(
        self, job: Mapping[str, Any], target_user_id: str
    ) -> dict[str, Any] | None:
        repository = self.notice_cache_repository
        notice_id = trim_string(job.get("notice_id"))
        if repository is None or not target_user_id or not notice_id:
            return None
        try:
            return await repository.get_completed_scan_for_user(
                target_user_id,
                notice_id,
                int(job.get("start_date_key") or 0),
                int(job.get("end_date_key") or 0),
            )
        except Exception as exc:
            self._log("shared cache lookup failed account=%s error=%s", job.get("target_account"), str(exc)[:300])
            return None

    async def _save_shared_completed_scan(
        self,
        job: Mapping[str, Any],
        job_id: int,
        auth: Mapping[str, str],
        page: int,
        page_rows: list[Mapping[str, Any]],
        reached_before_start: bool,
    ) -> None:
        repository = self.notice_cache_repository
        if repository is None or not trim_string(auth.get("user_id")) or not trim_string(auth.get("key")):
            return
        info = {
            "notice_id": trim_string(job.get("notice_id")),
            "title": trim_string(job.get("title")),
            "target_line": trim_string(job.get("target_line")),
            "start_date_key": int(job.get("start_date_key") or 0),
            "end_date_key": int(job.get("end_date_key") or 0),
            "start_date_label": trim_string(job.get("start_date_label")),
            "end_date_label": trim_string(job.get("end_date_label")),
        }
        if not info["notice_id"]:
            return
        try:
            rows = await self.repository.get_job_rows(job_id)
            stop_reason = "page_empty" if not page_rows else (
                "reached_before_start" if reached_before_start else "page_not_full"
            )
            await repository.save_completed_scan(
                build_guided_sale_cache_scope(info, auth),
                {
                    "accounts": [trim_string(row.get("account")) for row in rows],
                    "rows": rows,
                    "pages_scanned": page,
                    "stop_reason": stop_reason,
                },
            )
        except Exception as exc:
            self._log("shared cache write failed account=%s error=%s", job.get("target_account"), str(exc)[:300])

    async def _offline_window_ready(
        self, account: str, offline_since: datetime | None
    ) -> tuple[bool, datetime | None, int]:
        presence_reader = getattr(self.repository, "get_account_presence_state", None)
        if callable(presence_reader):
            presence = await presence_reader(account, fallback_offline_since=offline_since)
            if bool(presence.get("online")):
                return False, None, 60
            tracked_offline_since = presence.get("offline_since")
            if isinstance(tracked_offline_since, datetime):
                offline_since = tracked_offline_since
        elif await self.repository.is_account_online(account):
            return False, None, 60
        now = datetime.now()
        if offline_since is None:
            return False, now, OFFLINE_GRACE_SECONDS
        elapsed = max(0, int((now - offline_since).total_seconds()))
        if elapsed < OFFLINE_GRACE_SECONDS:
            return False, offline_since, OFFLINE_GRACE_SECONDS - elapsed
        return True, offline_since, 0

    async def _load_auth(self, account: str) -> dict[str, str]:
        try:
            state = await self.auth_store.get_ak_auth_state(account, allow_expired=True)
        except TypeError:
            state = await self.auth_store.get_ak_auth_state(account)
        if not isinstance(state, Mapping):
            return {"account": account, "key": "", "user_id": ""}
        payload = state.get("login_result") if isinstance(state.get("login_result"), Mapping) else {}
        fields = extract_auth_fields(payload, trim_string(state.get("userkey")))
        return {"account": account, "key": fields["key"], "user_id": fields["user_id"]}

    async def _call_with_one_refresh(
        self,
        client,
        account: str,
        auth: dict[str, str],
        *,
        endpoint: str,
        data: Mapping[str, Any],
        refresh_attempted: bool,
        mark_refresh_attempted,
    ) -> tuple[dict[str, Any], dict[str, str]]:
        if not auth["key"] or not auth["user_id"]:
            if refresh_attempted:
                raise RuntimeError("stored AK credentials are unavailable")
            await mark_refresh_attempted()
            auth = await self._refresh_auth(client, account, auth)
            refresh_attempted = True
        request_data = dict(data)
        request_data.update({"key": auth["key"], "UserID": auth["user_id"]})
        try:
            return await self._gated_post(client, auth["user_id"] or account, endpoint, request_data), auth
        except Exception as exc:
            if refresh_attempted or not is_auth_error(exc):
                raise
            await mark_refresh_attempted()
            auth = await self._refresh_auth(client, account, auth)
            request_data.update({"key": auth["key"], "UserID": auth["user_id"]})
            return await self._gated_post(client, auth["user_id"] or account, endpoint, request_data), auth

    async def _refresh_auth(self, client, account: str, current: Mapping[str, str]) -> dict[str, str]:
        password = ""
        get_user_password = getattr(self.auth_store, "get_user_password", None)
        if callable(get_user_password):
            password = trim_string(await get_user_password(account))
        if not password:
            password = await self.repository.get_account_password(account)
        if not password:
            raise RuntimeError("no saved password available for one-time credential refresh")
        payload = await self._gated_post(
            client,
            current.get("user_id") or account,
            "Login",
            {"account": account, "password": password, "v": make_v(), "lang": "cn"},
        )
        fields = extract_auth_fields(payload)
        if not fields["key"] or not fields["user_id"]:
            raise RuntimeError("login succeeded without usable key or UserID")
        await self.auth_store.save_ak_auth_state(
            account, userkey=fields["key"], cookies={}, login_payload=payload, ttl_seconds=3600
        )
        return {"account": account, "key": fields["key"], "user_id": fields["user_id"]}

    async def _gated_post(self, client, identity: str, endpoint: str, data: Mapping[str, Any]) -> dict[str, Any]:
        holder = "background-" + uuid.uuid4().hex
        if not await self.repository.try_claim_rpc_locks(identity, holder):
            raise RpcSlotBusy()
        try:
            return await self.provider.post_rpc(client, endpoint, dict(data))
        finally:
            await asyncio.sleep(BACKGROUND_CALL_INTERVAL_SECONDS)
            await self.repository.release_rpc_locks(identity, holder)

    @staticmethod
    def _normalize_subaccount_page(payload: Mapping[str, Any]) -> dict[str, Any]:
        data = payload.get("Data") if isinstance(payload.get("Data"), Mapping) else {}
        rows = data.get("List") if isinstance(data.get("List"), list) else []
        return {"rows": [row for row in rows if isinstance(row, Mapping)]}

    @staticmethod
    def _filter_page_rows(rows: list[Mapping[str, Any]], start_date_key: int, end_date_key: int) -> tuple[list[dict[str, str]], bool]:
        matches: list[dict[str, str]] = []
        seen: set[str] = set()
        oldest_date = 0
        for row in rows:
            account = trim_string(
                row.get("MemberNo") or row.get("member_no") or row.get("memberNo")
                or row.get("Account") or row.get("account")
            ).lower()
            create_time = trim_string(
                row.get("CreateTime") or row.get("create_time") or row.get("createTime")
            )
            date_key = parse_date_key(create_time)
            if date_key and (not oldest_date or date_key < oldest_date):
                oldest_date = date_key
            if not account or not date_key or account in seen:
                continue
            if start_date_key <= date_key <= end_date_key:
                seen.add(account)
                matches.append({"account": account, "createTime": create_time})
        return matches, bool(oldest_date and oldest_date < start_date_key)

    async def _cleanup_if_due(self) -> None:
        now = time.monotonic()
        if now - self._last_cleanup_at < 60 * 60:
            return
        policy = await self.get_policy()
        await self.repository.cleanup_expired(policy["cache_retention_days"])
        self._last_cleanup_at = now

    @staticmethod
    def _serialize_time(value: Any) -> str:
        return value.isoformat(sep=" ", timespec="seconds") if isinstance(value, datetime) else ""

    def _serialize_run(self, run: Mapping[str, Any] | None) -> dict[str, Any] | None:
        if not isinstance(run, Mapping):
            return None
        return {
            "state": trim_string(run.get("state")),
            "source_account": trim_string(run.get("source_account")),
            "notice_id": trim_string(run.get("notice_id")),
            "sale_count": max(0, int(run.get("sale_count") or 0)),
            "title": trim_string(run.get("title")),
            "target_line": trim_string(run.get("target_line")),
            "start_date_label": trim_string(run.get("start_date_label")),
            "end_date_label": trim_string(run.get("end_date_label")),
            "cache_written_at": self._serialize_time(run.get("cache_written_at")),
            "completed_at": self._serialize_time(run.get("completed_at")),
        }

    def _serialize_job(self, job: Mapping[str, Any]) -> dict[str, Any]:
        result = {
            "target_account": trim_string(job.get("target_account")),
            "state": trim_string(job.get("state")),
            "matched_count": max(0, int(job.get("matched_count") or 0)),
            "completed_at": self._serialize_time(job.get("completed_at")),
        }
        offline_since = self._serialize_time(job.get("offline_since"))
        if result["state"] == "pending" and offline_since:
            result["offline_since"] = offline_since
        return result

    @staticmethod
    def _serialize_row(row: Mapping[str, Any]) -> dict[str, str]:
        return {
            "target_account": trim_string(row.get("target_account")),
            "child_account": trim_string(row.get("child_account")),
            "create_time": trim_string(row.get("create_time")),
        }

    @staticmethod
    def _request_identity(params: Mapping[str, Any]) -> str:
        user_id = trim_string(params.get("UserID") or params.get("userId") or params.get("userid"))
        if user_id:
            return "uid:" + user_id
        key = trim_string(params.get("key") or params.get("Key"))
        if key:
            return "key:" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]
        return "unknown"

    def _log(self, message: str, *args) -> None:
        if self.logger is None:
            return
        try:
            self.logger.warning("[GuidedSaleStatistics] " + message, *args)
        except Exception:
            pass
