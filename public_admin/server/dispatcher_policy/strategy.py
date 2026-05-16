class LatencyAwareStrategy:
    def __init__(self, tier_tolerance_ms: int = 50):
        self.tier_tolerance_ms = tier_tolerance_ms

    def pick(self, exits: list, candidate_indices: list[int], rr_counter: int) -> int | None:
        if not candidate_indices:
            return None
        measured = [i for i in candidate_indices if self._latency(exits[i]) is not None]
        pool = measured if measured else list(candidate_indices)
        if measured:
            best_latency = min(self._latency(exits[i]) for i in measured)
            pool = [i for i in measured if self._latency(exits[i]) <= best_latency + self.tier_tolerance_ms]
        min_active = min(getattr(exits[i], 'active', 0) for i in pool)
        pool = [i for i in pool if getattr(exits[i], 'active', 0) == min_active]
        return pool[rr_counter % len(pool)]

    @staticmethod
    def _latency(exit_obj):
        value = getattr(exit_obj, 'latency_ms', None)
        if value is None:
            return None
        try:
            return int(value)
        except Exception:
            return None
