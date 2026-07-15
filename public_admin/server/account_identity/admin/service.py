from __future__ import annotations

import asyncio
import copy
import time
from datetime import datetime, timedelta
from typing import Any, Callable

from ..migration_registry import ACCOUNT_ID_PHASES
from .repository import AccountIdentityAdminRepository


ACCOUNT_IDENTITY_SYNC_POLICY_KEY = "account_identity_sync_policy"
_ALL_PHASE_KEYS = tuple(phase.key for phase in ACCOUNT_ID_PHASES)
_PHASE_STATS_CACHE_SECONDS = 300.0


def build_default_sync_policy() -> dict[str, Any]:
    return {
        "enabled": False,
        "daily_time": "03:30",
        "phases": list(_ALL_PHASE_KEYS),
        "limit_per_spec": 0,
    }


def normalize_account_identity_sync_policy(value: dict[str, Any] | None) -> dict[str, Any]:
    default = build_default_sync_policy()
    source = value if isinstance(value, dict) else {}
    raw_time = str(source.get("daily_time") or default["daily_time"]).strip()
    daily_time = _normalize_daily_time(raw_time) or default["daily_time"]
    phases = source.get("phases")
    if not isinstance(phases, list):
        phases = list(default["phases"])
    normalized_phases = [item for item in _ALL_PHASE_KEYS if item in {str(v or "").strip().lower() for v in phases}]
    if not normalized_phases:
        normalized_phases = list(default["phases"])
    try:
        limit_per_spec = int(source.get("limit_per_spec", default["limit_per_spec"]))
    except (TypeError, ValueError):
        limit_per_spec = int(default["limit_per_spec"])
    return {
        "enabled": bool(source.get("enabled", default["enabled"])),
        "daily_time": daily_time,
        "phases": normalized_phases,
        "limit_per_spec": max(0, limit_per_spec),
    }


def compute_next_auto_run_at(policy: dict[str, Any] | None, now: datetime | None = None) -> datetime | None:
    normalized = normalize_account_identity_sync_policy(policy)
    if not normalized["enabled"]:
        return None
    hour, minute = _split_daily_time(normalized["daily_time"])
    current = now or datetime.now()
    target = current.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= current:
        target += timedelta(days=1)
    return target


def compute_auto_run_window(
    policy: dict[str, Any] | None,
    *,
    now: datetime | None = None,
    grace_seconds: float = 300.0,
) -> tuple[datetime, datetime] | None:
    normalized = normalize_account_identity_sync_policy(policy)
    if not normalized["enabled"]:
        return None
    hour, minute = _split_daily_time(normalized["daily_time"])
    current = now or datetime.now()
    target = current.replace(hour=hour, minute=minute, second=0, microsecond=0)
    window_seconds = max(30.0, float(grace_seconds or 0.0))
    return target, target + timedelta(seconds=window_seconds)


