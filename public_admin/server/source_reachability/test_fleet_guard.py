import time
from types import SimpleNamespace

from ..dispatcher_policy.failure_ladder import (
    CONNECTION_FAILURE_FREEZE_SCHEDULE,
    connection_failure_freeze_seconds,
)
from ..outbound_dispatcher import OutboundExit
from .fleet_guard import SourceFleetGuard
from .state_store import SourceFleetStateStore


def _verified_exit(index: int) -> OutboundExit:
    exit_obj = OutboundExit(
        f"exit-{index}",
        f"socks5://127.0.0.1:{10000 + index}",
        node_identity=f"node-{index}",
    )
    exit_obj.source_probe_ready = True
    exit_obj.source_probe_last_success_at = 1000.0 + index
    return exit_obj


def test_connection_failure_ladder_is_exact_and_capped():
    values = [connection_failure_freeze_seconds(level) for level in range(1, 10)]

    assert values[:7] == list(CONNECTION_FAILURE_FREEZE_SCHEDULE)
    assert values[7:] == [3600, 3600]


def test_success_resets_connection_failure_ladder():
    exit_obj = _verified_exit(1)
    exit_obj.freeze_for_connect_error("first")
    exit_obj.freeze_for_connect_error("second")

    assert exit_obj._connect_failures == 2
    assert round(exit_obj.frozen_remaining) <= 30

    exit_obj.reset_connect_failures()
    exit_obj.freeze_for_connect_error("after-success")

    assert exit_obj._connect_failures == 1
    assert round(exit_obj.frozen_remaining) <= 10


def test_normal_batch_failure_only_protects_enough_to_reach_floor():
    exits = [_verified_exit(index) for index in range(105)]
    guard = SourceFleetGuard(minimum_ready=100, circuit_min_incumbents=20, circuit_failure_ratio=0.5)
    snapshots = guard.snapshot(exits)
    results = [False] * 10 + [True] * 95
    for exit_obj in exits[:10]:
        exit_obj.source_probe_ready = False

    decision = guard.reconcile(exits, snapshots, results)

    assert decision.circuit_open is False
    assert decision.protected_count == 5
    assert decision.ready_count == 100


def test_mass_batch_failure_opens_circuit_and_preserves_incumbents():
    exits = [_verified_exit(index) for index in range(120)]
    guard = SourceFleetGuard(minimum_ready=100, circuit_min_incumbents=20, circuit_failure_ratio=0.5)
    snapshots = guard.snapshot(exits)
    for exit_obj in exits:
        exit_obj.source_probe_ready = False

    decision = guard.reconcile(exits, snapshots, [False] * len(exits))

    assert decision.circuit_open is True
    assert decision.protected_count == 120
    assert decision.ready_count == 120


def test_connect_failure_freezing_stops_at_verified_floor():
    exits = [_verified_exit(index) for index in range(101)]
    guard = SourceFleetGuard(minimum_ready=100)

    assert guard.allow_connect_failure_freeze(exits, exits[0]) is True
    exits[0].freeze_for_connect_error("first")
    assert guard.allow_connect_failure_freeze(exits, exits[1]) is False


def test_successful_source_probe_resets_connection_failure_ladder():
    exit_obj = _verified_exit(1)
    exit_obj.freeze_for_connect_error("first")
    exit_obj.freeze_for_connect_error("second")
    exit_obj._frozen_until = 0

    from ..outbound_dispatcher import OutboundDispatcher

    dispatcher = OutboundDispatcher()

    async def successful_probe(_exit_obj, _policy):
        return SimpleNamespace(reachable=True, status_code=403, error="", elapsed_ms=120)

    dispatcher._request_source_probe = successful_probe

    import asyncio

    assert asyncio.run(dispatcher._probe_source_exit(exit_obj)) is True
    assert exit_obj._connect_failures == 0
    assert exit_obj._frozen_reason == ""
    assert exit_obj.latency_ms == 120
    assert exit_obj.latency_checked_at == exit_obj.source_probe_checked_at


