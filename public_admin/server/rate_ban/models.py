from dataclasses import asdict, dataclass
from typing import Any, ClassVar


def _bool(value, default: bool) -> bool:
    return bool(value) if value is not None else default


def _int_range(value, minimum: int, maximum: int, default: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))


@dataclass(frozen=True)
class RateBanRule:
    id: str
    label: str
    route_prefix: str
    methods: tuple[str, ...]
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


@dataclass(frozen=True)
class RateBanPolicy:
    enabled: bool = True
    ignore_loopback: bool = True
    ban_base_seconds: int = 3600
    rules: tuple[RateBanRule, ...] = ()

    DEFAULT_RULES: ClassVar[tuple[RateBanRule, ...]] = (
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
            label="IM 聊天资源",
            route_prefix="/chat/",
            methods=(),
            requests_per_second=60,
            window_seconds=60,
            exclude_loopback=True,
            enabled=True,
        ),
        RateBanRule(
            id="license_credentials_v1",
            label="授权凭据接口 v1",
            route_prefix="/api/v1/license/",
            methods=(),
            requests_per_second=2,
            window_seconds=60,
            exclude_loopback=True,
            enabled=True,
        ),
        RateBanRule(
            id="license_activate_legacy",
            label="授权激活接口 legacy",
            route_prefix="/api/license/activate",
            methods=("POST",),
            requests_per_second=5,
            window_seconds=60,
            exclude_loopback=True,
            enabled=True,
        ),
        RateBanRule(
            id="license_verify_legacy",
            label="授权校验接口 legacy",
            route_prefix="/api/license/verify",
            methods=("POST",),
            requests_per_second=10,
            window_seconds=60,
            exclude_loopback=True,
            enabled=True,
        ),
        RateBanRule(
            id="license_credentials_legacy",
            label="授权凭据接口 legacy",
            route_prefix="/api/license/",
            methods=(),
            requests_per_second=2,
            window_seconds=60,
            exclude_loopback=True,
            enabled=True,
        ),
        RateBanRule(
            id="license_activate_v1",
            label="授权激活接口 v1",
            route_prefix="/api/v1/activate",
            methods=("POST",),
            requests_per_second=5,
            window_seconds=60,
            exclude_loopback=True,
            enabled=True,
        ),
        RateBanRule(
            id="license_verify_v1",
            label="授权校验接口 v1",
            route_prefix="/api/v1/verify",
            methods=("POST",),
            requests_per_second=10,
            window_seconds=60,
            exclude_loopback=True,
            enabled=True,
        ),
        RateBanRule(
            id="license_consume_v1",
            label="授权扣次接口 v1",
            route_prefix="/api/v1/consume",
            methods=("POST",),
            requests_per_second=10,
            window_seconds=60,
            exclude_loopback=True,
            enabled=True,
        ),
        RateBanRule(
            id="license_check_update_v1",
            label="更新检查接口 v1",
            route_prefix="/api/v1/check-update",
            methods=(),
            requests_per_second=10,
            window_seconds=60,
            exclude_loopback=True,
            enabled=True,
        ),
        RateBanRule(
            id="license_check_update_legacy",
            label="更新检查接口 legacy",
            route_prefix="/api/check-update",
            methods=(),
            requests_per_second=10,
            window_seconds=60,
            exclude_loopback=True,
            enabled=True,
        ),
        RateBanRule(
            id="notify_public",
            label="通知公开接口",
            route_prefix="/api/notify-center/",
            methods=(),
            requests_per_second=10,
            window_seconds=60,
            exclude_loopback=True,
            enabled=True,
        ),
        RateBanRule(
            id="im_api",
            label="IM API",
            route_prefix="/im/api/",
            methods=(),
            requests_per_second=60,
            window_seconds=60,
            exclude_loopback=True,
            enabled=True,
        ),
    )

    def __post_init__(self) -> None:
        normalized_rules = tuple(
            RateBanRule.from_mapping(rule) if isinstance(rule, dict) else rule
            for rule in (self.rules or ())
            if isinstance(rule, (dict, RateBanRule))
        )
        if not normalized_rules:
            normalized_rules = self.DEFAULT_RULES
        object.__setattr__(self, "rules", normalized_rules)

    @classmethod
    def from_mapping(cls, payload: dict | None) -> "RateBanPolicy":
        data = dict(payload or {})
        raw_rules = data.get("rules") or []
        rules = tuple(
            RateBanRule.from_mapping(rule) if isinstance(rule, dict) else rule
            for rule in raw_rules
        )
        return cls(
            enabled=_bool(data.get("enabled"), True),
            ignore_loopback=_bool(data.get("ignore_loopback"), True),
            ban_base_seconds=_int_range(data.get("ban_base_seconds"), 60, 86400 * 7, 3600),
            rules=rules,
        )

    def with_missing_default_rules(self) -> "RateBanPolicy":
        existing_ids = {str(rule.id or "").strip() for rule in self.rules}
        missing = tuple(rule for rule in self.DEFAULT_RULES if rule.id not in existing_ids)
        if not missing:
            return self
        return RateBanPolicy(
            enabled=self.enabled,
            ignore_loopback=self.ignore_loopback,
            ban_base_seconds=self.ban_base_seconds,
            rules=tuple(self.rules) + missing,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "ignore_loopback": self.ignore_loopback,
            "ban_base_seconds": self.ban_base_seconds,
            "rules": [rule.to_dict() for rule in self.rules],
        }


@dataclass(frozen=True)
class RateBanDecision:
    allowed: bool = True
    code: str = "ok"
    message: str = ""
    rule_id: str = ""
    count: int = 0
    duration_seconds: int = 0
    level: int = 0
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