class AccountIdentityAdminService:
    def __init__(
        self,
        pool_supplier: Callable[[], object],
        system_config,
        ensure_columns: Callable[..., Any],
        collect_stats: Callable[..., Any],
        find_pending: Callable[..., Any],
        backfill: Callable[..., Any],
        get_plan: Callable[[], list[dict[str, Any]]],
        logger=None,
    ):
        self.repository = AccountIdentityAdminRepository(pool_supplier)
        self._system_config = system_config
        self._ensure_columns = ensure_columns
        self._collect_stats = collect_stats
        self._find_pending = find_pending
        self._backfill = backfill
        self._get_plan = get_plan
        self._logger = logger
        self._run_lock = asyncio.Lock()
        self._ready_lock = asyncio.Lock()
        self._schema_lock = asyncio.Lock()
        self._repository_ready = False
        self._schema_initialized = False
        self._active_task: asyncio.Task | None = None
        self._current_run: dict[str, Any] | None = None
        self._phase_stats_cache: dict[str, Any] = {"expires_at": 0.0, "items": []}
        self._scheduler = None

    def attach_scheduler(self, scheduler) -> None:
        self._scheduler = scheduler

    async def ensure_ready(self) -> None:
        if self._repository_ready:
            return
        async with self._ready_lock:
            if self._repository_ready:
                return
            await self.repository.ensure_tables()
            self._repository_ready = True

    async def initialize_schema(self) -> list[dict[str, Any]]:
        async with self._schema_lock:
            if self._schema_initialized:
                return []
            await self.ensure_ready()
            results = await self._ensure_columns(phase_key="")
            self._schema_initialized = True
            return results

    async def get_policy(self) -> dict[str, Any]:
        try:
            saved = await self._system_config.get(ACCOUNT_IDENTITY_SYNC_POLICY_KEY, None)
        except Exception:
            saved = None
        return normalize_account_identity_sync_policy(saved if isinstance(saved, dict) else None)

    async def get_latest_auto_sync_run_for_day(self, now: datetime | None = None) -> dict[str, Any] | None:
        await self.ensure_ready()
        current = now or datetime.now()
        day_start = current.replace(hour=0, minute=0, second=0, microsecond=0)
        day_end = day_start + timedelta(days=1)
        return await self.repository.get_latest_auto_sync_run(day_start=day_start, day_end=day_end)

    async def set_policy(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        normalized = normalize_account_identity_sync_policy(payload if isinstance(payload, dict) else None)
        ok = await self._system_config.set(
            ACCOUNT_IDENTITY_SYNC_POLICY_KEY,
            normalized,
            "账号身份全同步计划任务配置",
        )
        if not ok:
            raise RuntimeError("保存账号迁移同步配置失败")
        return normalized

    async def get_dashboard(
        self,
        search: str = "",
        limit: int = 50,
        offset: int = 0,
        runs_limit: int = 20,
        force_stats: bool = False,
    ) -> dict[str, Any]:
        await self.ensure_ready()
        policy = await self.get_policy()
        summary = await self.repository.get_identity_summary()
        identities = await self.repository.list_recent_identity_changes(search=search, limit=limit, offset=offset)
        runs = await self.repository.list_recent_sync_runs(limit=runs_limit)
        return {
            "success": True,
            "policy": policy,
            "next_auto_run_at": _serialize_time(compute_next_auto_run_at(policy)),
            "phase_plan": self._get_plan(),
            "phase_stats": await self._get_phase_stats_cached(force=force_stats),
            "identity_summary": self._serialize_identity_summary(summary),
            "identities": self._serialize_identity_rows(identities),
            "recent_runs": [self._serialize_run(item) for item in runs],
            "current_run": self.get_current_run_snapshot(),
            "scheduler": self.get_scheduler_snapshot(),
        }

    async def start_sync(
        self,
        triggered_by: str,
        trigger_mode: str = "manual",
        phase_key: str = "",
        dry_run: bool = False,
        limit_per_spec: int | None = None,
    ) -> dict[str, Any]:
        await self.initialize_schema()
        async with self._run_lock:
            if self._active_task is not None and not self._active_task.done():
                return {
                    "success": False,
                    "started": False,
                    "message": "已有账号迁移同步任务在运行",
                    "current_run": self.get_current_run_snapshot(),
                }
            normalized_phase_key = self._normalize_phase_key(phase_key)
            normalized_limit = max(0, int(limit_per_spec if limit_per_spec is not None else (await self.get_policy()).get("limit_per_spec", 0)))
            pending_specs = await self._find_pending(phase_key=normalized_phase_key)
            if not pending_specs:
                return {
                    "success": True,
                    "started": False,
                    "skipped": True,
                    "message": "暂无待同步的账号数据",
                    "current_run": None,
                }
            pending_spec_keys = {
                (
                    str(item.get("table_name") or ""),
                    str(item.get("username_column") or ""),
                    str(item.get("account_id_column") or ""),
                )
                for item in pending_specs
                if isinstance(item, dict)
            }
            if not pending_spec_keys:
                return {
                    "success": True,
                    "started": False,
                    "skipped": True,
                    "message": "暂无待同步的账号数据",
                    "current_run": None,
                }
            run_id = await self.repository.create_sync_run(
                trigger_mode=str(trigger_mode or "manual"),
                triggered_by=str(triggered_by or ""),
                phase_key=normalized_phase_key or "all",
                dry_run=bool(dry_run),
                limit_per_spec=normalized_limit,
            )
            self._current_run = {
                "id": run_id,
                "trigger_mode": str(trigger_mode or "manual"),
                "triggered_by": str(triggered_by or ""),
                "phase_key": normalized_phase_key or "all",
                "dry_run": bool(dry_run),
                "limit_per_spec": normalized_limit,
                "status": "running",
                "stage": "queued",
                "started_at": datetime.now(),
                "updated_at": datetime.now(),
                "summary": {},
                "error_message": "",
            }
            self._active_task = asyncio.create_task(
                self._execute_sync_run(
                    run_id=run_id,
                    trigger_mode=str(trigger_mode or "manual"),
                    triggered_by=str(triggered_by or ""),
                    phase_key=normalized_phase_key,
                    dry_run=bool(dry_run),
                    limit_per_spec=normalized_limit,
                    pending_specs=pending_specs,
                    pending_spec_keys=pending_spec_keys,
                ),
                name=f"account-identity-sync-{run_id}",
            )
        return {
            "success": True,
            "started": True,
            "message": "账号迁移同步任务已启动",
            "current_run": self.get_current_run_snapshot(),
        }

    def get_current_run_snapshot(self) -> dict[str, Any] | None:
        if not isinstance(self._current_run, dict):
            return None
        data = copy.deepcopy(self._current_run)
        data["started_at"] = _serialize_time(data.get("started_at"))
        data["updated_at"] = _serialize_time(data.get("updated_at"))
        return data

    def get_scheduler_snapshot(self) -> dict[str, Any] | None:
        if self._scheduler is None or not hasattr(self._scheduler, "snapshot"):
            return None
        try:
            return self._scheduler.snapshot()
        except Exception:
            return None

    async def _execute_sync_run(
        self,
        run_id: int,
        trigger_mode: str,
        triggered_by: str,
        phase_key: str,
        dry_run: bool,
        limit_per_spec: int,
        pending_specs: list[dict[str, Any]],
        pending_spec_keys: set[tuple[str, str, str]],
    ) -> None:
        summary: dict[str, Any] = {
            "phase_key": phase_key or "all",
            "dry_run": bool(dry_run),
            "limit_per_spec": int(limit_per_spec or 0),
            "trigger_mode": str(trigger_mode or "manual"),
            "triggered_by": str(triggered_by or ""),
            "plan": self._get_plan(),
            "pending_specs": copy.deepcopy(pending_specs),
        }
        final_status = "succeeded"
        error_message = ""
        try:
            self._touch_current_run(stage="backfilling", summary=summary)
            backfill_results = await self._backfill(
                phase_key=phase_key,
                limit_per_spec=limit_per_spec,
                dry_run=dry_run,
                spec_keys=pending_spec_keys,
            )
            summary["backfill_results"] = backfill_results
        except Exception as exc:
            final_status = "failed"
            error_message = str(exc or "")[:2000]
            summary["error"] = error_message
            if self._logger is not None:
                self._logger.warning(f"[AccountIdentitySync] run failed id={run_id} phase={phase_key or 'all'}: {exc}")
        finally:
            summary["finished_at"] = _serialize_time(datetime.now())
            await self.repository.finish_sync_run(
                run_id=run_id,
                status=final_status,
                summary=summary,
                error_message=error_message,
            )
            self._phase_stats_cache["expires_at"] = 0.0
            self._touch_current_run(
                stage="finished",
                status=final_status,
                summary=summary,
                error_message=error_message,
            )
            self._current_run = None
            self._active_task = None

    async def _get_phase_stats_cached(self, force: bool = False) -> list[dict[str, Any]]:
        now = time.time()
        if not force and now < float(self._phase_stats_cache.get("expires_at") or 0):
            return copy.deepcopy(self._phase_stats_cache.get("items") or [])
        items = await self._collect_stats(phase_key="")
        rows = []
        for item in items or []:
            candidate_rows = int(item.get("candidate_rows") or 0)
            filled_rows = int(item.get("filled_rows") or 0)
            missing_rows = int(item.get("missing_rows") or 0)
            fill_ratio = round((filled_rows / candidate_rows) * 100, 2) if candidate_rows > 0 else 100.0
            rows.append({
                "phase": str(item.get("phase") or ""),
                "table_name": str(item.get("table_name") or ""),
                "username_column": str(item.get("username_column") or ""),
                "account_id_column": str(item.get("account_id_column") or ""),
                "description": str(item.get("description") or ""),
                "status": str(item.get("status") or ""),
                "candidate_rows": candidate_rows,
                "filled_rows": filled_rows,
                "missing_rows": missing_rows,
                "fill_ratio": fill_ratio,
            })
        self._phase_stats_cache = {
            "expires_at": now + _PHASE_STATS_CACHE_SECONDS,
            "items": rows,
        }
        return copy.deepcopy(rows)

    def _touch_current_run(
        self,
        *,
        stage: str,
        status: str = "running",
        summary: dict[str, Any] | None = None,
        error_message: str = "",
    ) -> None:
        if not isinstance(self._current_run, dict):
            return
        self._current_run["stage"] = str(stage or "")
        self._current_run["status"] = str(status or "running")
        self._current_run["summary"] = copy.deepcopy(summary or {})
        self._current_run["error_message"] = str(error_message or "")
        self._current_run["updated_at"] = datetime.now()

    def _serialize_identity_summary(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "total_identities": int(row.get("total_identities") or 0),
            "total_aliases": int(row.get("total_aliases") or 0),
            "changed_identities": int(row.get("changed_identities") or 0),
            "last_renamed_at": _serialize_time(row.get("last_renamed_at")),
        }

    def _serialize_identity_rows(self, payload: dict[str, Any]) -> dict[str, Any]:
        rows = []
        for item in payload.get("rows") or []:
            aliases = [str(alias or "").strip().lower() for alias in (item.get("aliases") or []) if str(alias or "").strip()]
            rows.append({
                "account_id": int(item.get("account_id") or 0),
                "canonical_username": str(item.get("canonical_username") or "").strip().lower(),
                "alias_count": int(item.get("alias_count") or len(aliases)),
                "aliases": aliases,
                "created_at": _serialize_time(item.get("created_at")),
                "updated_at": _serialize_time(item.get("updated_at")),
                "last_renamed_at": _serialize_time(item.get("last_renamed_at")),
            })
        return {
            "total": int(payload.get("total") or 0),
            "rows": rows,
        }

    def _serialize_run(self, item: dict[str, Any]) -> dict[str, Any]:
        summary = item.get("summary_json")
        if not isinstance(summary, dict):
            summary = {}
        return {
            "id": int(item.get("id") or 0),
            "trigger_mode": str(item.get("trigger_mode") or ""),
            "triggered_by": str(item.get("triggered_by") or ""),
            "phase_key": str(item.get("phase_key") or "all"),
            "dry_run": bool(item.get("dry_run")),
            "limit_per_spec": int(item.get("limit_per_spec") or 0),
            "status": str(item.get("status") or ""),
            "summary": summary,
            "error_message": str(item.get("error_message") or ""),
            "started_at": _serialize_time(item.get("started_at")),
            "finished_at": _serialize_time(item.get("finished_at")),
        }

    @staticmethod
    def _normalize_phase_key(value: str) -> str:
        text = str(value or "").strip().lower()
        if not text or text == "all":
            return ""
        if text not in _ALL_PHASE_KEYS:
            raise ValueError("未知同步阶段")
        return text


def _normalize_daily_time(value: str) -> str:
    try:
        hour, minute = _split_daily_time(value)
        return f"{hour:02d}:{minute:02d}"
    except Exception:
        return ""


def _split_daily_time(value: str) -> tuple[int, int]:
    text = str(value or "").strip()
    if ":" not in text:
        raise ValueError("invalid daily time")
    left, right = text.split(":", 1)
    hour = int(left)
    minute = int(right)
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        raise ValueError("invalid daily time range")
    return hour, minute


def _serialize_time(value: Any) -> str:
    if not value:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat(sep=" ", timespec="seconds")
    return str(value)
