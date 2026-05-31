import time
import threading
from dataclasses import dataclass, field


@dataclass
class RateBanRuntimeStore:
    # key: ip, value: { rule_id: list[timestamp] }
    ip_timestamps: dict[str, dict[str, list[float]]] = field(default_factory=dict)
    # key: ip, value: last ban info dict
    last_ban: dict[str, dict] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def record_and_check(
        self,
        ip: str,
        rule_id: str,
        window_seconds: int,
        max_per_second: int,
    ) -> tuple[bool, int]:
        """
        Record a request and check if rate limit exceeded.
        Returns (exceeded, total_count_in_window).
        Thread-safe.
        """
        now = time.time()
        with self._lock:
            ip_map = self.ip_timestamps.setdefault(ip, {})
            ts_list = ip_map.setdefault(rule_id, [])
            ts_list[:] = [t for t in ts_list if now - t <= window_seconds]
            ts_list.append(now)
            count = len(ts_list)
            limit = max(1, max_per_second * window_seconds)
            return count > limit, count

    def clear_ip(self, ip: str) -> None:
        with self._lock:
            self.ip_timestamps.pop(ip, None)

    def record_ban(self, ip: str, rule_id: str, reason: str, duration_seconds: int) -> None:
        with self._lock:
            self.last_ban[ip] = {
                "rule_id": rule_id,
                "reason": reason,
                "duration_seconds": int(duration_seconds),
                "time": time.time(),
            }

    def get_last_ban(self, ip: str) -> dict | None:
        with self._lock:
            return dict(self.last_ban.get(ip) or {})

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "tracked_ips": len(self.ip_timestamps),
                "recent_bans": dict(self.last_ban),
            }
