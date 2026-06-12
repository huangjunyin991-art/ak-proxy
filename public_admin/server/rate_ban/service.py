import time
import logging
from typing import Callable, Awaitable

from .models import RateBanPolicy, RateBanRule, RateBanDecision
from .runtime_store import RateBanRuntimeStore

logger = logging.getLogger(__name__)

# Callback types reused from existing infrastructure
BanCallback = Callable[..., Awaitable[dict]]
LoopbackChecker = Callable[[str], bool]
BannedChecker = Callable[[str], Awaitable[bool]]


class RateBanService:
    def __init__(
        self,
        policy: RateBanPolicy | None = None,
        store: RateBanRuntimeStore | None = None,
    ):
        self._policy = (policy or RateBanPolicy()).with_missing_default_rules()
        self._store = store or RateBanRuntimeStore()

    def update_policy(self, policy: RateBanPolicy) -> None:
        self._policy = policy.with_missing_default_rules()

    def get_policy(self) -> RateBanPolicy:
        return self._policy

    def snapshot(self) -> dict:
        return {
            "policy": self._policy.to_dict(),
            "runtime": self._store.snapshot(),
        }

    async def check(
        self,
        client_ip: str,
        request_path: str,
        method: str,
        is_loopback: LoopbackChecker,
        is_banned: BannedChecker,
        ban_ip: BanCallback,
    ) -> RateBanDecision:
        policy = self._policy
        if not policy.enabled:
            return RateBanDecision(code="disabled")

        normalized_ip = str(client_ip or "").strip()
        if not normalized_ip or normalized_ip == "unknown":
            return RateBanDecision(code="anonymous")

        if policy.ignore_loopback and is_loopback(normalized_ip):
            return RateBanDecision(code="loopback")

        if await is_banned(normalized_ip):
            return RateBanDecision(allowed=False, code="already_banned", message="您的IP已被封禁")

        matched_rule = self._find_matched_rule(request_path, method)
        if matched_rule is None:
            return RateBanDecision(code="no_match")

        rule = matched_rule
        exceeded, count = self._store.record_and_check(
            normalized_ip,
            rule.id,
            rule.window_seconds,
            rule.requests_per_second,
        )

        if not exceeded:
            return RateBanDecision(allowed=True, code="ok", rule_id=rule.id, count=count)

        reason = f"接口 {request_path} 请求过于频繁（{count}次/{rule.window_seconds}秒），超过速率上限 {rule.requests_per_second} req/s"
        try:
            ban_result = await ban_ip(
                normalized_ip,
                count,
                reason,
                base_seconds=policy.ban_base_seconds,
                max_seconds=policy.ban_base_seconds * 10,
                progressive=True,
            )
            self._store.record_ban(
                normalized_ip,
                rule.id,
                reason,
                ban_result.get("duration_seconds", policy.ban_base_seconds),
            )
            return RateBanDecision(
                allowed=False,
                code="banned",
                rule_id=rule.id,
                message=ban_result.get("reason") or reason,
                count=count,
                duration_seconds=int(ban_result.get("duration_seconds") or policy.ban_base_seconds),
                remaining_seconds=int(ban_result.get("duration_seconds") or policy.ban_base_seconds),
                banned_until=str(ban_result.get("banned_until") or ""),
                level=int(ban_result.get("level") or 1),
                reason=reason,
            )
        except Exception as e:
            logger.warning(f"[RateBan] 封禁IP失败: {e}")
            return RateBanDecision(
                allowed=False,
                code="blocked",
                rule_id=rule.id,
                message=f"请求过于频繁，请稍后再试",
                count=count,
            )

    def _find_matched_rule(self, request_path: str, method: str) -> RateBanRule | None:
        matched: RateBanRule | None = None
        for rule in self._policy.rules:
            if not rule.enabled:
                continue
            if not request_path.startswith(rule.route_prefix):
                continue
            if rule.methods and method.upper() not in rule.methods:
                continue
            if matched is None or len(rule.route_prefix) > len(matched.route_prefix):
                matched = rule
        return matched
