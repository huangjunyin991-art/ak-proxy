from dataclasses import dataclass, field
import time
from typing import Any


@dataclass
class ActiveDefenseRuntimeStore:
    login_request_timestamps: dict[str, list[float]] = field(default_factory=dict)
    login_short_interval_counts: dict[str, int] = field(default_factory=dict)
    login_short_interval_seen_at: dict[str, float] = field(default_factory=dict)
    login_forget_403_counts: dict[str, int] = field(default_factory=dict)
    login_forget_403_seen_at: dict[str, float] = field(default_factory=dict)
    login_403_accounts: dict[str, dict[str, float]] = field(default_factory=dict)
    response_anomaly_counts: dict[str, dict[str, Any]] = field(default_factory=dict)
    upstream_key_format_errors: dict[str, list[float]] = field(default_factory=dict)
    last_ban: dict[str, Any] = field(default_factory=dict)
    last_prune_at: float = 0.0

    def get_recent_login_timestamps(self, ip: str, window_seconds: int) -> list[float]:
        now = time.time()
        timestamps = self.login_request_timestamps.setdefault(ip, [])
        timestamps[:] = [ts for ts in timestamps if now - float(ts or 0) <= window_seconds]
        return timestamps

    def record_login_allowed(self, ip: str, timestamp: float) -> int:
        timestamps = self.login_request_timestamps.setdefault(ip, [])
        timestamps.append(timestamp)
        self.login_short_interval_counts.pop(ip, None)
        self.login_short_interval_seen_at.pop(ip, None)
        return len(timestamps)

    def record_login_short_interval(self, ip: str) -> int:
        count = int(self.login_short_interval_counts.get(ip) or 0) + 1
        self.login_short_interval_counts[ip] = count
        self.login_short_interval_seen_at[ip] = time.time()
        return count

    def clear_login_short_interval(self, ip: str) -> None:
        self.login_request_timestamps.pop(ip, None)
        self.login_short_interval_counts.pop(ip, None)
        self.login_short_interval_seen_at.pop(ip, None)

    def record_login_forget_403(self, ip: str) -> int:
        count = int(self.login_forget_403_counts.get(ip) or 0) + 1
        self.login_forget_403_counts[ip] = count
        self.login_forget_403_seen_at[ip] = time.time()
        return count

    def reset_login_forget_403(self, ip: str) -> None:
        self.login_forget_403_counts.pop(ip, None)
        self.login_forget_403_seen_at.pop(ip, None)

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

    def record_upstream_key_format_error(self, ip: str, window_seconds: int) -> int:
        now = time.time()
        timestamps = self.upstream_key_format_errors.setdefault(ip, [])
        timestamps[:] = [ts for ts in timestamps if now - float(ts or 0) <= window_seconds]
        timestamps.append(now)
        return len(timestamps)

    def reset_upstream_key_format_errors(self, ip: str) -> None:
        self.upstream_key_format_errors.pop(ip, None)

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
        self.login_short_interval_seen_at.clear()
        self.login_forget_403_counts.clear()
        self.login_forget_403_seen_at.clear()
        self.login_403_accounts.clear()
        self.response_anomaly_counts.clear()
        self.upstream_key_format_errors.clear()
        self.last_ban.clear()
        self.last_prune_at = 0.0

    def maybe_prune_expired(
        self,
        *,
        login_request_window_seconds: int,
        login_short_interval_window_seconds: int,
        login_forget_403_window_seconds: int,
        login_403_window_seconds: int,
        response_anomaly_window_seconds: int,
        upstream_key_format_window_seconds: int = 60,
        interval_seconds: int = 30,
        force: bool = False,
    ) -> None:
        now = time.time()
        if not force and self.last_prune_at and now - self.last_prune_at < interval_seconds:
            return
        self.last_prune_at = now
        self._prune_login_request_timestamps(now, max(1, login_request_window_seconds))
        self._prune_counter(self.login_short_interval_counts, self.login_short_interval_seen_at, now, max(1, login_short_interval_window_seconds))
        self._prune_counter(self.login_forget_403_counts, self.login_forget_403_seen_at, now, max(1, login_forget_403_window_seconds))
        self._prune_login_403_accounts(now, max(1, login_403_window_seconds))
        self._prune_response_anomaly(now, max(1, response_anomaly_window_seconds))
        self._prune_timestamp_lists(self.upstream_key_format_errors, now, max(1, upstream_key_format_window_seconds))

    def _prune_login_request_timestamps(self, now: float, window_seconds: int) -> None:
        stale_ips = []
        for ip, timestamps in self.login_request_timestamps.items():
            timestamps[:] = [ts for ts in timestamps if now - float(ts or 0) <= window_seconds]
            if not timestamps:
                stale_ips.append(ip)
        for ip in stale_ips:
            self.login_request_timestamps.pop(ip, None)

    def _prune_counter(self, counts: dict[str, int], seen_at: dict[str, float], now: float, window_seconds: int) -> None:
        stale_ips = [ip for ip, ts in seen_at.items() if now - float(ts or 0) > window_seconds]
        for ip in stale_ips:
            counts.pop(ip, None)
            seen_at.pop(ip, None)
        for ip in list(counts.keys()):
            if ip not in seen_at:
                counts.pop(ip, None)

    def _prune_login_403_accounts(self, now: float, window_seconds: int) -> None:
        stale_ips = []
        for ip, accounts in self.login_403_accounts.items():
            stale_accounts = [account for account, ts in accounts.items() if now - float(ts or 0) > window_seconds]
            for account in stale_accounts:
                accounts.pop(account, None)
            if not accounts:
                stale_ips.append(ip)
        for ip in stale_ips:
            self.login_403_accounts.pop(ip, None)

    def _prune_response_anomaly(self, now: float, window_seconds: int) -> None:
        stale_ips = [
            ip
            for ip, record in self.response_anomaly_counts.items()
            if now - float((record or {}).get("last_seen") or 0) > window_seconds
        ]
        for ip in stale_ips:
            self.response_anomaly_counts.pop(ip, None)

    def _prune_timestamp_lists(self, store: dict[str, list[float]], now: float, window_seconds: int) -> None:
        stale_ips = []
        for ip, timestamps in store.items():
            timestamps[:] = [ts for ts in timestamps if now - float(ts or 0) <= window_seconds]
            if not timestamps:
                stale_ips.append(ip)
        for ip in stale_ips:
            store.pop(ip, None)

    def snapshot(self) -> dict[str, Any]:
        return {
            "login_tracked_ips": len(self.login_request_timestamps),
            "login_short_interval_ips": len(self.login_short_interval_counts),
            "login_forget_403_ips": len(self.login_forget_403_counts),
            "login_403_ips": len(self.login_403_accounts),
            "response_anomaly_ips": len(self.response_anomaly_counts),
            "upstream_key_format_error_ips": len(self.upstream_key_format_errors),
            "last_ban": dict(self.last_ban),
        }
