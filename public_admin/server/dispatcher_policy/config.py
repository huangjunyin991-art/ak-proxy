from dataclasses import dataclass


@dataclass
class DispatcherPolicyConfig:
    latency_probe_interval_seconds: int = 30 * 60
    per_exit_rate_per_second: int = 3
    latency_strategy_enabled: bool = True
    latency_tier_tolerance_ms: int = 50
    initial_probe_delay_seconds: int = 60
    connect_failure_freeze_seconds: int = 5 * 60

    def update(self, *, per_exit_rate_per_second=None, latency_strategy_enabled=None,
               connect_failure_freeze_seconds=None):
        if per_exit_rate_per_second is not None:
            try:
                value = int(per_exit_rate_per_second)
            except (TypeError, ValueError):
                return False
            if value < 1 or value > 20:
                return False
            self.per_exit_rate_per_second = value
        if latency_strategy_enabled is not None:
            self.latency_strategy_enabled = bool(latency_strategy_enabled)
        if connect_failure_freeze_seconds is not None:
            try:
                value = int(connect_failure_freeze_seconds)
            except (TypeError, ValueError):
                return False
            if value < 30 or value > 86400:
                return False
            self.connect_failure_freeze_seconds = value
        return True

    def to_dict(self) -> dict:
        return {
            'latency_probe_interval_seconds': self.latency_probe_interval_seconds,
            'per_exit_rate_per_second': self.per_exit_rate_per_second,
            'latency_strategy_enabled': self.latency_strategy_enabled,
            'latency_tier_tolerance_ms': self.latency_tier_tolerance_ms,
            'connect_failure_freeze_seconds': self.connect_failure_freeze_seconds,
        }
