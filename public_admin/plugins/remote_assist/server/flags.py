import os
from dataclasses import dataclass


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class RemoteAssistFlags:
    enabled: bool
    enable_ak_web: bool
    readonly_only: bool
    enable_snapshot: bool
    session_ttl_seconds: int
    heartbeat_timeout_seconds: int
    max_sessions: int
    max_events_per_session: int



def load_flags() -> RemoteAssistFlags:
    return RemoteAssistFlags(
        enabled=_env_bool("AK_REMOTE_ASSIST_ENABLED", True),
        enable_ak_web=_env_bool("AK_REMOTE_ASSIST_AK_WEB_ENABLED", True),
        readonly_only=_env_bool("AK_REMOTE_ASSIST_READONLY_ONLY", True),
        enable_snapshot=_env_bool("AK_REMOTE_ASSIST_ENABLE_SNAPSHOT", False),
        session_ttl_seconds=_env_int("AK_REMOTE_ASSIST_SESSION_TTL", 1800),
        heartbeat_timeout_seconds=_env_int("AK_REMOTE_ASSIST_HEARTBEAT_TIMEOUT", 20),
        max_sessions=_env_int("AK_REMOTE_ASSIST_MAX_SESSIONS", 100),
        max_events_per_session=_env_int("AK_REMOTE_ASSIST_MAX_EVENTS", 200),
    )
