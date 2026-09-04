"""持久化出口节点登录限额策略。

调度器只负责执行限流，不直接依赖数据库；本模块负责配置的校验、读写，
使运行时调整在服务重启后仍然保持。
"""

from __future__ import annotations

from typing import Any


MAX_LOGIN_PER_MIN_CONFIG_KEY = "dispatcher_max_login_per_min"
DEFAULT_MAX_LOGIN_PER_MIN = 10
MIN_MAX_LOGIN_PER_MIN = 1


def normalize_max_login_per_min(value: Any, default: int = DEFAULT_MAX_LOGIN_PER_MIN) -> int:
    """返回安全的整数限额；非法或小于 1 的持久化值不应覆盖有效配置。"""
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        return int(default)
    return normalized if normalized >= MIN_MAX_LOGIN_PER_MIN else int(default)


async def load_max_login_per_min(system_config: Any, default: int = DEFAULT_MAX_LOGIN_PER_MIN) -> int:
    """从 system_config 读取每出口每分钟登录限额，失败时回退默认值。"""
    fallback = normalize_max_login_per_min(default)
    saved = await system_config.get(MAX_LOGIN_PER_MIN_CONFIG_KEY, None)
    return normalize_max_login_per_min(saved, fallback)


async def save_max_login_per_min(system_config: Any, value: Any) -> bool:
    """校验并持久化限额；非法值不会覆盖数据库中的旧值。"""
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        return False
    if normalized < MIN_MAX_LOGIN_PER_MIN:
        return False
    return bool(await system_config.set(
        MAX_LOGIN_PER_MIN_CONFIG_KEY,
        normalized,
        "每个负载均衡出口节点每分钟最大登录次数",
    ))
