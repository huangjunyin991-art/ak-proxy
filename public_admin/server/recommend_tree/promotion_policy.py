from __future__ import annotations

from copy import deepcopy
from typing import Any


PROMOTION_POLICY_CONFIG_KEY = "recommend_tree_promotion_policy"
PROMOTION_LEVEL_ORDER = ("M1", "M2", "M3", "M4", "M5")

PROMOTION_REQUIREMENTS: dict[str, dict[str, Any]] = {
    "M1": {
        "level": 1,
        "direct_push": 5,
        "small_area": 2,
        "required_lines": 0,
        "next_level": "",
        "tripod_applicable": False,
    },
    "M2": {
        "level": 2,
        "direct_push": 10,
        "small_area": 10,
        "required_lines": 3,
        "next_level": "M1",
        "tripod_applicable": True,
    },
    "M3": {
        "level": 3,
        "direct_push": 15,
        "small_area": 200,
        "required_lines": 3,
        "next_level": "M2",
        "tripod_applicable": True,
    },
    "M4": {
        "level": 4,
        "direct_push": 20,
        "small_area": 500,
        "required_lines": 3,
        "next_level": "M3",
        "tripod_applicable": True,
    },
    "M5": {
        "level": 5,
        "direct_push": 25,
        "small_area": 5000,
        "required_lines": 3,
        "next_level": "M4",
        "tripod_applicable": True,
    },
}

DEFAULT_PROMOTION_POLICY = {
    "levels": {
        "M1": {"require_tripod": False},
        "M2": {"require_tripod": True},
        "M3": {"require_tripod": True},
        "M4": {"require_tripod": True},
        "M5": {"require_tripod": True},
    }
}


def normalize_promotion_policy(data: dict[str, Any] | None = None) -> dict[str, Any]:
    normalized = deepcopy(DEFAULT_PROMOTION_POLICY)
    levels = data.get("levels") if isinstance(data, dict) else None
    for level in PROMOTION_LEVEL_ORDER:
        rule = PROMOTION_REQUIREMENTS[level]
        source = levels.get(level) if isinstance(levels, dict) else None
        if not rule["tripod_applicable"]:
            normalized["levels"][level]["require_tripod"] = False
            continue
        normalized["levels"][level]["require_tripod"] = _parse_bool(
            source.get("require_tripod") if isinstance(source, dict) else normalized["levels"][level]["require_tripod"],
            default=True,
        )
    return normalized


def policy_requires_tripod(policy: dict[str, Any] | None, level_label: str) -> bool:
    normalized_level = str(level_label or "").upper()
    rule = PROMOTION_REQUIREMENTS.get(normalized_level)
    if not rule:
        return False
    if not rule["tripod_applicable"]:
        return False
    levels = policy.get("levels") if isinstance(policy, dict) else None
    source = levels.get(normalized_level) if isinstance(levels, dict) else None
    if isinstance(source, dict) and "require_tripod" in source:
        return bool(source.get("require_tripod"))
    return bool(DEFAULT_PROMOTION_POLICY["levels"][normalized_level]["require_tripod"])


def build_promotion_policy_snapshot(policy: dict[str, Any] | None = None) -> dict[str, Any]:
    normalized = normalize_promotion_policy(policy)
    rows: list[dict[str, Any]] = []
    for level in PROMOTION_LEVEL_ORDER:
        rule = PROMOTION_REQUIREMENTS[level]
        rows.append(
            {
                "level": level,
                "direct_push": int(rule["direct_push"]),
                "small_area": int(rule["small_area"]),
                "required_lines": int(rule["required_lines"]),
                "next_level": str(rule["next_level"]),
                "tripod_applicable": bool(rule["tripod_applicable"]),
                "require_tripod": bool(normalized["levels"][level]["require_tripod"]),
            }
        )
    return {
        "levels": deepcopy(normalized["levels"]),
        "rules": rows,
    }


class RecommendTreePromotionPolicyService:
    def __init__(self, system_config, logger=None):
        self._system_config = system_config
        self._logger = logger

    async def get_policy_payload(self) -> dict[str, Any]:
        try:
            saved = await self._system_config.get(PROMOTION_POLICY_CONFIG_KEY, None)
            return normalize_promotion_policy(saved if isinstance(saved, dict) else None)
        except Exception as exc:
            if self._logger is not None:
                self._logger.warning(f"[RecommendTreePolicy] 读取晋升策略失败，使用默认值: {exc}")
            return normalize_promotion_policy()

    async def set_policy_payload(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        normalized = normalize_promotion_policy(payload if isinstance(payload, dict) else None)
        ok = await self._system_config.set(
            PROMOTION_POLICY_CONFIG_KEY,
            normalized,
            "组织架构晋升策略",
        )
        if not ok:
            raise RuntimeError("保存晋升策略失败")
        return normalized

    async def snapshot(self) -> dict[str, Any]:
        return build_promotion_policy_snapshot(await self.get_policy_payload())


def _parse_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value or "").strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return default
