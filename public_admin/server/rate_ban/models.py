from dataclasses import dataclass, field, asdict
from typing import Any


def _bool(value, default: bool) -> bool:
    return bool(value) if value is not None else default


def _int_range(value, minimum: int, maximum: int, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))


# ---- single rule ----

@dataclass(frozen=True)
class RateBanRule:
    id: str                    # unique identifier, e.g. "admin_api" / "im_chat"
    label: str                # human-readable name shown in admin panel
    route_prefix: str          # URL prefix to match (fast prefix check)
    methods: tuple[str, ...]  # HTTP methods to protect, empty = all
    requests_per_second: int = 10
    window_seconds: int = 60
    exclude_loopback: bool = True
    enabled: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_mapping(cls, payload: dict | None) -> "RateBanRule":
        data = dict(payload or {})
        return cls(
            id=str(data.get("id") or ""),
            label=str(data.get("label") or ""),
            route_prefix=str(data.get("route_prefix") or ""),
            methods=tuple(data.get("methods") or ()),
            requests_per_second=_int_range(data.get("requests_per_second"), 1, 10000, 10),
            window_seconds=_int_range(data.get("window_seconds"), 1, 3600, 60),
            exclude_loopback=_bool(data.get("exclude_loopback"), True),
            enabled=_bool(data.get("enabled"), True),
        )


# ---- global policy ----

@dataclass(frozen=True)
class RateBanPolicy:
    enabled: bool = True
    ignore_loopback: bool = True
    ban_base_seconds: int = 3600
    rules: tuple[RateBanRule, ...] = ()

    DEFAULT_RULES: tuple[RateBanRule, ...] = (
        RateBanRule(
            id="admin_api",
            label="管理员接口",
            route_prefix="/admin/api/",
            methods=(),
            requests_per_second=30,
            window_seconds=60,
            exclude_loopback=True,
            enabled=True,
        ),
        RateBanRule(
            id="im_chat",
            label="IM 聊天接口",
            route_prefix="/chat/",
            methods=(),
            requests_per_second=60,
            window_seconds=60,
            exclude_loopback=True,
            enabled=True,
        ),
    )

    @classmethod
    def from_mapping(cls, payload: dict | None) -> "RateBanPolicy":
        data = dict(payload or {})
        raw_rules = data.get("rules") or []
        rules = tuple(
            RateBanRule.from_mapping(r) if isinstance(r, dict) else r
            for r in raw_rules
        )
        if not rules:
            rules = cls.DEFAULT_RULES
        return cls(
            enabled=_bool(data.get("enabled"), True),
            ignore_loopback=_bool(data.get("ignore_loopback"), True),
            ban_base_seconds=_int_range(data.get("ban_base_seconds"), 60, 86400 * 7, 3600),
            rules=rules,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "ignore_loopback": self.ignore_loopback,
            "ban_base_seconds": self.ban_base_seconds,
            "rules": [r.to_dict() for r in self.rules],
        }


# ---- check result ----

@dataclass(frozen=True)
class RateBanDecision:
    allowed: bool = True
    code: str = "ok"          # ok | blocked | banned | skipped
    message: str = ""
    rule_id: str = ""
    count: int = 0
    duration_seconds: int = 0
    level: int = 0
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
