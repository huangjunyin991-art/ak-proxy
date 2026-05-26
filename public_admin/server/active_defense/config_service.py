import time
from typing import Any

from .models import ActiveDefensePolicy
from .service import ActiveDefenseService


ACTIVE_DEFENSE_CONFIG_KEY = "active_defense_policy"
LOGIN_PROTECTION_CONFIG_KEY = "login_protection_policy"


def active_policy_to_login_protection_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "enabled": bool(payload.get("enabled", True)),
        "min_interval_seconds": int(payload.get("login_min_interval_seconds") or 5),
        "short_interval_block_enabled": bool(payload.get("login_short_interval_block_enabled", True)),
        "short_interval_ban_threshold": int(payload.get("login_short_interval_ban_threshold") or 3),
        "password_failure_window_hours": int(payload.get("password_failure_window_hours") or 24),
        "password_failure_ban_threshold": int(payload.get("password_failure_ban_threshold") or 15),
        "ban_base_seconds": int(payload.get("ban_base_seconds") or 3600),
        "ignore_loopback": bool(payload.get("ignore_loopback", True)),
    }


def merge_legacy_login_protection(payload: dict[str, Any], legacy: dict[str, Any] | None) -> dict[str, Any]:
    merged = dict(payload or {})
    if not isinstance(legacy, dict):
        return merged
    merged.update({
        "enabled": legacy.get("enabled", merged.get("enabled")),
        "ignore_loopback": legacy.get("ignore_loopback", merged.get("ignore_loopback")),
        "ban_base_seconds": legacy.get("ban_base_seconds", merged.get("ban_base_seconds")),
        "login_short_interval_block_enabled": legacy.get("short_interval_block_enabled", merged.get("login_short_interval_block_enabled")),
        "login_min_interval_seconds": legacy.get("min_interval_seconds", merged.get("login_min_interval_seconds")),
        "login_short_interval_ban_threshold": legacy.get("short_interval_ban_threshold", merged.get("login_short_interval_ban_threshold")),
        "password_failure_window_hours": legacy.get("password_failure_window_hours", merged.get("password_failure_window_hours")),
        "password_failure_ban_threshold": legacy.get("password_failure_ban_threshold", merged.get("password_failure_ban_threshold")),
    })
    return merged


class ActiveDefenseConfigService:
    def __init__(
        self,
        system_config,
        active_defense_service: ActiveDefenseService | None,
        login_protection_service=None,
        login_protection_policy_cls=None,
        logger=None,
        refresh_interval_seconds: float = 5.0,
    ):
        self._system_config = system_config
        self._active_defense_service = active_defense_service
        self._login_protection_service = login_protection_service
        self._login_protection_policy_cls = login_protection_policy_cls
        self._logger = logger
        self._refresh_interval_seconds = max(1.0, float(refresh_interval_seconds or 5.0))
        self._last_refresh_at = 0.0

    async def get_policy_payload(self) -> dict[str, Any]:
        payload = ActiveDefensePolicy().to_dict()
        try:
            saved = await self._system_config.get(ACTIVE_DEFENSE_CONFIG_KEY, None)
            if isinstance(saved, dict):
                payload.update(saved)
            else:
                legacy = await self._system_config.get(LOGIN_PROTECTION_CONFIG_KEY, None)
                payload = merge_legacy_login_protection(payload, legacy)
        except Exception as exc:
            if self._logger:
                self._logger.warning(f"[ActiveDefense] 读取策略配置失败，使用默认值: {exc}")
        return ActiveDefensePolicy.from_mapping(payload).to_dict()

    async def set_policy_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        policy = ActiveDefensePolicy.from_mapping(payload or {})
        saved = policy.to_dict()
        ok = await self._system_config.set(ACTIVE_DEFENSE_CONFIG_KEY, saved, "主动防御与自动封禁策略")
        if not ok:
            raise RuntimeError("保存主动防御策略失败")
        await self._system_config.set(
            LOGIN_PROTECTION_CONFIG_KEY,
            active_policy_to_login_protection_payload(saved),
            "登录接口防护策略",
        )
        self.apply_policy(policy)
        self._last_refresh_at = time.time()
        return saved

    async def refresh_policy(self, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._last_refresh_at < self._refresh_interval_seconds:
            return
        self.apply_policy(ActiveDefensePolicy.from_mapping(await self.get_policy_payload()))
        self._last_refresh_at = now

    def apply_policy(self, policy: ActiveDefensePolicy) -> None:
        if self._active_defense_service is not None:
            self._active_defense_service.update_policy(policy)
        if self._login_protection_service is not None and self._login_protection_policy_cls is not None:
            self._login_protection_service.update_policy(
                self._login_protection_policy_cls.from_mapping(active_policy_to_login_protection_payload(policy.to_dict()))
            )

    async def snapshot(self) -> dict[str, Any]:
        payload = await self.get_policy_payload()
        if self._active_defense_service is None:
            return {"policy": payload, "runtime": {}, "available": False}
        policy = ActiveDefensePolicy.from_mapping(payload)
        self.apply_policy(policy)
        self._last_refresh_at = time.time()
        snapshot = self._active_defense_service.snapshot()
        snapshot["available"] = True
        return snapshot

    def clear_runtime(self) -> dict[str, Any]:
        if self._active_defense_service is None:
            return {"success": False, "message": "主动防御模块不可用"}
        self._active_defense_service.clear_runtime()
        return {"success": True, "runtime": self._active_defense_service.snapshot().get("runtime", {})}
