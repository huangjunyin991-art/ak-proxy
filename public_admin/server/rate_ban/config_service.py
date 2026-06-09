import time
from typing import Any

from .models import RateBanPolicy
from .service import RateBanService

RATE_BAN_CONFIG_KEY = "rate_ban_policy"


class RateBanConfigService:
    def __init__(
        self,
        system_config,
        rate_ban_service: RateBanService | None,
        logger=None,
        refresh_interval_seconds: float = 5.0,
    ):
        self._system_config = system_config
        self._rate_ban_service = rate_ban_service
        self._logger = logger
        self._refresh_interval_seconds = max(1.0, float(refresh_interval_seconds or 5.0))
        self._last_refresh_at = 0.0

    async def get_policy_payload(self) -> dict[str, Any]:
        payload = RateBanPolicy().to_dict()
        try:
            saved = await self._system_config.get(RATE_BAN_CONFIG_KEY, None)
            if isinstance(saved, dict):
                payload.update(saved)
        except Exception as exc:
            if self._logger:
                self._logger.warning(f"[RateBan] 读取策略配置失败，使用默认值: {exc}")
        return RateBanPolicy.from_mapping(payload).with_missing_default_rules().to_dict()

    async def set_policy_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        policy = RateBanPolicy.from_mapping(payload or {}).with_missing_default_rules()
        saved = policy.to_dict()
        ok = await self._system_config.set(RATE_BAN_CONFIG_KEY, saved, "限速封禁策略")
        if not ok:
            raise RuntimeError("保存限速封禁策略失败")
        self.apply_policy(policy)
        self._last_refresh_at = time.time()
        return saved

    async def refresh_policy(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_refresh_at < self._refresh_interval_seconds:
            return
        self.apply_policy(RateBanPolicy.from_mapping(await self.get_policy_payload()).with_missing_default_rules())
        self._last_refresh_at = now

    def apply_policy(self, policy: RateBanPolicy) -> None:
        if self._rate_ban_service is not None:
            self._rate_ban_service.update_policy(policy)

    async def snapshot(self) -> dict[str, Any]:
        payload = await self.get_policy_payload()
        if self._rate_ban_service is None:
            return {"policy": payload, "runtime": {}, "available": False}
        policy = RateBanPolicy.from_mapping(payload).with_missing_default_rules()
        self.apply_policy(policy)
        self._last_refresh_at = time.time()
        snapshot = self._rate_ban_service.snapshot()
        snapshot["available"] = True
        return snapshot

    def clear_runtime(self) -> dict[str, Any]:
        if self._rate_ban_service is None:
            return {"success": False, "message": "限速封禁模块不可用"}
        store = self._rate_ban_service._store
        with store._lock:
            store.ip_timestamps.clear()
            store.last_ban.clear()
        return {"success": True, "runtime": self._rate_ban_service.snapshot().get("runtime", {})}
