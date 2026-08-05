from __future__ import annotations


class BusinessLatencyEstimator:
    """Maintains a stable business-origin latency value on an outbound exit."""

    def __init__(self, alpha: float = 0.35) -> None:
        self.alpha = max(0.05, min(float(alpha), 1.0))

    def record_success(self, exit_obj, elapsed_ms: int, checked_at: str) -> int:
        sample = max(0, int(elapsed_ms or 0))
        previous = self._latency(exit_obj)
        value = sample if previous is None else round(previous * (1.0 - self.alpha) + sample * self.alpha)
        exit_obj.latency_ms = value
        exit_obj.latency_checked_at = checked_at
        exit_obj.latency_probe_failures = 0
        exit_obj.latency_probe_error = ""
        return value

    @staticmethod
    def record_failure(exit_obj, error: str, checked_at: str) -> None:
        exit_obj.latency_checked_at = checked_at
        exit_obj.latency_probe_failures = int(getattr(exit_obj, "latency_probe_failures", 0) or 0) + 1
        exit_obj.latency_probe_error = str(error or "business source probe failed")[:240]

    @staticmethod
    def _latency(exit_obj) -> int | None:
        value = getattr(exit_obj, "latency_ms", None)
        if value is None:
            return None
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return None
