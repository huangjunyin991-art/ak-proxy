from __future__ import annotations

from statistics import median


class FairLoadStrategy:
    """Order eligible exits by current and lifetime utilization."""

    def pick(
        self,
        exits: list,
        candidate_indices: list[int],
        rr_counter: int,
        per_second_limit: int = 0,
    ) -> int | None:
        ordered = self.order(exits, candidate_indices, rr_counter, per_second_limit)
        return ordered[0] if ordered else None

    def order(
        self,
        exits: list,
        candidate_indices: list[int],
        rr_counter: int,
        per_second_limit: int = 0,
    ) -> list[int]:
        pool = list(dict.fromkeys(candidate_indices))
        if not pool:
            return []

        measured = [self._latency(exits[index]) for index in pool]
        measured = [value for value in measured if value is not None]
        neutral_latency = int(median(measured)) if measured else 0
        position = {index: offset for offset, index in enumerate(pool)}
        size = len(pool)

        return sorted(
            pool,
            key=lambda index: self._score(
                exits[index],
                position[index],
                size,
                rr_counter,
                per_second_limit,
                neutral_latency,
            ),
        )

    def _score(
        self,
        exit_obj,
        position: int,
        pool_size: int,
        rr_counter: int,
        per_second_limit: int,
        neutral_latency: int,
    ) -> tuple:
        rps_limit = max(1, int(per_second_limit or 1))
        rpm_limit = int(getattr(exit_obj, "rate_limit", 0) or 0)
        effective_rpm_limit = rpm_limit if rpm_limit > 0 else rps_limit * 60
        recent_second = max(0, int(exit_obj.count_recent_requests(1.0)))
        recent_minute = max(0, int(exit_obj.count_recent_requests(60.0)))
        lifetime_requests = max(0, int(getattr(exit_obj, "total", 0) or 0))
        latency = self._latency(exit_obj)
        return (
            recent_second / rps_limit,
            recent_minute / max(1, effective_rpm_limit),
            max(0, int(getattr(exit_obj, "active", 0) or 0)),
            lifetime_requests,
            latency if latency is not None else neutral_latency,
            (position - rr_counter) % max(1, pool_size),
        )

    @staticmethod
    def _latency(exit_obj):
        value = getattr(exit_obj, 'latency_ms', None)
        if value is None:
            return None
        try:
            return int(value)
        except Exception:
            return None


# Preserve the old import name for external extensions while changing its semantics.
LatencyAwareStrategy = FairLoadStrategy
