import inspect
import time
from typing import Any, Awaitable, Callable

from .models import RequestMetricsPolicy


REQUEST_METRICS_CONFIG_KEY = "request_metrics_policy"

ApplyPolicyCallback = Callable[[RequestMetricsPolicy], None | Awaitable[None]]


class RequestMetricsConfigService:
    def __init__(
        self,
        system_config,
        metrics_service,
        apply_policy: ApplyPolicyCallback | None = None,
        logger=None,
        refresh_interval_seconds: float = 10.0,
    ):
        self._system_config = system_config
        self._metrics_service = metrics_service
        self._apply_policy = apply_policy
        self._logger = logger
        self._refresh_interval_seconds = max(1.0, float(refresh_interval_seconds or 10.0))
        self._last_refresh_at = 0.0
        self._last_policy_payload = RequestMetricsPolicy().to_dict()

    async def get_policy_payload(self) -> dict[str, Any]:
        payload = RequestMetricsPolicy().to_dict()
        try:
            saved = await self._system_config.get(REQUEST_METRICS_CONFIG_KEY, None)
            if isinstance(saved, dict):
                payload.update(saved)
        except Exception as exc:
            if self._logger:
                self._logger.warning("[RequestMetrics] read config failed, using defaults: %s", exc)
        return RequestMetricsPolicy.from_mapping(payload).to_dict()

    async def set_policy_payload(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        policy = RequestMetricsPolicy.from_mapping(payload or {})
        saved = policy.to_dict()
        ok = await self._system_config.set(REQUEST_METRICS_CONFIG_KEY, saved, "Request metrics policy")
        if not ok:
            raise RuntimeError("save request metrics policy failed")
        await self.apply_policy(policy)
        self._last_policy_payload = dict(saved)
        self._last_refresh_at = time.time()
        return saved

    async def refresh_policy(self, force: bool = False) -> dict[str, Any]:
        now = time.time()
        if not force and self._last_refresh_at > 0 and now - self._last_refresh_at < self._refresh_interval_seconds:
            return dict(self._last_policy_payload)
        payload = await self.get_policy_payload()
        await self.apply_policy(RequestMetricsPolicy.from_mapping(payload))
        self._last_policy_payload = dict(payload)
        self._last_refresh_at = now
        return payload

    async def snapshot(self, limit: int = 80, force_refresh: bool = False) -> dict[str, Any]:
        await self.refresh_policy(force=force_refresh)
        return self._metrics_service.snapshot(limit=limit)

    async def apply_policy(self, policy: RequestMetricsPolicy) -> None:
        if self._metrics_service is not None:
            self._metrics_service.update_policy(policy.to_dict())
        if self._apply_policy is None:
            return
        result = self._apply_policy(policy)
        if inspect.isawaitable(result):
            await result
