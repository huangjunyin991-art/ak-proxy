from dataclasses import asdict, dataclass, field
from typing import Any


DEFAULT_STATUS_CODES = (403, 429)


def _int_range(value: Any, minimum: int, maximum: int, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def _bool(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _status_codes(value: Any) -> list[int]:
    if isinstance(value, str):
        raw_items = value.replace(";", ",").split(",")
    elif isinstance(value, (list, tuple, set)):
        raw_items = list(value)
    else:
        raw_items = list(DEFAULT_STATUS_CODES)
    codes: list[int] = []
    for item in raw_items:
        try:
            code = int(str(item).strip())
        except (TypeError, ValueError):
            continue
        if 100 <= code <= 599 and code not in codes:
            codes.append(code)
    return codes or list(DEFAULT_STATUS_CODES)


@dataclass(frozen=True)
class ActiveDefensePolicy:
    enabled: bool = True
    ignore_loopback: bool = True
    progressive_ban_enabled: bool = True
    ban_base_seconds: int = 3600
    ban_max_seconds: int = 30 * 86400

    login_short_interval_enabled: bool = True
    login_short_interval_block_enabled: bool = True
    login_min_interval_seconds: int = 5
    login_short_interval_ban_threshold: int = 3

    password_failure_enabled: bool = True
    password_failure_window_hours: int = 24
    password_failure_ban_threshold: int = 15

    login_403_enabled: bool = True
    login_403_window_seconds: int = 60
    login_403_distinct_account_threshold: int = 6
    login_forget_403_threshold: int = 20

    response_anomaly_enabled: bool = True
    response_anomaly_window_seconds: int = 60
    response_anomaly_threshold: int = 10
    response_anomaly_status_codes: list[int] = field(default_factory=lambda: list(DEFAULT_STATUS_CODES))
    response_anomaly_reset_on_clean: bool = True
    response_anomaly_api_only: bool = False
    response_anomaly_exclude_static: bool = True

    upstream_key_format_immediate_ban_enabled: bool = True
    upstream_key_format_burst_threshold: int = 30

    @classmethod
    def from_mapping(cls, payload: dict | None) -> "ActiveDefensePolicy":
        data = dict(payload or {})
        return cls(
            enabled=_bool(data.get("enabled"), True),
            ignore_loopback=_bool(data.get("ignore_loopback"), True),
            progressive_ban_enabled=_bool(data.get("progressive_ban_enabled"), True),
            ban_base_seconds=_int_range(data.get("ban_base_seconds"), 60, 30 * 86400, 3600),
            ban_max_seconds=_int_range(data.get("ban_max_seconds"), 60, 365 * 86400, 30 * 86400),
            login_short_interval_enabled=_bool(data.get("login_short_interval_enabled"), True),
            login_short_interval_block_enabled=_bool(data.get("login_short_interval_block_enabled"), True),
            login_min_interval_seconds=_int_range(data.get("login_min_interval_seconds"), 1, 3600, 5),
            login_short_interval_ban_threshold=_int_range(data.get("login_short_interval_ban_threshold"), 1, 1000, 3),
            password_failure_enabled=_bool(data.get("password_failure_enabled"), True),
            password_failure_window_hours=_int_range(data.get("password_failure_window_hours"), 1, 720, 24),
            password_failure_ban_threshold=_int_range(data.get("password_failure_ban_threshold"), 1, 10000, 15),
            login_403_enabled=_bool(data.get("login_403_enabled"), True),
            login_403_window_seconds=_int_range(data.get("login_403_window_seconds"), 1, 86400, 60),
            login_403_distinct_account_threshold=_int_range(data.get("login_403_distinct_account_threshold"), 1, 10000, 6),
            login_forget_403_threshold=_int_range(data.get("login_forget_403_threshold"), 1, 10000, 20),
            response_anomaly_enabled=_bool(data.get("response_anomaly_enabled"), True),
            response_anomaly_window_seconds=_int_range(data.get("response_anomaly_window_seconds"), 1, 86400, 60),
            response_anomaly_threshold=_int_range(data.get("response_anomaly_threshold"), 1, 10000, 10),
            response_anomaly_status_codes=_status_codes(data.get("response_anomaly_status_codes")),
            response_anomaly_reset_on_clean=_bool(data.get("response_anomaly_reset_on_clean"), True),
            response_anomaly_api_only=_bool(data.get("response_anomaly_api_only"), False),
            response_anomaly_exclude_static=_bool(data.get("response_anomaly_exclude_static"), True),
            upstream_key_format_immediate_ban_enabled=_bool(data.get("upstream_key_format_immediate_ban_enabled"), True),
            upstream_key_format_burst_threshold=_int_range(data.get("upstream_key_format_burst_threshold"), 1, 10000, 30),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ActiveDefenseDecision:
    allowed: bool = True
    code: str = "ok"
    message: str = ""
    event_type: str = ""
    ip: str = ""
    count: int = 0
    threshold: int = 0
    status_code: int = 0
    duration_seconds: int = 0
    remaining_seconds: int = 0
    banned_until: str = ""
    level: int = 0
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
