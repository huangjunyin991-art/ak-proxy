import logging
from datetime import datetime, timedelta
from typing import Awaitable, Callable

from .repository import (
    count_password_failure_events,
    count_password_failure_events_for_account,
    ensure_password_failure_events_backfilled,
    ensure_password_failure_events_backfilled_for_account,
    record_password_failure_event,
)
from .schemas import PasswordFailureEvent


logger = logging.getLogger("TransparentProxy.LoginGuard")
FailureFallbackCounter = Callable[[str, str, int], Awaitable[int]]
AccountFailureFallbackCounter = Callable[[str, int], Awaitable[int]]


async def record_login_guard_event(pool, event: PasswordFailureEvent) -> None:
    try:
        async with pool.acquire() as conn:
            await record_password_failure_event(conn, event)
    except Exception as exc:
        logger.warning(f"[LoginGuard] 登录防护事件维护失败: {exc}")


async def count_recent_password_failures(pool, username: str, ip_address: str, hours: int = 24,
                                         fallback_counter: FailureFallbackCounter = None) -> int:
    try:
        window_start = datetime.now() - timedelta(hours=hours)
        async with pool.acquire() as conn:
            await ensure_password_failure_events_backfilled(conn, username, ip_address, window_start)
            count = await count_password_failure_events(conn, username, ip_address, window_start)
        return count
    except Exception as exc:
        logger.warning(f"[LoginGuard] 结构化密码错误计数失败，降级旧查询: {exc}")
        if fallback_counter is None:
            return 0
        return await fallback_counter(username, ip_address, hours)


async def count_recent_password_failures_for_account(
    pool,
    username: str,
    hours: int = 24,
    fallback_counter: AccountFailureFallbackCounter = None,
) -> int:
    """Count password failures by account, independent of changing edge IPs."""
    try:
        window_start = datetime.now() - timedelta(hours=hours)
        async with pool.acquire() as conn:
            await ensure_password_failure_events_backfilled_for_account(conn, username, window_start)
            count = await count_password_failure_events_for_account(conn, username, window_start)
        return count
    except Exception as exc:
        logger.warning("[LoginGuard] account-wide password failure count failed: %s", exc)
        if fallback_counter is None:
            return 0
        return await fallback_counter(username, hours)
