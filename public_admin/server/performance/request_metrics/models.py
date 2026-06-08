import time
from dataclasses import dataclass
from typing import Any


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


def _int_value(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        result = int(float(value))
    except Exception:
        result = int(default)
    return max(int(minimum), min(int(maximum), result))


@dataclass(frozen=True)
class RequestMetricsPolicy:
    enabled: bool = False
    slow_threshold_ms: int = 800
    max_records: int = 200

    @classmethod
    def from_mapping(cls, payload: dict[str, Any] | None) -> "RequestMetricsPolicy":
        defaults = cls()
        data = payload if isinstance(payload, dict) else {}
        return cls(
            enabled=_bool_value(data.get("enabled"), defaults.enabled),
            slow_threshold_ms=_int_value(data.get("slow_threshold_ms"), defaults.slow_threshold_ms, 50, 60000),
            max_records=_int_value(data.get("max_records"), defaults.max_records, 20, 2000),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "slow_threshold_ms": self.slow_threshold_ms,
            "max_records": self.max_records,
        }


@dataclass(frozen=True)
class RequestMetricEvent:
    kind: str
    method: str
    path: str
    status_code: int = 0
    total_ms: int = 0
    upstream_ms: int = 0
    rewrite_ms: int = 0
    inject_ms: int = 0
    cache_state: str = "NONE"
    exit_name: str = ""
    content_type: str = ""
    response_bytes: int = 0
    error: str = ""
    ts: float = 0.0

    @classmethod
    def from_mapping(cls, payload: dict[str, Any] | None) -> "RequestMetricEvent":
        data = payload if isinstance(payload, dict) else {}
        return cls(
            kind=_trim(data.get("kind"), 32) or "unknown",
            method=_trim(data.get("method"), 12).upper() or "GET",
            path=_trim(data.get("path"), 240) or "-",
            status_code=_int_value(data.get("status_code"), 0, 0, 999),
            total_ms=_int_value(data.get("total_ms"), 0, 0, 3600000),
            upstream_ms=_int_value(data.get("upstream_ms"), 0, 0, 3600000),
            rewrite_ms=_int_value(data.get("rewrite_ms"), 0, 0, 3600000),
            inject_ms=_int_value(data.get("inject_ms"), 0, 0, 3600000),
            cache_state=_trim(data.get("cache_state"), 24).upper() or "NONE",
            exit_name=_trim(data.get("exit_name"), 80),
            content_type=_trim(data.get("content_type"), 120),
            response_bytes=_int_value(data.get("response_bytes"), 0, 0, 10 * 1024 * 1024 * 1024),
            error=_trim(data.get("error"), 240),
            ts=float(data.get("ts") or time.time()),
        )

    def to_dict(self, sequence: int = 0) -> dict[str, Any]:
        return {
            "id": sequence,
            "kind": self.kind,
            "method": self.method,
            "path": self.path,
            "status_code": self.status_code,
            "total_ms": self.total_ms,
            "upstream_ms": self.upstream_ms,
            "rewrite_ms": self.rewrite_ms,
            "inject_ms": self.inject_ms,
            "cache_state": self.cache_state,
            "exit_name": self.exit_name,
            "content_type": self.content_type,
            "response_bytes": self.response_bytes,
            "error": self.error,
            "ts": self.ts,
        }


def _trim(value: Any, limit: int) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 3)] + "..."
