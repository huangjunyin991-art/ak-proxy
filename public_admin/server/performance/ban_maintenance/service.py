import logging
import time

from .repository import run_ban_normalization
from .state import BAN_MAINTENANCE_STATE, BanMaintenanceState


logger = logging.getLogger("TransparentProxy.BanMaintenance")


async def ensure_ban_normalized(pool, force: bool = False,
                                state: BanMaintenanceState = BAN_MAINTENANCE_STATE) -> bool:
    now = time.monotonic()
    if not state.should_run(now, force):
        return False
    if state.lock.locked():
        return False
    async with state.lock:
        now = time.monotonic()
        if not state.should_run(now, force):
            return False
        try:
            async with pool.acquire() as conn:
                await run_ban_normalization(conn)
            state.mark_success(time.monotonic())
            return True
        except Exception as exc:
            state.mark_error(exc, time.monotonic())
            logger.warning(f"[BanMaintenance] 封禁维护失败: {exc}")
            return False
