import time
from typing import Awaitable, Callable

from .models import ActiveDefenseDecision, ActiveDefensePolicy
from .runtime_store import ActiveDefenseRuntimeStore


BanCallback = Callable[[str, int, str, int, int, bool], Awaitable[dict]]


class ActiveDefenseService:
    def __init__(self, policy: ActiveDefensePolicy | None = None, store: ActiveDefenseRuntimeStore | None = None):
        self._policy = policy or ActiveDefensePolicy()
        self._store = store or ActiveDefenseRuntimeStore()

    def update_policy(self, policy: ActiveDefensePolicy) -> None:
        self._policy = policy

    def get_policy(self) -> ActiveDefensePolicy:
        return self._policy

    def clear_runtime(self) -> None:
        self._store.clear_all()

    def snapshot(self) -> dict:
        self._prune_runtime(force=True)
        return {
            "policy": self._policy.to_dict(),
            "runtime": self._store.snapshot(),
        }

    async def check_login_request(
        self,
        ip: str,
        endpoint: str,
        *,
        is_loopback: Callable[[str], bool],
        is_banned: Callable[[str], Awaitable[bool]],
        ban_ip: BanCallback,
    ) -> ActiveDefenseDecision:
        policy = self._policy
        normalized_ip = str(ip or "").strip()
        if not self._should_track_ip(normalized_ip, policy, is_loopback):
            return ActiveDefenseDecision(allowed=True, code="ignored", event_type="login_short_interval", ip=normalized_ip)
        if not policy.enabled or not policy.login_short_interval_enabled:
            return ActiveDefenseDecision(allowed=True, code="disabled", event_type="login_short_interval", ip=normalized_ip)
        if await is_banned(normalized_ip):
            return ActiveDefenseDecision(allowed=False, code="already_banned", message="您的IP已被封禁", event_type="login_short_interval", ip=normalized_ip)

        self._prune_runtime()
        now = time.time()
        timestamps = self._store.get_recent_login_timestamps(normalized_ip, max(60, policy.login_min_interval_seconds))
        last_call_at = max(timestamps) if timestamps else 0
        interval_seconds = now - float(last_call_at) if last_call_at else 0.0
        if last_call_at and interval_seconds < policy.login_min_interval_seconds:
            count = self._store.record_login_short_interval(normalized_ip)
            if count >= policy.login_short_interval_ban_threshold:
                reason = f"连续{count}次低于{policy.login_min_interval_seconds}秒调用登录接口: {endpoint}"
                decision = await self._ban(
                    normalized_ip,
                    count,
                    reason,
                    "login_short_interval_banned",
                    "login_short_interval",
                    ban_ip,
                )
                self._store.clear_login_short_interval(normalized_ip)
                return decision
            if policy.login_short_interval_block_enabled:
                return ActiveDefenseDecision(
                    allowed=False,
                    code="blocked_short_interval",
                    message=f"登录请求过于频繁，请{max(1, int(policy.login_min_interval_seconds - interval_seconds))}秒后重试",
                    event_type="login_short_interval",
                    ip=normalized_ip,
                    count=count,
                    threshold=policy.login_short_interval_ban_threshold,
                )
        count = self._store.record_login_allowed(normalized_ip, now)
        return ActiveDefenseDecision(allowed=True, code="ok", event_type="login_short_interval", ip=normalized_ip, count=count)

    async def record_login_forget_403(
        self,
        ip: str,
        api_path: str,
        *,
        is_loopback: Callable[[str], bool],
        is_banned: Callable[[str], Awaitable[bool]],
        ban_ip: BanCallback,
    ) -> ActiveDefenseDecision:
        policy = self._policy
        normalized_ip = str(ip or "").strip()
        if not self._should_track_ip(normalized_ip, policy, is_loopback):
            return ActiveDefenseDecision(allowed=True, code="ignored", event_type="login_forget_403", ip=normalized_ip)
        if not policy.enabled or not policy.login_403_enabled:
            return ActiveDefenseDecision(allowed=True, code="disabled", event_type="login_forget_403", ip=normalized_ip)
        if await is_banned(normalized_ip):
            self._store.reset_login_forget_403(normalized_ip)
            return ActiveDefenseDecision(allowed=False, code="already_banned", event_type="login_forget_403", ip=normalized_ip)
        self._prune_runtime()
        count = self._store.record_login_forget_403(normalized_ip)
        if count < policy.login_forget_403_threshold:
            return ActiveDefenseDecision(allowed=True, code="recorded", event_type="login_forget_403", ip=normalized_ip, count=count, threshold=policy.login_forget_403_threshold)
        reason = f"连续触发{api_path}上游403达到{count}次"
        decision = await self._ban(normalized_ip, count, reason, "login_forget_403_banned", "login_forget_403", ban_ip)
        self._store.reset_login_forget_403(normalized_ip)
        return decision

    def reset_login_forget_403(self, ip: str) -> None:
        normalized_ip = str(ip or "").strip()
        if normalized_ip:
            self._store.reset_login_forget_403(normalized_ip)

    async def record_login_403_account(
        self,
        ip: str,
        username: str,
        reason: str,
        *,
        is_loopback: Callable[[str], bool],
        is_banned: Callable[[str], Awaitable[bool]],
        ban_ip: BanCallback,
    ) -> ActiveDefenseDecision:
        policy = self._policy
        normalized_ip = str(ip or "").strip()
        normalized_username = str(username or "").strip().lower()
        if not self._should_track_ip(normalized_ip, policy, is_loopback) or not normalized_username or normalized_username == "unknown":
            return ActiveDefenseDecision(allowed=True, code="ignored", event_type="login_403_distinct_account", ip=normalized_ip)
        if not policy.enabled or not policy.login_403_enabled:
            return ActiveDefenseDecision(allowed=True, code="disabled", event_type="login_403_distinct_account", ip=normalized_ip)
        if await is_banned(normalized_ip):
            return ActiveDefenseDecision(allowed=False, code="already_banned", event_type="login_403_distinct_account", ip=normalized_ip)
        self._prune_runtime()
        count = self._store.record_login_403_account(normalized_ip, normalized_username, policy.login_403_window_seconds)
        if count < policy.login_403_distinct_account_threshold:
            return ActiveDefenseDecision(allowed=True, code="recorded", event_type="login_403_distinct_account", ip=normalized_ip, count=count, threshold=policy.login_403_distinct_account_threshold)
        trigger_reason = f"{policy.login_403_window_seconds}秒内{count}个不同账号登录失败: {reason}"
        decision = await self._ban(normalized_ip, count, trigger_reason, "login_403_distinct_account_banned", "login_403_distinct_account", ban_ip)
        self._store.clear_login_403_accounts(normalized_ip)
        return decision

    async def record_password_failure(
        self,
        ip: str,
        username: str,
        count_supplier: Callable[[str, str, int], Awaitable[int]],
        *,
        is_loopback: Callable[[str], bool],
        is_banned: Callable[[str], Awaitable[bool]],
        ban_ip: BanCallback,
    ) -> ActiveDefenseDecision:
        policy = self._policy
        normalized_ip = str(ip or "").strip()
        normalized_username = str(username or "").strip().lower()
        if not self._should_track_ip(normalized_ip, policy, is_loopback) or not normalized_username or normalized_username == "unknown":
            return ActiveDefenseDecision(allowed=True, code="ignored", event_type="password_failure", ip=normalized_ip)
        if not policy.enabled or not policy.password_failure_enabled:
            return ActiveDefenseDecision(allowed=True, code="disabled", event_type="password_failure", ip=normalized_ip)
        if await is_banned(normalized_ip):
            return ActiveDefenseDecision(allowed=False, code="already_banned", event_type="password_failure", ip=normalized_ip)
        count = await count_supplier(normalized_username, normalized_ip, policy.password_failure_window_hours)
        if count < policy.password_failure_ban_threshold:
            return ActiveDefenseDecision(allowed=True, code="recorded", event_type="password_failure", ip=normalized_ip, count=count, threshold=policy.password_failure_ban_threshold)
        reason = f"{policy.password_failure_window_hours}小时内同一IP对账号{normalized_username}连续密码错误{count}次"
        return await self._ban(normalized_ip, count, reason, "password_failure_banned", "password_failure", ban_ip)

    async def record_response_status(
        self,
        ip: str,
        path: str,
        method: str,
        status_code: int,
        *,
        is_loopback: Callable[[str], bool],
        is_banned: Callable[[str], Awaitable[bool]],
        ban_ip: BanCallback,
    ) -> ActiveDefenseDecision:
        policy = self._policy
        normalized_ip = str(ip or "").strip()
        status = int(status_code or 0)
        if not self._should_track_ip(normalized_ip, policy, is_loopback):
            return ActiveDefenseDecision(allowed=True, code="ignored", event_type="response_anomaly", ip=normalized_ip, status_code=status)
        if not policy.enabled or not policy.response_anomaly_enabled:
            return ActiveDefenseDecision(allowed=True, code="disabled", event_type="response_anomaly", ip=normalized_ip, status_code=status)
        if self._should_skip_path(path, policy):
            return ActiveDefenseDecision(allowed=True, code="skipped_path", event_type="response_anomaly", ip=normalized_ip, status_code=status)
        if status not in policy.response_anomaly_status_codes:
            if policy.response_anomaly_reset_on_clean:
                self._store.reset_response_anomaly(normalized_ip)
            return ActiveDefenseDecision(allowed=True, code="clean", event_type="response_anomaly", ip=normalized_ip, status_code=status)
        if await is_banned(normalized_ip):
            self._store.reset_response_anomaly(normalized_ip)
            return ActiveDefenseDecision(allowed=False, code="already_banned", event_type="response_anomaly", ip=normalized_ip, status_code=status)
        self._prune_runtime()
        count = self._store.record_response_anomaly(normalized_ip, status, policy.response_anomaly_window_seconds)
        if count < policy.response_anomaly_threshold:
            return ActiveDefenseDecision(allowed=True, code="recorded", event_type="response_anomaly", ip=normalized_ip, count=count, threshold=policy.response_anomaly_threshold, status_code=status)
        reason = f"{policy.response_anomaly_window_seconds}秒内连续触发HTTP {status}异常{count}次: {method} {path}"
        decision = await self._ban(normalized_ip, count, reason, "response_anomaly_banned", "response_anomaly", ban_ip)
        self._store.reset_response_anomaly(normalized_ip)
        return decision

    async def _ban(self, ip: str, count: int, reason: str, code: str, event_type: str, ban_ip: BanCallback) -> ActiveDefenseDecision:
        policy = self._policy
        result = await ban_ip(ip, count, reason, policy.ban_base_seconds, policy.ban_max_seconds, policy.progressive_ban_enabled)
        duration_seconds = int(result.get("duration_seconds") or 0)
        self._store.record_ban(ip, event_type, result.get("reason") or reason, count, duration_seconds)
        return ActiveDefenseDecision(
            allowed=False,
            code=code,
            message=result.get("reason") or reason,
            event_type=event_type,
            ip=ip,
            count=count,
            duration_seconds=duration_seconds,
            level=int(result.get("level") or 0),
            reason=result.get("reason") or reason,
        )

    @staticmethod
    def _should_track_ip(ip: str, policy: ActiveDefensePolicy, is_loopback: Callable[[str], bool]) -> bool:
        if not ip or ip == "unknown":
            return False
        if policy.ignore_loopback and is_loopback(ip):
            return False
        return True

    @staticmethod
    def _should_skip_path(path: str, policy: ActiveDefensePolicy) -> bool:
        normalized = str(path or "").split("?", 1)[0]
        if policy.response_anomaly_api_only and not (normalized.startswith("/admin/api/") or normalized.startswith("/api/") or normalized.startswith("/RPC/")):
            return True
        if not policy.response_anomaly_exclude_static:
            return False
        lowered = normalized.lower()
        static_prefixes = ("/static/", "/assets/", "/favicon", "/admin/api/monitoring-panel.css")
        static_suffixes = (".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".woff", ".woff2", ".ttf", ".map")
        return lowered.startswith(static_prefixes) or lowered.endswith(static_suffixes)

    def _prune_runtime(self, force: bool = False) -> None:
        policy = self._policy
        self._store.maybe_prune_expired(
            login_request_window_seconds=max(60, policy.login_min_interval_seconds),
            login_short_interval_window_seconds=max(60, policy.login_min_interval_seconds),
            login_forget_403_window_seconds=policy.login_403_window_seconds,
            login_403_window_seconds=policy.login_403_window_seconds,
            response_anomaly_window_seconds=policy.response_anomaly_window_seconds,
            force=force,
        )
