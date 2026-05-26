import time
from typing import Awaitable, Callable

from .models import LoginProtectionDecision, LoginProtectionPolicy
from .runtime_store import LoginProtectionRuntimeStore

BanCallback = Callable[[str, int, str, int], Awaitable[dict]]
LoopbackChecker = Callable[[str], bool]
BannedChecker = Callable[[str], Awaitable[bool]]


class LoginProtectionService:
    def __init__(self, policy: LoginProtectionPolicy | None = None,
                 store: LoginProtectionRuntimeStore | None = None):
        self._policy = policy or LoginProtectionPolicy()
        self._store = store or LoginProtectionRuntimeStore()

    def update_policy(self, policy: LoginProtectionPolicy) -> LoginProtectionPolicy:
        self._policy = policy
        return self._policy

    def get_policy(self) -> LoginProtectionPolicy:
        return self._policy

    def snapshot(self) -> dict:
        return {
            "policy": self._policy.to_dict(),
            "runtime": self._store.snapshot(),
        }

    async def check_and_record(self, client_ip: str, endpoint: str,
                               is_loopback: LoopbackChecker,
                               is_banned: BannedChecker,
                               ban_ip: BanCallback) -> LoginProtectionDecision:
        policy = self._policy
        normalized_ip = str(client_ip or "").strip()
        if not policy.enabled:
            return LoginProtectionDecision(allowed=True, code="disabled")
        if not normalized_ip or normalized_ip == "unknown":
            return LoginProtectionDecision(allowed=True, code="anonymous")
        if policy.ignore_loopback and is_loopback(normalized_ip):
            return LoginProtectionDecision(allowed=True, code="loopback")
        if await is_banned(normalized_ip):
            return LoginProtectionDecision(allowed=False, code="already_banned", message="您的IP已被封禁")

        now = time.time()
        timestamps = self._store.get_recent_timestamps(normalized_ip, policy.window_seconds)
        last_call_at = max(timestamps) if timestamps else 0
        interval_seconds = now - float(last_call_at) if last_call_at else 0.0

        if policy.short_interval_block_enabled and last_call_at and interval_seconds < policy.min_interval_seconds:
            short_count = self._store.record_short_interval(normalized_ip)
            if short_count >= policy.short_interval_ban_threshold:
                reason = f"连续{short_count}次低于{policy.min_interval_seconds}秒调用登录接口: {endpoint}"
                ban_result = await ban_ip(normalized_ip, short_count, reason, policy.ban_base_seconds)
                self._store.clear(normalized_ip)
                return LoginProtectionDecision(
                    allowed=False,
                    code="banned_short_interval",
                    message=ban_result.get("reason") or "登录请求过于频繁，您的IP已被封禁",
                    count=len(timestamps),
                    short_interval_count=short_count,
                    interval_seconds=interval_seconds,
                    duration_seconds=int(ban_result.get("duration_seconds") or 0),
                    level=int(ban_result.get("level") or 0),
                    reason=ban_result.get("reason") or reason,
                )
            return LoginProtectionDecision(
                allowed=False,
                code="blocked_short_interval",
                message=f"登录请求过于频繁，请{max(1, int(policy.min_interval_seconds - interval_seconds))}秒后重试",
                count=len(timestamps),
                short_interval_count=short_count,
                interval_seconds=interval_seconds,
            )

        count = self._store.record_allowed(normalized_ip, now)
        if count < policy.max_requests_per_window:
            return LoginProtectionDecision(allowed=True, code="ok", count=count)

        reason = f"{policy.window_seconds}秒内调用登录接口{count}次: {endpoint}"
        ban_result = await ban_ip(normalized_ip, count, reason, policy.ban_base_seconds)
        self._store.clear(normalized_ip)
        return LoginProtectionDecision(
            allowed=False,
            code="banned_window_rate",
            message=ban_result.get("reason") or "登录请求过于频繁，您的IP已被封禁",
            count=count,
            duration_seconds=int(ban_result.get("duration_seconds") or 0),
            level=int(ban_result.get("level") or 0),
            reason=ban_result.get("reason") or reason,
        )
