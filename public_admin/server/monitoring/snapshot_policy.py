import time
from dataclasses import dataclass
from typing import Any


MONITORING_SNAPSHOT_POLICY_KEY = "monitoring_snapshot_policy"


def _bool_value(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on", "enabled"):
        return True
    if text in ("0", "false", "no", "off", "disabled"):
        return False
    return default


def _int_value(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(float(value))
    except Exception:
        parsed = default
    return max(minimum, min(maximum, parsed))


@dataclass(frozen=True)
class MonitoringSnapshotPolicy:
    light_refresh_seconds: int = 5
    heavy_refresh_minutes: int = 60
    background_enabled: bool = False
    high_load_skip: bool = True

    @classmethod
    def from_mapping(cls, data: dict[str, Any] | None) -> "MonitoringSnapshotPolicy":
        source = data or {}
        defaults = cls()
        return cls(
            light_refresh_seconds=_int_value(source.get("light_refresh_seconds"), defaults.light_refresh_seconds, 2, 300),
            heavy_refresh_minutes=_int_value(source.get("heavy_refresh_minutes"), defaults.heavy_refresh_minutes, 1, 24 * 60),
            background_enabled=_bool_value(source.get("background_enabled"), defaults.background_enabled),
            high_load_skip=_bool_value(source.get("high_load_skip"), defaults.high_load_skip),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "light_refresh_seconds": int(self.light_refresh_seconds),
            "heavy_refresh_minutes": int(self.heavy_refresh_minutes),
            "background_enabled": bool(self.background_enabled),
            "high_load_skip": bool(self.high_load_skip),
        }

    @property
    def light_ttl_seconds(self) -> int:
        return int(self.light_refresh_seconds)

    @property
    def heavy_ttl_seconds(self) -> int:
        return int(self.heavy_refresh_minutes) * 60


class MonitoringSnapshotPolicyStore:
    def __init__(self, system_config=None, logger=None, refresh_interval_seconds: float = 10.0):
        self._system_config = system_config
        self._logger = logger
        self._refresh_interval_seconds = max(1.0, float(refresh_interval_seconds or 10.0))
        self._last_refresh_at = 0.0
        self._last_payload = MonitoringSnapshotPolicy().to_dict()

    async def get_policy_payload(self) -> dict[str, Any]:
        payload = MonitoringSnapshotPolicy().to_dict()
        if self._system_config is None:
            return payload
        try:
            saved = await self._system_config.get(MONITORING_SNAPSHOT_POLICY_KEY, None)
            if isinstance(saved, dict):
                payload.update(saved)
        except Exception as exc:
            if self._logger:
                self._logger.warning("[MonitoringSnapshot] read policy failed, using defaults: %s", exc)
        return MonitoringSnapshotPolicy.from_mapping(payload).to_dict()

    async def refresh_policy(self, force: bool = False) -> dict[str, Any]:
        now = time.time()
        if not force and self._last_refresh_at > 0 and now - self._last_refresh_at < self._refresh_interval_seconds:
            return dict(self._last_payload)
        payload = await self.get_policy_payload()
        self._last_payload = dict(payload)
        self._last_refresh_at = now
        return payload

    async def set_policy_payload(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        policy = MonitoringSnapshotPolicy.from_mapping(payload or {})
        saved = policy.to_dict()
        if self._system_config is None:
            self._last_payload = dict(saved)
            self._last_refresh_at = time.time()
            return saved
        ok = await self._system_config.set(MONITORING_SNAPSHOT_POLICY_KEY, saved, "Monitoring snapshot refresh policy")
        if not ok:
            raise RuntimeError("save monitoring snapshot policy failed")
        self._last_payload = dict(saved)
        self._last_refresh_at = time.time()
        return saved
