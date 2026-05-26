import logging

from .service import RiskIsolationService


class RiskIsolationLoginGuard:
    def __init__(self, service: RiskIsolationService, logger: logging.Logger | None = None):
        self.service = service
        self.logger = logger

    async def should_hide_login(self, username: str) -> bool:
        try:
            return await self.service.should_hide_login(username)
        except Exception as exc:
            if self.logger is not None:
                self.logger.warning(f"[RiskIsolation] 登录隔离检查失败，按未隔离放行: {exc}")
            return False
