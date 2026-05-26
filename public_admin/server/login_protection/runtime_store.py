import time
from dataclasses import dataclass, field


@dataclass
class LoginProtectionRuntimeStore:
    request_timestamps: dict[str, list[float]] = field(default_factory=dict)
    short_interval_counts: dict[str, int] = field(default_factory=dict)

    def get_recent_timestamps(self, key: str, window_seconds: int) -> list[float]:
        now = time.time()
        timestamps = self.request_timestamps.setdefault(key, [])
        timestamps[:] = [ts for ts in timestamps if now - float(ts or 0) <= window_seconds]
        return timestamps

    def record_allowed(self, key: str, timestamp: float) -> int:
        timestamps = self.request_timestamps.setdefault(key, [])
        timestamps.append(timestamp)
        self.short_interval_counts.pop(key, None)
        return len(timestamps)

    def record_short_interval(self, key: str) -> int:
        count = int(self.short_interval_counts.get(key) or 0) + 1
        self.short_interval_counts[key] = count
        return count

    def clear(self, key: str) -> None:
        self.request_timestamps.pop(key, None)
        self.short_interval_counts.pop(key, None)

    def snapshot(self) -> dict:
        return {
            "tracked_ips": len(self.request_timestamps),
            "short_interval_ips": len(self.short_interval_counts),
            "short_interval_counts": dict(self.short_interval_counts),
        }
