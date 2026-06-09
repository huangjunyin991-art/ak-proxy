import time
from typing import Any

from .blocking_pools import (
    apply_blocking_pool_policy,
    get_blocking_pools_snapshot,
    normalize_blocking_pool_policy,
)


BLOCKING_POOL_CONFIG_KEY = 'blocking_io_pool_policy'


class BlockingPoolConfigService:
    def __init__(self, system_config, logger=None, refresh_interval_seconds: float = 10.0):
        self._system_config = system_config
        self._logger = logger
        self._refresh_interval_seconds = max(1.0, float(refresh_interval_seconds or 10.0))
        self._last_refresh_at = 0.0
        self._last_policy_payload = normalize_blocking_pool_policy()

    async def get_policy_payload(self) -> dict[str, Any]:
        payload = normalize_blocking_pool_policy()
        if self._system_config is None:
            return payload
        try:
            saved = await self._system_config.get(BLOCKING_POOL_CONFIG_KEY, None)
            if isinstance(saved, dict):
                payload = normalize_blocking_pool_policy(saved)
        except Exception as exc:
            if self._logger:
                self._logger.warning('[BlockingPools] read config failed, using defaults: %s', exc)
        return payload

    async def set_policy_payload(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        if self._system_config is None:
            raise RuntimeError('system_config unavailable')
        policy = normalize_blocking_pool_policy(payload or {})
        ok = await self._system_config.set(BLOCKING_POOL_CONFIG_KEY, policy, 'Blocking IO pool policy')
        if not ok:
            raise RuntimeError('save blocking IO pool policy failed')
        apply_blocking_pool_policy(policy)
        self._last_policy_payload = dict(policy)
        self._last_refresh_at = time.time()
        return policy

    async def refresh_policy(self, force: bool = False) -> dict[str, Any]:
        now = time.time()
        if not force and self._last_refresh_at > 0 and now - self._last_refresh_at < self._refresh_interval_seconds:
            return dict(self._last_policy_payload)
        policy = await self.get_policy_payload()
        apply_blocking_pool_policy(policy)
        self._last_policy_payload = dict(policy)
        self._last_refresh_at = now
        return policy

    async def snapshot(self, force: bool = False) -> dict[str, Any]:
        await self.refresh_policy(force=force)
        return get_blocking_pools_snapshot()
