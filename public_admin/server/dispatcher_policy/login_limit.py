"""持久化出口节点登录限额策略。

调度器只负责执行限流，不直接依赖数据库；本模块负责配置的校验、读写，
使运行时调整在服务重启后仍然保持。
"""

from __future__ import annotations

import asyncio
import time
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


class LoginLimitPolicyService:
    """Own the persisted login-limit value and its runtime application."""

    def __init__(
        self,
        system_config: Any,
        dispatcher: Any,
        logger: Any = None,
        refresh_interval_seconds: float = 15.0,
    ):
        self._system_config = system_config
        self._dispatcher = dispatcher
        self._logger = logger
        self._refresh_interval_seconds = max(5.0, float(refresh_interval_seconds))
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._persisted_value: int | None = None
        self._source = "default"
        self._last_loaded_at = 0.0

    async def load_and_apply(self, reason: str = "refresh", force: bool = False) -> int:
        async with self._lock:
            now = time.time()
            if (
                not force
                and self._last_loaded_at
                and now - self._last_loaded_at < self._refresh_interval_seconds
            ):
                return normalize_max_login_per_min(
                    getattr(self._dispatcher, "MAX_LOGIN_PER_MIN", DEFAULT_MAX_LOGIN_PER_MIN)
                )
            if force and hasattr(self._system_config, "invalidate"):
                await self._system_config.invalidate(MAX_LOGIN_PER_MIN_CONFIG_KEY)
            current = normalize_max_login_per_min(
                getattr(self._dispatcher, "MAX_LOGIN_PER_MIN", DEFAULT_MAX_LOGIN_PER_MIN)
            )
            try:
                saved = await self._system_config.get(MAX_LOGIN_PER_MIN_CONFIG_KEY, None)
                value = normalize_max_login_per_min(saved, current)
                source = "database" if saved is not None else "default"
                self._persisted_value = value if saved is not None else None
            except Exception as exc:
                value = current
                source = "runtime"
                if self._logger is not None:
                    self._logger.warning("[DispatcherPolicy] 登录限额刷新失败 reason=%s: %s", reason, exc)
            self._dispatcher.set_max_login_per_min(value)
            self._source = source
            self._last_loaded_at = now
            if self._logger is not None:
                self._logger.info(
                    "[DispatcherPolicy] 登录限额已应用 value=%s/min source=%s reason=%s",
                    value, source, reason,
                )
            return value

    async def start(self) -> None:
        await self.load_and_apply(reason="startup", force=True)
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._refresh_loop(), name="dispatcher-login-limit-refresh")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def _refresh_loop(self) -> None:
        while True:
            await asyncio.sleep(self._refresh_interval_seconds)
            try:
                await self.load_and_apply(reason="periodic", force=True)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if self._logger is not None:
                    self._logger.warning("[DispatcherPolicy] 周期刷新失败: %s", exc)

    async def save_and_apply(self, value: Any) -> tuple[bool, int | None]:
        async with self._lock:
            try:
                raw = int(value)
            except (TypeError, ValueError):
                return False, None
            if raw < MIN_MAX_LOGIN_PER_MIN:
                return False, None
            normalized = raw
            old_value = normalize_max_login_per_min(
                getattr(self._dispatcher, "MAX_LOGIN_PER_MIN", DEFAULT_MAX_LOGIN_PER_MIN)
            )
            if not await save_max_login_per_min(self._system_config, normalized):
                return False, None
            if not self._dispatcher.set_max_login_per_min(normalized):
                await save_max_login_per_min(self._system_config, old_value)
                return False, None
            self._persisted_value = normalized
            self._source = "database"
            self._last_loaded_at = time.time()
            return True, normalized

    def snapshot(self) -> dict[str, Any]:
        return {
            "value": normalize_max_login_per_min(
                getattr(self._dispatcher, "MAX_LOGIN_PER_MIN", DEFAULT_MAX_LOGIN_PER_MIN)
            ),
            "persisted_value": self._persisted_value,
            "source": self._source,
            "loaded_at": self._last_loaded_at or None,
        }
