from __future__ import annotations

import asyncio
import hashlib
import time
import uuid
from datetime import datetime
from typing import Any, Mapping

from ..notice_guidance.provider import DEFAULT_PAGE_SIZE, NoticeGuidanceProvider, make_v
from ..notice_guidance.service import parse_date_key, trim_string
from .parser import extract_auth_fields, find_latest_guided_sale, is_auth_error
from .repository import (
    DEFAULT_CACHE_RETENTION_DAYS,
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

    def __init__(self, repository: GuidedSaleStatisticsRepository, auth_store, system_config, logger=None) -> None:
        self.repository = repository
        self.auth_store = auth_store
        self.system_config = system_config
        self.logger = logger
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

    async def request_scan(
        self, owner_scope: str, is_super_admin: bool, source_account: str
    ) -> dict[str, Any]:
        account = trim_string(source_account).lower()
        if not account:
            raise ValueError("missing source account")
        scoped = await self.repository.get_scoped_account(owner_scope, is_super_admin, account)
        if scoped is None:
            raise PermissionError("source account is outside the current whitelist scope")
        run = await self.repository.create_or_get_run(owner_scope, account)
        cached_auth = await self._load_auth(account)
        if cached_auth["user_id"]:
            await self.repository.set_run_user_id(int(run["id"]), cached_auth["user_id"])
        policy = await self.get_policy()
        written_at = run.get("cache_written_at")
        expired = bool(
            written_at
            and (datetime.now() - written_at).total_seconds() > policy["cache_retention_days"] * 86400
        )
        if expired:
            await self.repository.reset_run(int(run["id"]))
        self._wake.set()
        return await self.dashboard(owner_scope, is_super_admin, account)

    async def dashboard(
        self, owner_scope: str, is_super_admin: bool, source_account: str
    ) -> dict[str, Any]:
        policy = await self.get_policy()
        accounts = await self.repository.list_scope_accounts(owner_scope, is_super_admin)
        source = trim_string(source_account).lower()
        data = await self.repository.dashboard(owner_scope, source, policy["cache_retention_days"]) if source else {
            "run": None, "jobs": [], "rows": []
        }
        completed = sum(1 for item in data["jobs"] if item.get("state") == "completed")
        pending = sum(1 for item in data["jobs"] if item.get("state") == "pending")
        return {
            "success": True,
            "policy": policy,
            "is_super_admin": bool(is_super_admin),
            "accounts": accounts,
            "source_account": source,
            "run": self._serialize_run(data["run"]),
            "jobs": [self._serialize_job(item) for item in data["jobs"]],
            "rows": [self._serialize_row(item) for item in data["rows"]],
            "summary": {
                "whitelist_accounts": len(accounts),
                "completed_accounts": completed,
                "pending_accounts": pending,
                "matched_subaccounts": len(data["rows"]),
            },
        }

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
        run = await self.repository.claim_next_run(self.instance_id)
        if run is not None:
            await self._process_run(run)
            return True
        job = await self.repository.claim_next_job(self.instance_id)
        if job is not None:
            await self._process_job(job)
            return True
        return False

    async def _process_run(self, run: Mapping[str, Any]) -> None:
        run_id = int(run["id"])
        owner_scope = trim_string(run.get("owner_scope"))
        source_account = trim_string(run.get("source_account")).lower()
        is_super_admin = owner_scope == "__super__"
        if await self.repository.get_scoped_account(owner_scope, is_super_admin, source_account) is None:
            await self.repository.cancel_run(run_id, "source account no longer in whitelist scope")
            return
        ready, offline_since, delay = await self._offline_window_ready(
            source_account, run.get("source_offline_since")
        )
        if not ready:
            await self.repository.defer_run(run_id, delay, offline_since=offline_since)
            return
        try:
            async with self.provider.build_client() as client:
                auth = await self._load_auth(source_account)
                payload, auth = await self._call_with_one_refresh(
                    client,
                    source_account,
                    auth,
                    endpoint="Notice_List",
                    data={
                        "p": "1",
                        "pageSize": str(DEFAULT_PAGE_SIZE),
                        "v": make_v(),
                        "lang": "cn",
                    },
                    refresh_attempted=bool(run.get("source_auth_refresh_attempted")),
                    mark_refresh_attempted=lambda: self.repository.set_run_auth_refresh_attempted(run_id),
                )
                await self.repository.set_run_user_id(run_id, auth["user_id"])
            notice = find_latest_guided_sale(payload)
            if notice is None:
                await self.repository.defer_run(run_id, RETRY_SECONDS, offline_since=offline_since, error="no complete guided sale notice")
                return
            targets = await self.repository.list_scope_accounts(owner_scope, is_super_admin)
            await self.repository.complete_discovery(
                run_id,
                auth["user_id"],
                notice,
                [trim_string(item.get("username")) for item in targets],
            )
            for item in targets:
                target_account = trim_string(item.get("username")).lower()
                if not target_account:
                    continue
                cached_auth = await self._load_auth(target_account)
                if cached_auth["user_id"]:
                    await self.repository.set_run_job_user_id(run_id, target_account, cached_auth["user_id"])
            self._wake.set()
        except RpcSlotBusy:
            await self.repository.defer_run(run_id, 5, offline_since=offline_since)
        except Exception as exc:
            await self.repository.defer_run(run_id, RETRY_SECONDS, offline_since=offline_since, error=str(exc))
            self._log("notice discovery failed account=%s error=%s", source_account, str(exc)[:300])

    async def _process_job(self, job: Mapping[str, Any]) -> None:
        job_id = int(job["id"])
        owner_scope = trim_string(job.get("owner_scope"))
        target_account = trim_string(job.get("target_account")).lower()
        is_super_admin = owner_scope == "__super__"
        if await self.repository.get_scoped_account(owner_scope, is_super_admin, target_account) is None:
            await self.repository.cancel_job(job_id, "target account no longer in whitelist scope")
            return
        ready, offline_since, delay = await self._offline_window_ready(target_account, job.get("offline_since"))
        if not ready:
            await self.repository.defer_job(job_id, delay, offline_since=offline_since)
            return
        try:
            async with self.provider.build_client() as client:
                auth = await self._load_auth(target_account)
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
            self._wake.set()
        except RpcSlotBusy:
            await self.repository.defer_job(job_id, 5, offline_since=offline_since)
        except Exception as exc:
            await self.repository.defer_job(job_id, RETRY_SECONDS, offline_since=offline_since, error=str(exc))
            self._log("subaccount scan failed account=%s error=%s", target_account, str(exc)[:300])

    async def _offline_window_ready(
        self, account: str, offline_since: datetime | None
    ) -> tuple[bool, datetime | None, int]:
        if await self.repository.is_account_online(account):
            return False, None, 60
        now = datetime.now()
        if offline_since is None:
            return False, now, OFFLINE_GRACE_SECONDS
        elapsed = max(0, int((now - offline_since).total_seconds()))
        if elapsed < OFFLINE_GRACE_SECONDS:
            return False, offline_since, OFFLINE_GRACE_SECONDS - elapsed
        return True, offline_since, 0

    async def _load_auth(self, account: str) -> dict[str, str]:
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
        return {
            "target_account": trim_string(job.get("target_account")),
            "state": trim_string(job.get("state")),
            "matched_count": max(0, int(job.get("matched_count") or 0)),
            "completed_at": self._serialize_time(job.get("completed_at")),
        }

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
