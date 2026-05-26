from dataclasses import dataclass, field
import time
from typing import Any


@dataclass
class ActiveDefenseRuntimeStore:
    login_request_timestamps: dict[str, list[float]] = field(default_factory=dict)
    login_short_interval_counts: dict[str, int] = field(default_factory=dict)
    login_forget_403_counts: dict[str, int] = field(default_factory=dict)
    login_403_accounts: dict[str, dict[str, float]] = field(default_factory=dict)
    response_anomaly_counts: dict[str, dict[str, Any]] = field(default_factory=dict)
    last_ban: dict[str, Any] = field(default_factory=dict)

    def get_recent_login_timestamps(self, ip: str, window_seconds: int) -> list[float]:
        now = time.time()
        timestamps = self.login_request_timestamps.setdefault(ip, [])
        timestamps[:] = [ts for ts in timestamps if now - float(ts or 0) <= window_seconds]
        return timestamps

    def record_login_allowed(self, ip: str, timestamp: float) -> int:
        timestamps = self.login_request_timestamps.setdefault(ip, [])
        timestamps.append(timestamp)
        self.login_short_interval_counts.pop(ip, None)
        return len(timestamps)

    def record_login_short_interval(self, ip: str) -> int:
        count = int(self.login_short_interval_counts.get(ip) or 0) + 1
        self.login_short_interval_counts[ip] = count
        return count

    def clear_login_short_interval(self, ip: str) -> None:
        self.login_request_timestamps.pop(ip, None)
        self.login_short_interval_counts.pop(ip, None)

    def record_login_forget_403(self, ip: str) -> int:
        count = int(self.login_forget_403_counts.get(ip) or 0) + 1
        self.login_forget_403_counts[ip] = count
        return count

    def reset_login_forget_403(self, ip: str) -> None:
        self.login_forget_403_counts.pop(ip, None)

    def record_login_403_account(self, ip: str, username: str, window_seconds: int) -> int:
        now = time.time()
        accounts = self.login_403_accounts.setdefault(ip, {})
        stale_accounts = [account for account, ts in accounts.items() if now - float(ts or 0) > window_seconds]
        for account in stale_accounts:
            accounts.pop(account, None)
        accounts[username] = now
        return len(accounts)

    def clear_login_403_accounts(self, ip: str) -> None:
        self.login_403_accounts.pop(ip, None)

    def record_response_anomaly(self, ip: str, status_code: int, window_seconds: int) -> int:
        now = time.time()
        record = self.response_anomaly_counts.get(ip) or {}
        last_seen = float(record.get("last_seen") or 0)
        if last_seen and now - last_seen <= window_seconds:
            count = int(record.get("count") or 0) + 1
            first_seen = float(record.get("first_seen") or now)
        else:
            count = 1
            first_seen = now
        self.response_anomaly_counts[ip] = {
            "count": count,
            "first_seen": first_seen,
            "last_seen": now,
            "status_code": int(status_code or 0),
        }
        return count

    def reset_response_anomaly(self, ip: str) -> None:
        self.response_anomaly_counts.pop(ip, None)

    def record_ban(self, ip: str, event_type: str, reason: str, count: int, duration_seconds: int = 0) -> None:
        self.last_ban = {
            "ip": ip,
            "event_type": event_type,
            "reason": reason,
            "count": count,
            "duration_seconds": int(duration_seconds or 0),
            "time": time.time(),
        }

    def clear_all(self) -> None:
        self.login_request_timestamps.clear()
        self.login_short_interval_counts.clear()
        self.login_forget_403_counts.clear()
        self.login_403_accounts.clear()
        self.response_anomaly_counts.clear()
        self.last_ban.clear()

    def snapshot(self) -> dict[str, Any]:
        return {
            "login_tracked_ips": len(self.login_request_timestamps),
            "login_short_interval_ips": len(self.login_short_interval_counts),
            "login_forget_403_ips": len(self.login_forget_403_counts),
            "login_403_ips": len(self.login_403_accounts),
            "response_anomaly_ips": len(self.response_anomaly_counts),
            "last_ban": dict(self.last_ban),
        }
