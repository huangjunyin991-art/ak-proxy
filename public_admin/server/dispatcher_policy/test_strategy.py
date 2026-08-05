from types import SimpleNamespace

from .strategy import FairLoadStrategy


class Exit(SimpleNamespace):
    def count_recent_requests(self, window):
        return self.rpm if window >= 60 else self.rps


def _exit(*, rps=0, rpm=0, active=0, latency_ms=None, rate_limit=0):
    return Exit(rps=rps, rpm=rpm, active=active, latency_ms=latency_ms, rate_limit=rate_limit)


def test_fair_load_strategy_uses_latency_only_after_load_dimensions():
    exits = [
        _exit(rps=1, latency_ms=10),
        _exit(rps=0, latency_ms=500),
    ]

    picked = FairLoadStrategy().pick(exits, [0, 1], rr_counter=0, per_second_limit=3)

    assert picked == 1


def test_fair_load_strategy_assigns_missing_latency_the_measured_median():
    exits = [
        _exit(latency_ms=10),
        _exit(latency_ms=None),
        _exit(latency_ms=500),
    ]

    ordered = FairLoadStrategy().order(exits, [0, 1, 2], rr_counter=0, per_second_limit=3)

    assert ordered == [0, 1, 2]
