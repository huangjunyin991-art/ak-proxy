from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date
from typing import Any
from urllib.parse import urlparse


CONFIG_DEFAULTS = {
    "enabled": True,
    "request_interval_ms": 1000,
    "fallback_username": "",
    "summary_retention_days": 365,
    "buyer_retention_days": 30,
    "post_task_check_interval_minutes": 60,
    "forbidden_cooldown_seconds": 300,
    "retry_rounds": 10,
    "pipeline_concurrency": 2,
    "save_buyers": True,
    "buyer_page_size": 15,
    "buyer_max_pages": 20,
    "default_target_date": "2026-05-29",
    "base_stat_date": "2026-06-01",
    "upstream_base_url": "http://127.0.0.1:8080",
    "upstream_public_origin": "https://ak2025.vip",
    "upstream_host_header": "ak2025.vip",
    "upstream_timeout_seconds": 12,
    "upstream_retry_attempts": 1,
    "upstream_retry_backoff_ms": 1200,
}


@dataclass(frozen=True)
class AkDataConfig:
    enabled: bool = True
    request_interval_ms: int = 1000
    fallback_username: str = ""
    summary_retention_days: int = 365
    buyer_retention_days: int = 30
    post_task_check_interval_minutes: int = 60
    forbidden_cooldown_seconds: int = 300
    retry_rounds: int = 10
    pipeline_concurrency: int = 2
    save_buyers: bool = True
    buyer_page_size: int = 15
    buyer_max_pages: int = 20
    default_target_date: str = "2026-05-29"
    base_stat_date: str = "2026-06-01"
    upstream_base_url: str = "http://127.0.0.1:8080"
    upstream_public_origin: str = "https://ak2025.vip"
    upstream_host_header: str = "ak2025.vip"
    upstream_timeout_seconds: int = 12
    upstream_retry_attempts: int = 1
    upstream_retry_backoff_ms: int = 1200

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def parse_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on", "启用"}:
        return True
    if text in {"0", "false", "no", "off", "禁用"}:
        return False
    return default


def parse_int(value: Any, default: int, low: int, high: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(low, min(high, parsed))


def parse_date_text(value: Any, default: str) -> str:
    text = str(value or "").strip()
    try:
        return date.fromisoformat(text).isoformat()
    except Exception:
        return default


def parse_url_text(value: Any, default: str, max_length: int = 200) -> str:
    text = str(value or "").strip().rstrip("/")
    if not text:
        return default
    lowered = text.lower()
    if not (lowered.startswith("http://") or lowered.startswith("https://")):
        return default
    return text[:max_length]


def parse_upstream_base_url(value: Any, default: str) -> str:
    text = parse_url_text(value, default)
    try:
        parsed = urlparse(text)
    except Exception:
        return default
    host = (parsed.hostname or "").lower()
    allowed_hosts = {"127.0.0.1", "localhost", "ak2025.vip", "k937.com", "www.k937.com"}
    if host not in allowed_hosts:
        return default
    return text


def parse_host_text(value: Any, default: str) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return default
    allowed = set("abcdefghijklmnopqrstuvwxyz0123456789.-:")
    if any(ch not in allowed for ch in text):
        return default
    return text[:120]


def normalize_config(data: dict[str, Any] | None = None) -> AkDataConfig:
    raw = dict(CONFIG_DEFAULTS)
    if isinstance(data, dict):
        raw.update({k: v for k, v in data.items() if k in CONFIG_DEFAULTS})
    return AkDataConfig(
        enabled=parse_bool(raw.get("enabled"), bool(CONFIG_DEFAULTS["enabled"])),
        request_interval_ms=parse_int(raw.get("request_interval_ms"), 1000, 300, 10000),
        fallback_username=str(raw.get("fallback_username") or "").strip().lower()[:64],
        summary_retention_days=parse_int(raw.get("summary_retention_days"), 365, 1, 3650),
        buyer_retention_days=parse_int(raw.get("buyer_retention_days"), 30, 1, 3650),
        post_task_check_interval_minutes=parse_int(raw.get("post_task_check_interval_minutes"), 60, 1, 1440),
        forbidden_cooldown_seconds=parse_int(raw.get("forbidden_cooldown_seconds"), 300, 0, 86400),
        retry_rounds=parse_int(raw.get("retry_rounds"), 10, 1, 50),
        pipeline_concurrency=parse_int(raw.get("pipeline_concurrency"), 2, 1, 5),
        save_buyers=parse_bool(raw.get("save_buyers"), bool(CONFIG_DEFAULTS["save_buyers"])),
        buyer_page_size=parse_int(raw.get("buyer_page_size"), 15, 1, 100),
        buyer_max_pages=parse_int(raw.get("buyer_max_pages"), 20, 1, 200),
        default_target_date=parse_date_text(raw.get("default_target_date"), str(CONFIG_DEFAULTS["default_target_date"])),
        base_stat_date=parse_date_text(raw.get("base_stat_date"), str(CONFIG_DEFAULTS["base_stat_date"])),
        upstream_base_url=parse_upstream_base_url(raw.get("upstream_base_url"), str(CONFIG_DEFAULTS["upstream_base_url"])),
        upstream_public_origin=parse_url_text(raw.get("upstream_public_origin"), str(CONFIG_DEFAULTS["upstream_public_origin"])),
        upstream_host_header=parse_host_text(raw.get("upstream_host_header"), str(CONFIG_DEFAULTS["upstream_host_header"])),
        upstream_timeout_seconds=parse_int(raw.get("upstream_timeout_seconds"), 12, 3, 60),
        upstream_retry_attempts=parse_int(raw.get("upstream_retry_attempts"), 1, 1, 10),
        upstream_retry_backoff_ms=parse_int(raw.get("upstream_retry_backoff_ms"), 1200, 100, 10000),
    )
