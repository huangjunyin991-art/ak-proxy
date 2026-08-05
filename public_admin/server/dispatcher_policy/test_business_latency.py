from types import SimpleNamespace

from .business_latency import BusinessLatencyEstimator


def _exit(latency_ms=None):
    return SimpleNamespace(
        latency_ms=latency_ms,
        latency_checked_at="",
        latency_probe_failures=0,
        latency_probe_error="",
    )


def test_business_latency_uses_ewma_after_first_sample():
    estimator = BusinessLatencyEstimator(alpha=0.25)
    exit_obj = _exit(100)

    value = estimator.record_success(exit_obj, 300, "2026-08-05 12:00:00")

    assert value == 150
    assert exit_obj.latency_ms == 150
    assert exit_obj.latency_checked_at == "2026-08-05 12:00:00"


def test_business_latency_failure_keeps_last_good_sample():
    estimator = BusinessLatencyEstimator()
    exit_obj = _exit(88)

    estimator.record_failure(exit_obj, "HTTP 429", "2026-08-05 12:01:00")

    assert exit_obj.latency_ms == 88
    assert exit_obj.latency_probe_failures == 1
    assert exit_obj.latency_probe_error == "HTTP 429"
