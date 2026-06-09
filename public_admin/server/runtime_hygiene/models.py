import os
from dataclasses import dataclass
from typing import Any


def env_bool(name: str, default: bool) -> bool:
    raw = str(os.environ.get(name, "")).strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return bool(default)


def env_float(name: str, default: float, minimum: float = 0.0, maximum: float | None = None) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except Exception:
        value = float(default)
    value = max(float(minimum), value)
    if maximum is not None:
        value = min(float(maximum), value)
    return value


def env_int(name: str, default: int, minimum: int = 0, maximum: int | None = None) -> int:
    try:
        value = int(float(os.environ.get(name, str(default))))
    except Exception:
        value = int(default)
    value = max(int(minimum), value)
    if maximum is not None:
        value = min(int(maximum), value)
    return value


def _bool_value(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        raw = value.strip().lower()
        if raw in {"1", "true", "yes", "on"}:
            return True
        if raw in {"0", "false", "no", "off"}:
            return False
    if isinstance(value, (int, float)):
        return bool(value)
    return bool(default)


def _float_value(value: Any, default: float, minimum: float, maximum: float | None = None) -> float:
    try:
        result = float(value)
    except Exception:
        result = float(default)
    result = max(float(minimum), result)
    if maximum is not None:
        result = min(float(maximum), result)
    return result


def _int_value(value: Any, default: int, minimum: int, maximum: int | None = None) -> int:
    try:
        result = int(float(value))
    except Exception:
        result = int(default)
    result = max(int(minimum), result)
    if maximum is not None:
        result = min(int(maximum), result)
    return result


@dataclass(frozen=True)
class RuntimeHygienePolicy:
    enabled: bool = env_bool("AK_RUNTIME_HYGIENE_ENABLED", True)
    cleanup_interval_seconds: float = env_float("AK_RUNTIME_HYGIENE_INTERVAL_SECONDS", 300.0, 5.0, 86400.0)
    initial_delay_seconds: float = env_float("AK_RUNTIME_HYGIENE_INITIAL_DELAY_SECONDS", 60.0, 0.0, 3600.0)
    ak_web_client_max_age_seconds: float = env_float("AK_AK_WEB_CLIENT_MAX_AGE_SECONDS", 900.0, 60.0, 86400.0)
    ak_web_client_max_requests: int = env_int("AK_AK_WEB_CLIENT_MAX_REQUESTS", 800, 10, 100000)
    ak_web_client_idle_seconds: float = env_float("AK_AK_WEB_CLIENT_IDLE_SECONDS", 300.0, 30.0, 86400.0)
    outbound_client_max_age_seconds: float = env_float("AK_OUTBOUND_CLIENT_MAX_AGE_SECONDS", 900.0, 60.0, 86400.0)
    outbound_client_max_requests: int = env_int("AK_OUTBOUND_CLIENT_MAX_REQUESTS", 800, 10, 100000)
    outbound_client_idle_seconds: float = env_float("AK_OUTBOUND_CLIENT_IDLE_SECONDS", 300.0, 30.0, 86400.0)
    cleanup_browse_sessions_enabled: bool = env_bool("AK_RUNTIME_CLEANUP_BROWSE_SESSIONS", True)
    cleanup_ak_auth_cache_enabled: bool = env_bool("AK_RUNTIME_CLEANUP_AK_AUTH_CACHE", True)
    cleanup_static_cache_locks_enabled: bool = env_bool("AK_RUNTIME_CLEANUP_STATIC_CACHE_LOCKS", True)
    cleanup_ws_tickets_enabled: bool = env_bool("AK_RUNTIME_CLEANUP_WS_TICKETS", True)

    @classmethod
    def from_mapping(cls, payload: dict[str, Any] | None) -> "RuntimeHygienePolicy":
        defaults = cls()
        data = payload if isinstance(payload, dict) else {}
        return cls(
            enabled=_bool_value(data.get("enabled"), defaults.enabled),
            cleanup_interval_seconds=_float_value(
                data.get("cleanup_interval_seconds"),
                defaults.cleanup_interval_seconds,
                5.0,
                86400.0,
            ),
            initial_delay_seconds=_float_value(
                data.get("initial_delay_seconds"),
                defaults.initial_delay_seconds,
                0.0,
                3600.0,
            ),
            ak_web_client_max_age_seconds=_float_value(
                data.get("ak_web_client_max_age_seconds"),
                defaults.ak_web_client_max_age_seconds,
                60.0,
                86400.0,
            ),
            ak_web_client_max_requests=_int_value(
                data.get("ak_web_client_max_requests"),
                defaults.ak_web_client_max_requests,
                10,
                100000,
            ),
            ak_web_client_idle_seconds=_float_value(
                data.get("ak_web_client_idle_seconds"),
                defaults.ak_web_client_idle_seconds,
                30.0,
                86400.0,
            ),
            outbound_client_max_age_seconds=_float_value(
                data.get("outbound_client_max_age_seconds"),
                defaults.outbound_client_max_age_seconds,
                60.0,
                86400.0,
            ),
            outbound_client_max_requests=_int_value(
                data.get("outbound_client_max_requests"),
                defaults.outbound_client_max_requests,
                10,
                100000,
            ),
            outbound_client_idle_seconds=_float_value(
                data.get("outbound_client_idle_seconds"),
                defaults.outbound_client_idle_seconds,
                30.0,
                86400.0,
            ),
            cleanup_browse_sessions_enabled=_bool_value(
                data.get("cleanup_browse_sessions_enabled"),
                defaults.cleanup_browse_sessions_enabled,
            ),
            cleanup_ak_auth_cache_enabled=_bool_value(
                data.get("cleanup_ak_auth_cache_enabled"),
                defaults.cleanup_ak_auth_cache_enabled,
            ),
            cleanup_static_cache_locks_enabled=_bool_value(
                data.get("cleanup_static_cache_locks_enabled"),
                defaults.cleanup_static_cache_locks_enabled,
            ),
            cleanup_ws_tickets_enabled=_bool_value(
                data.get("cleanup_ws_tickets_enabled"),
                defaults.cleanup_ws_tickets_enabled,
            ),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "cleanup_interval_seconds": self.cleanup_interval_seconds,
            "initial_delay_seconds": self.initial_delay_seconds,
            "ak_web_client_max_age_seconds": self.ak_web_client_max_age_seconds,
            "ak_web_client_max_requests": self.ak_web_client_max_requests,
            "ak_web_client_idle_seconds": self.ak_web_client_idle_seconds,
            "outbound_client_max_age_seconds": self.outbound_client_max_age_seconds,
            "outbound_client_max_requests": self.outbound_client_max_requests,
            "outbound_client_idle_seconds": self.outbound_client_idle_seconds,
            "cleanup_browse_sessions_enabled": self.cleanup_browse_sessions_enabled,
            "cleanup_ak_auth_cache_enabled": self.cleanup_ak_auth_cache_enabled,
            "cleanup_static_cache_locks_enabled": self.cleanup_static_cache_locks_enabled,
            "cleanup_ws_tickets_enabled": self.cleanup_ws_tickets_enabled,
        }
