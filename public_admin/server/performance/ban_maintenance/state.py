import asyncio
from dataclasses import dataclass, field


@dataclass
class BanMaintenanceState:
    ttl_seconds: int = 30
    last_run_monotonic: float = 0.0
    last_error: str = ''
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def should_run(self, now_monotonic: float, force: bool = False) -> bool:
        if force:
            return True
        return now_monotonic - self.last_run_monotonic >= self.ttl_seconds

    def mark_success(self, now_monotonic: float) -> None:
        self.last_run_monotonic = now_monotonic
        self.last_error = ''

    def mark_error(self, error: Exception, now_monotonic: float) -> None:
        self.last_run_monotonic = now_monotonic
        self.last_error = str(error or '')


BAN_MAINTENANCE_STATE = BanMaintenanceState()
