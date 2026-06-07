import inspect
import time
from typing import Any, Awaitable, Callable

from .models import RuntimeHygienePolicy


RUNTIME_HYGIENE_CONFIG_KEY = "runtime_hygiene_policy"

ApplyPolicyCallback = Callable[[RuntimeHygienePolicy], None | Awaitable[None]]


class RuntimeHygieneConfigService:
    def __init__(
        self,
        system_config,
        apply_policy: ApplyPolicyCallback | None = None,
        logger=None,
        refresh_interval_seconds: float = 5.0,
    ):
        self._system_config = system_config
        self._apply_policy = apply_policy
        self._logger = logger
        self._refresh_interval_seconds = max(1.0, float(refresh_interval_seconds or 5.0))
        self._last_refresh_at = 0.0

    async def get_policy_payload(self) -> dict[str, Any]:
        payload = RuntimeHygienePolicy().to_dict()
        try:
            saved = await self._system_config.get(RUNTIME_HYGIENE_CONFIG_KEY, None)
            if isinstance(saved, dict):
                payload.update(saved)
        except Exception as exc:
            if self._logger:
                self._logger.warning("[RuntimeHygiene] read config failed, using defaults: %s", exc)
        return RuntimeHygienePolicy.from_mapping(payload).to_dict()

    async def set_policy_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        policy = RuntimeHygienePolicy.from_mapping(payload or {})
        saved = policy.to_dict()
        ok = await self._system_config.set(RUNTIME_HYGIENE_CONFIG_KEY, saved, "Runtime hygiene policy")
        if not ok:
            raise RuntimeError("save runtime hygiene policy failed")
        await self.apply_policy(policy)
        self._last_refresh_at = time.time()
        return saved

    async def refresh_policy(self, force: bool = False) -> dict[str, Any]:
        now = time.time()
        if not force and now - self._last_refresh_at < self._refresh_interval_seconds:
            return await self.get_policy_payload()
        payload = await self.get_policy_payload()
        await self.apply_policy(RuntimeHygienePolicy.from_mapping(payload))
        self._last_refresh_at = now
        return payload

    async def apply_policy(self, policy: RuntimeHygienePolicy) -> None:
        if self._apply_policy is None:
            return
        result = self._apply_policy(policy)
        if inspect.isawaitable(result):
            await result