def test_unverified_and_429_exits_are_never_promoted_for_floor():
    verified = [_verified_exit(index) for index in range(2)]
    unverified = OutboundExit("fresh", "socks5://127.0.0.1:12000", node_identity="fresh")
    guard = SourceFleetGuard(minimum_ready=100, circuit_min_incumbents=2, circuit_failure_ratio=0.5)
    exits = [*verified, unverified]
    snapshots = guard.snapshot(exits)
    for exit_obj in verified:
        exit_obj.source_probe_ready = False
        exit_obj.source_probe_status_code = 429

    decision = guard.reconcile(exits, snapshots, [False, False, False])

    assert decision.protected_count == 0
    assert not any(exit_obj.is_dispatch_ready for exit_obj in exits)


def test_state_store_restores_last_known_good_metadata(tmp_path):
    exit_obj = _verified_exit(7)
    exit_obj.source_probe_ready = False
    exit_obj.source_probe_protected = True
    exit_obj._connect_failures = 3
    exit_obj._frozen_until = time.time() + 60
    exit_obj._frozen_reason = "连接失败×3"
    exit_obj.latency_ms = 88
    exit_obj.latency_checked_at = "2026-08-05 12:00:00"
    store = SourceFleetStateStore(tmp_path / "fleet.json")

    store.save([exit_obj])
    loaded = store.load()["node-7"]

    assert loaded["source_probe_protected"] is True
    assert loaded["source_probe_last_success_at"] == 1007.0
    assert loaded["connect_failures"] == 3
    assert loaded["business_latency_ms"] == 88
    assert loaded["business_latency_checked_at"] == "2026-08-05 12:00:00"


def test_state_store_persists_403_protection_gradient(tmp_path):
    exit_obj = _verified_exit(8)
    exit_obj.warn_403 = 4
    exit_obj._403_freeze_level = 2
    exit_obj._frozen_until = time.time() + 180
    exit_obj._frozen_reason = "403保护×2"
    store = SourceFleetStateStore(tmp_path / "fleet.json")

    store.save([exit_obj])
    loaded = store.load()["node-8"]

    assert loaded["warn_403"] == 4
    assert loaded["403_freeze_level"] == 2
    assert loaded["frozen_reason"] == "403保护×2"


def test_dispatcher_restores_403_protection_gradient_for_new_exit(monkeypatch, tmp_path):
    original = _verified_exit(10)
    original.warn_403 = 5
    original._403_freeze_level = 3
    original._frozen_until = time.time() + 300
    original._frozen_reason = "403保护×3"
    path = tmp_path / "fleet.json"
    SourceFleetStateStore(path).save([original])
    monkeypatch.setenv("AK_PROXY_SOURCE_FLEET_STATE_FILE", str(path))

    from ..outbound_dispatcher import OutboundDispatcher

    dispatcher = OutboundDispatcher()
    dispatcher._load_source_fleet_state()
    index = dispatcher.add_socks5("restored-403", 12010, node_identity="node-10")
    restored = dispatcher.exits[index]

    assert restored.warn_403 == 5
    assert restored._403_freeze_level == 3
    assert restored._frozen_reason == "403保护×3"
    assert restored.is_frozen is True


def test_dispatcher_restores_persisted_state_for_new_exit(monkeypatch, tmp_path):
    original = _verified_exit(9)
    original.source_probe_protected = True
    original._connect_failures = 4
    original.latency_ms = 76
    original.latency_checked_at = "2026-08-05 12:00:00"
    path = tmp_path / "fleet.json"
    SourceFleetStateStore(path).save([original])
    monkeypatch.setenv("AK_PROXY_SOURCE_FLEET_STATE_FILE", str(path))

    from ..outbound_dispatcher import OutboundDispatcher

    dispatcher = OutboundDispatcher()
    dispatcher._load_source_fleet_state()
    index = dispatcher.add_socks5("restored", 12009, node_identity="node-9")
    restored = dispatcher.exits[index]

    assert restored.source_probe_protected is True
    assert restored.source_probe_last_success_at == 1009.0
    assert restored._connect_failures == 4
    assert restored.latency_ms == 76
    assert restored.latency_checked_at == "2026-08-05 12:00:00"
