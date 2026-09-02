from dataclasses import replace

from .resource_guard import ProcessResourceGuard, ResourceGuardConfig


def _sample(ratio: float) -> dict:
    return {"fd_count": int(1000 * ratio), "soft_limit": 1000, "hard_limit": 2000, "fd_ratio": ratio}


def test_resource_guard_requires_sustained_breach_and_minimum_uptime():
    clock = [0.0]
    terminated = []
    config = replace(
        ResourceGuardConfig(),
        warning_ratio=0.70,
        critical_ratio=0.85,
        critical_hold_seconds=15.0,
        minimum_uptime_seconds=120.0,
        restart_cooldown_seconds=300.0,
    )
    guard = ProcessResourceGuard(config=config, now=lambda: clock[0], terminate=lambda: terminated.append(True))

    assert guard.evaluate(_sample(0.80), now=0.0) == "warning"
    assert guard.evaluate(_sample(0.90), now=1.0) == "critical"
    assert guard.evaluate(_sample(0.90), now=16.0) == "critical"
    clock[0] = 121.0
    assert guard.evaluate(_sample(0.90), now=121.0) == "restart"
    assert terminated == []  # evaluate is side-effect free; the loop performs termination.
    assert guard.status()["restart_requested"] is True


def test_resource_guard_does_not_restart_for_unavailable_proc_snapshot():
    guard = ProcessResourceGuard(config=replace(ResourceGuardConfig(), minimum_uptime_seconds=0.0))

    assert guard.evaluate({"fd_count": None, "soft_limit": 1024, "fd_ratio": 0.0}, now=1.0) == "ok"
