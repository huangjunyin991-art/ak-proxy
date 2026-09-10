from .rate_limit_feedback import RateLimitFeedback


class Clock:
    def __init__(self, value: float) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


def test_fresh_429_immediately_lowers_weight_then_recovers_with_time():
    clock = Clock(1000.0)
    feedback = RateLimitFeedback(recovery_seconds=60, clock=clock)

    assert feedback.scheduling_state() == (0, 1.0)
    assert feedback.recovery_weight() == 1.0

    feedback.record_429()

    assert feedback.scheduling_state() == (1, 0.05)
    assert feedback.recovery_weight() == 0.0

    clock.advance(30)

    assert feedback.is_active() is True
    assert feedback.recovery_weight() == 0.5

    clock.advance(30)

    assert feedback.scheduling_state() == (0, 1.0)
    assert feedback.recovery_weight() == 1.0


def test_earlier_429_sorts_before_more_recent_429_when_all_are_limited():
    clock = Clock(2000.0)
    earlier = RateLimitFeedback(clock=clock)
    recent = RateLimitFeedback(clock=clock)
    earlier.record_429(now=1960.0)
    recent.record_429(now=1995.0)

    assert earlier.scheduling_state()[1] > recent.scheduling_state()[1]
    assert earlier.recovery_weight() > recent.recovery_weight()


def test_status_reports_bounded_one_and_five_minute_windows():
    clock = Clock(3000.0)
    feedback = RateLimitFeedback(clock=clock)
    feedback.record_request(now=2701.0)
    feedback.record_429(now=2701.0)
    feedback.record_request(now=2941.0)
    feedback.record_429(now=2941.0)
    feedback.record_request(now=3000.0)

    status = feedback.status()

    assert status["requests_1m"] == 2
    assert status["requests_5m"] == 3
    assert status["responses_429_1m"] == 1
    assert status["responses_429_5m"] == 2


def test_state_restore_keeps_live_feedback_and_discards_stale_feedback():
    source_clock = Clock(4000.0)
    source = RateLimitFeedback(clock=source_clock)
    source.record_request()
    source.record_429()
    state = source.dump_state()

    live = RateLimitFeedback(clock=Clock(4030.0))
    live.restore_state(state)
    assert live.status()["active"] is True
    assert live.status()["responses_429_1m"] == 1

    stale = RateLimitFeedback(clock=Clock(4400.0))
    stale.restore_state(state)
    assert stale.status()["active"] is False
    assert stale.status()["responses_429_5m"] == 0
