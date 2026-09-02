import pytest
import httpx
import asyncio

from .outbound_dispatcher import OutboundDispatcher, OutboundExit, RpcUpstreamNonJsonError
from .dispatcher_policy import rate_limiter as rate_limiter_module
from .rpc_timeout_policy import LOGIN_RPC_TIMEOUT_SECONDS
from .source_reachability import SourceProbeResult


def _saturate_regular_direct(dispatcher: OutboundDispatcher) -> None:
    direct = dispatcher.exits[0]
    for _ in range(dispatcher.DIRECT_FALLBACK_RATE_PER_MINUTE):
        direct.record_request()


def _add_ready_socks5(dispatcher: OutboundDispatcher, name: str, port: int, **kwargs) -> int:
    idx = dispatcher.add_socks5(name, port, **kwargs)
    dispatcher.exits[idx].source_probe_ready = True
    return idx


def test_replacing_tunnel_generation_keeps_direct_and_returns_old_exits():
    dispatcher = OutboundDispatcher()
    old_index = _add_ready_socks5(dispatcher, "old", 10001)
    old_exit = dispatcher.exits[old_index]

    retired = dispatcher.replace_socks5_exits([
        {"name": "new-a", "port": 30001, "core_type": "singbox", "node_type": "hysteria2"},
        {"name": "new-b", "port": 30002, "core_type": "singbox"},
    ])

    assert dispatcher.exits[0].is_direct is True
    assert [item.name for item in dispatcher.exits[1:]] == ["new-a", "new-b"]
    assert dispatcher.exits[1].node_type == "hysteria2"
    assert dispatcher.get_status()["exits"][1]["node_type"] == "hysteria2"
    assert retired == [old_exit]


@pytest.mark.anyio
async def test_request_error_defers_shared_client_close_until_exit_is_idle():
    class FakeClient:
        def __init__(self):
            self.is_closed = False
            self.close_calls = 0

        async def aclose(self):
            self.close_calls += 1
            self.is_closed = True

    exit_obj = OutboundExit("exit", "socks5://127.0.0.1:10001")
    client = FakeClient()
    exit_obj._client = client
    exit_obj.active = 2

    exit_obj.request_client_retire("request_error")
    await exit_obj.finalize_client_retirement()
    assert client.close_calls == 0
    assert exit_obj._client_retire_pending is True

    exit_obj.active = 0
    assert await exit_obj.finalize_client_retirement() is True
    assert client.close_calls == 1
    assert exit_obj._client_retire_pending is False


@pytest.mark.anyio
async def test_pending_client_retirement_rotates_new_requests_without_closing_inflight_client(monkeypatch):
    class FakeClient:
        def __init__(self):
            self.is_closed = False
            self.close_calls = 0

        async def aclose(self):
            self.close_calls += 1
            self.is_closed = True

    clients = []

    def fake_async_client(**_kwargs):
        client = FakeClient()
        clients.append(client)
        return client

    monkeypatch.setattr("public_admin.server.outbound_dispatcher.httpx.AsyncClient", fake_async_client)
    exit_obj = OutboundExit("exit", "socks5://127.0.0.1:10001")
    first = await exit_obj.get_client()
    exit_obj.active = 1  # an earlier request still owns the first client
    exit_obj.request_client_retire("request_error")

    second = await exit_obj.get_client()
    assert second is not first
    assert first.close_calls == 0
    assert exit_obj.client_snapshot()["retired_clients"] == 1

    exit_obj.active = 0
    assert await exit_obj.finalize_client_retirement() is True
    assert first.close_calls == 1
    assert second.close_calls == 0


@pytest.mark.anyio
async def test_retired_client_closes_when_its_generation_has_no_leases(monkeypatch):
    class FakeClient:
        def __init__(self):
            self.is_closed = False
            self.close_calls = 0

        async def aclose(self):
            self.close_calls += 1
            self.is_closed = True

    clients = []

    def fake_async_client(**_kwargs):
        client = FakeClient()
        clients.append(client)
        return client

    monkeypatch.setattr("public_admin.server.outbound_dispatcher.httpx.AsyncClient", fake_async_client)
    exit_obj = OutboundExit("exit", "socks5://127.0.0.1:10001")
    first = await exit_obj.get_client()
    exit_obj.acquire_client(first)
    exit_obj.active = 1
    exit_obj.request_client_retire("request_error")

    second = await exit_obj.get_client()
    exit_obj.acquire_client(second)
    exit_obj.release_client(first)
    # The second generation remains active, but the retired first generation
    # is now provably unused and must not consume sockets indefinitely.
    assert await exit_obj.finalize_client_retirement() is True
    assert first.close_calls == 1
    assert second.close_calls == 0
    assert exit_obj.client_snapshot()["retired_clients"] == 0


@pytest.mark.anyio
async def test_close_client_when_idle_waits_for_inflight_request():
    class FakeClient:
        def __init__(self):
            self.is_closed = False
            self.close_calls = 0

        async def aclose(self):
            self.close_calls += 1
            self.is_closed = True

    exit_obj = OutboundExit("exit", "socks5://127.0.0.1:10001")
    client = FakeClient()
    exit_obj._client = client
    exit_obj.active = 1

    close_task = asyncio.create_task(exit_obj.close_client_when_idle("removed_exit"))
    await asyncio.sleep(0)
    assert client.close_calls == 0

    exit_obj.active = 0
    assert await close_task is True
    assert client.close_calls == 1


def test_replacing_matching_node_keeps_verified_source_state():
    dispatcher = OutboundDispatcher()
    old_index = _add_ready_socks5(dispatcher, "preserved", 10001, node_identity="node-a")
    old_exit = dispatcher.exits[old_index]
    old_exit.source_probe_checked_at = "2026-07-27 23:00:00"
    old_exit.source_probe_status_code = 403
    old_exit.latency_ms = 88
    old_exit.freeze(60, "received 403")

    dispatcher.replace_socks5_exits([
        {"name": "preserved", "port": 30001, "core_type": "singbox", "node_identity": "node-a"},
    ])

    replacement = dispatcher.exits[1]
    assert replacement.local_port == 30001
    assert replacement.source_probe_ready is True
    assert replacement.is_dispatch_ready is True
    assert replacement.source_probe_status_code == 403
    assert replacement.latency_ms == 88
    assert replacement.is_frozen is True


def test_replacing_matching_node_keeps_visible_upstream_alert_counts():
    dispatcher = OutboundDispatcher()
    old_index = _add_ready_socks5(dispatcher, "preserved", 10001, node_identity="node-a")
    old_exit = dispatcher.exits[old_index]
    old_exit.warn_403 = 3
    old_exit.warn_429 = 2

    dispatcher.replace_socks5_exits([
        {"name": "preserved", "port": 30001, "core_type": "singbox", "node_identity": "node-a"},
    ])

    replacement = dispatcher.exits[1]
    assert replacement.warn_403 == 3
    assert replacement.warn_429 == 2
    assert dispatcher.get_status()["exits"][1]["warn_403"] == 3
    assert dispatcher.get_status()["exits"][1]["warn_429"] == 2


def test_business_403_freeze_ladder_is_exact_capped_and_resets():
    exit_obj = OutboundExit("exit", "socks5://127.0.0.1:10001")
    schedule = OutboundDispatcher.BUSINESS_403_FREEZE_SCHEDULE

    for level, seconds in enumerate([*schedule, schedule[-1]], start=1):
        exit_obj.freeze_for_403_gradient(schedule)
        expected_level = min(level, len(schedule))

        assert exit_obj._403_freeze_level == expected_level
        assert exit_obj._frozen_reason == f"403保护×{expected_level}"
        assert seconds - 1 <= exit_obj.frozen_remaining <= seconds

    assert exit_obj.reset_403_protection() is True
    assert exit_obj._403_freeze_level == 0
    assert exit_obj.is_frozen is False

    exit_obj.freeze_for_403_gradient(schedule)
    assert exit_obj._403_freeze_level == 1


def test_replacing_matching_node_keeps_403_protection_state():
    dispatcher = OutboundDispatcher()
    old_index = _add_ready_socks5(dispatcher, "preserved", 10001, node_identity="node-a")
    old_exit = dispatcher.exits[old_index]
    old_exit.freeze_for_403_gradient(dispatcher.BUSINESS_403_FREEZE_SCHEDULE)

    dispatcher.replace_socks5_exits([
        {"name": "preserved", "port": 30001, "core_type": "singbox", "node_identity": "node-a"},
    ])

    replacement = dispatcher.exits[1]
    assert replacement._403_freeze_level == 1
    assert replacement._frozen_reason == "403保护×1"
    assert replacement.is_frozen is True


def test_replacing_unverified_node_schedules_immediate_source_probe(monkeypatch):
    dispatcher = OutboundDispatcher()
    dispatcher._started = True
    scheduled = []

    monkeypatch.setattr(dispatcher, "_ensure_health_check_started", lambda: None)
    monkeypatch.setattr(dispatcher, "_schedule_single_exit_source_probe", lambda ex: scheduled.append(ex.name))

    dispatcher.replace_socks5_exits([
        {"name": "new", "port": 30001, "core_type": "singbox", "node_identity": "node-new"},
    ])

    assert scheduled == ["new"]


def test_subscription_fetch_candidates_are_ready_and_group_diverse():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "group-one-a", 10001, group_id="group-one")
    _add_ready_socks5(dispatcher, "group-one-b", 10002, group_id="group-one")
    _add_ready_socks5(dispatcher, "group-two", 10003, group_id="group-two")
    frozen_index = _add_ready_socks5(dispatcher, "frozen", 10004, group_id="group-three")
    dispatcher.exits[frozen_index].freeze(60, "test")

    candidates = dispatcher.get_subscription_fetch_tunnel_candidates()

    assert len(candidates) == 2
    assert {item["name"] for item in candidates} == {"group-one-a", "group-two"}
    assert all(item["proxy_url"].startswith("socks5://127.0.0.1:") for item in candidates)


def test_critical_rpc_can_use_emergency_direct_after_regular_direct_bucket_is_full():
    dispatcher = OutboundDispatcher()
    _saturate_regular_direct(dispatcher)

    picked = dispatcher.pick_api_exit("Logout")

    assert picked.is_direct
    assert dispatcher._count_direct_critical_requests(60.0) == 1


def test_non_critical_rpc_still_respects_regular_direct_fallback_limit():
    dispatcher = OutboundDispatcher()
    _saturate_regular_direct(dispatcher)

    with pytest.raises(RuntimeError, match="all api exits"):
        dispatcher.pick_api_exit("ACE_Sell_Son")


def test_direct_exhaustion_does_not_bypass_tunnel_rate_capacity():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "tunnel-1", 10001)
    tunnel = dispatcher.exits[1]
    tunnel.rate_limit = 1
    tunnel.record_request()
    _saturate_regular_direct(dispatcher)

    with pytest.raises(RuntimeError, match="all api exits"):
        dispatcher.pick_api_exit("ACE_Sell_Son")


def test_api_selection_skips_tunnel_until_source_probe_succeeds():
    dispatcher = OutboundDispatcher()
    dispatcher.add_socks5("pending-ip-detect", 10001)

    picked = dispatcher.pick_api_exit("ACE_Sell_Son")

    assert picked.is_direct

    dispatcher.exits[1].source_probe_ready = True

    picked = dispatcher.pick_api_exit("ACE_Sell_Son")

    assert picked.name == "pending-ip-detect"


def test_login_direct_exhaustion_does_not_bypass_tunnel_rate_capacity():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "login-tunnel", 10002)
    tunnel = dispatcher.exits[1]
    tunnel.rate_limit = 1
    tunnel.record_request()
    _saturate_regular_direct(dispatcher)

    with pytest.raises(RuntimeError, match="all login exits"):
        dispatcher.pick_login_exit()


def test_critical_direct_fallback_has_own_rate_limit():
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config = None
    dispatcher.DIRECT_CRITICAL_FALLBACK_RATE_PER_SECOND = 2
    dispatcher.DIRECT_CRITICAL_FALLBACK_RATE_PER_MINUTE = 2

    dispatcher.pick_api_exit("/RPC/Logout")
    dispatcher.pick_api_exit("Logout")

    with pytest.raises(RuntimeError, match="all api exits"):
        dispatcher.pick_api_exit("Logout")


def test_wide_spread_rpc_spreads_across_more_tunnels_without_latency_priority():
    dispatcher = OutboundDispatcher()
    for idx in range(3):
        _add_ready_socks5(dispatcher, f"tunnel-{idx}", 10001 + idx)
        dispatcher.exits[idx + 1].latency_ms = idx + 1

    picked = [dispatcher.pick_api_exit("My_Subaccount").name for _ in range(3)]

    assert set(picked) == {"tunnel-0", "tunnel-1", "tunnel-2"}


def test_wide_spread_rpc_does_not_change_regular_latency_strategy():
    dispatcher = OutboundDispatcher()
    for idx, latency in enumerate([300, 10, 200]):
        _add_ready_socks5(dispatcher, f"tunnel-{idx}", 10001 + idx)
        dispatcher.exits[idx + 1].latency_ms = latency

    picked = dispatcher.pick_api_exit("Public_ACE")

    assert picked.name == "tunnel-1"


def test_ace_sell_uses_wide_spread_rpc_policy():
    dispatcher = OutboundDispatcher()
    for idx in range(2):
        _add_ready_socks5(dispatcher, f"sell-tunnel-{idx}", 10001 + idx)

    picked = [dispatcher.pick_api_exit("ACE_Sell").name for _ in range(2)]

    assert set(picked) == {"sell-tunnel-0", "sell-tunnel-1"}


def test_ace_sell_son_uses_wide_spread_rpc_policy():
    dispatcher = OutboundDispatcher()
    for idx in range(2):
        _add_ready_socks5(dispatcher, f"sell-son-tunnel-{idx}", 10001 + idx)

    picked = [dispatcher.pick_api_exit("ACE_Sell_Son").name for _ in range(2)]

    assert set(picked) == {"sell-son-tunnel-0", "sell-son-tunnel-1"}


def test_my_subaccount_uses_all_eligible_exits():
    dispatcher = OutboundDispatcher()
    for idx, latency in enumerate([1, 200, 300]):
        _add_ready_socks5(dispatcher, f"tunnel-{idx}", 10001 + idx)
        dispatcher.exits[idx + 1].latency_ms = latency

    picked = [dispatcher.pick_api_exit("My_Subaccount").name for _ in range(3)]

    assert set(picked) == {"tunnel-0", "tunnel-1", "tunnel-2"}


def test_wide_spread_rpc_prefers_lower_recent_rate_over_latency():
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config.per_exit_rate_per_second = 20
    _add_ready_socks5(dispatcher, "hot-fast", 10001, group_id="g1")
    _add_ready_socks5(dispatcher, "idle-slow", 10002, group_id="g2")
    dispatcher.exits[1].latency_ms = 1
    dispatcher.exits[2].latency_ms = 300
    for _ in range(5):
        dispatcher.exits[1].record_request()

    picked = dispatcher.pick_api_exit("ACE_Sell")

    assert picked.name == "idle-slow"


def test_regular_rpc_prefers_idle_exit_before_faster_busy_exit():
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config.per_exit_rate_per_second = 20
    _add_ready_socks5(dispatcher, "hot-fast", 10001, group_id="g1")
    _add_ready_socks5(dispatcher, "idle-slow", 10002, group_id="g2")
    dispatcher.exits[1].latency_ms = 1
    dispatcher.exits[2].latency_ms = 300
    for _ in range(5):
        dispatcher.exits[1].record_request()

    picked = dispatcher.pick_api_exit("Public_ACE")

    assert picked.name == "idle-slow"


def test_regular_rpc_uses_lifetime_requests_before_latency_when_current_load_is_equal():
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config.per_exit_rate_per_second = 20
    _add_ready_socks5(dispatcher, "historically-busy", 10001)
    _add_ready_socks5(dispatcher, "historically-idle", 10002)
    dispatcher.exits[1].latency_ms = 1
    dispatcher.exits[2].latency_ms = 500
    dispatcher.exits[1].total = 80

    picked = dispatcher.pick_api_exit("Public_ACE")

    assert picked.name == "historically-idle"


def test_regular_rpc_rotates_across_all_eligible_exits_before_reusing_one():
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config.per_exit_rate_per_second = 20
    for idx, latency in enumerate([10, 200, 500]):
        _add_ready_socks5(dispatcher, f"tunnel-{idx}", 10001 + idx)
        dispatcher.exits[idx + 1].latency_ms = latency

    picked = [dispatcher.pick_api_exit("Public_EP_SellRecords1").name for _ in range(3)]

    assert picked == ["tunnel-0", "tunnel-1", "tunnel-2"]


def test_dynamic_exit_pacing_rotates_then_releases_after_cooldown(monkeypatch):
    class Clock:
        def __init__(self):
            self.value = 100.0

        def __call__(self):
            return self.value

        def advance(self, seconds):
            self.value += seconds

    clock = Clock()
    monkeypatch.setattr(rate_limiter_module.time, "monotonic", clock)
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config.per_exit_rate_per_second = 3
    first_index = _add_ready_socks5(dispatcher, "first", 10001)
    second_index = _add_ready_socks5(dispatcher, "second", 10002)

    first = dispatcher.pick_api_exit("Public_ACE")
    second = dispatcher.pick_api_exit("Public_ACE")

    assert {first.name, second.name} == {"first", "second"}
    assert dispatcher._exit_below_per_second_limit(dispatcher.exits[first_index]) is False
    assert dispatcher._exit_below_per_second_limit(dispatcher.exits[second_index]) is False

    clock.advance(1 / 3)

    assert dispatcher._exit_below_per_second_limit(dispatcher.exits[first_index]) is True
    assert dispatcher.try_reserve_exit(dispatcher.exits[first_index], "Public_ACE") is True


@pytest.mark.anyio
async def test_connection_failure_fallback_skips_exit_reserved_during_attempt():
    dispatcher = OutboundDispatcher()
    failed_index = _add_ready_socks5(dispatcher, "failed", 10001, group_id="g1")
    cooling_index = _add_ready_socks5(dispatcher, "cooling", 10002, group_id="g2")
    _add_ready_socks5(dispatcher, "ready", 10003, group_id="g3")
    attempts = []

    async def fake_request(exit_obj, *_args, **_kwargs):
        attempts.append(exit_obj.name)
        if exit_obj.name == "failed":
            assert dispatcher.try_reserve_exit(dispatcher.exits[cooling_index], "Public_ACE") is True
            raise httpx.ConnectError("proxy connection failed")
        return httpx.Response(
            200,
            json={"Error": False, "Data": {"ok": True}},
            headers={"content-type": "application/json"},
        )

    dispatcher._do_request = fake_request
    response = await dispatcher.forward(
        dispatcher.exits[failed_index],
        "POST",
        "https://example.test/RPC/Public_ACE",
        {},
        content_type="application/x-www-form-urlencoded",
        params={"account": "demo"},
        raw_body=b"",
        api_path="Public_ACE",
        max_tunnel_fallbacks=2,
    )

    assert attempts == ["failed", "ready"]
    assert response.json()["Data"]["ok"] is True


def test_exit_without_latency_sample_remains_eligible_with_neutral_latency():
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config.per_exit_rate_per_second = 20
    _add_ready_socks5(dispatcher, "fast", 10001)
    _add_ready_socks5(dispatcher, "unmeasured", 10002)
    _add_ready_socks5(dispatcher, "slow", 10003)
    dispatcher.exits[1].latency_ms = 20
    dispatcher.exits[3].latency_ms = 500

    picked = [dispatcher.pick_api_exit("Public_ACE").name for _ in range(3)]

    assert picked == ["fast", "unmeasured", "slow"]


def test_fair_strategy_accounts_for_different_minute_capacities():
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config.per_exit_rate_per_second = 20
    _add_ready_socks5(dispatcher, "small-capacity", 10001)
    _add_ready_socks5(dispatcher, "large-capacity", 10002)
    dispatcher.exits[1].rate_limit = 6
    dispatcher.exits[2].rate_limit = 60
    dispatcher.exits[1].record_request()
    dispatcher.exits[2].record_request()

    picked = dispatcher.pick_api_exit("Public_IndexData")

    assert picked.name == "large-capacity"


def test_login_spreads_across_subscription_groups_without_latency_bias():
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config.per_exit_rate_per_second = 20
    for group_idx, latency in enumerate([1, 200, 400], start=1):
        for node_idx in range(2):
            _add_ready_socks5(dispatcher, f"g{group_idx}-node-{node_idx}", 10000 + group_idx * 10 + node_idx, group_id=f"g{group_idx}")
            dispatcher.exits[-1].latency_ms = latency

    picked = [dispatcher.pick_login_exit() for _ in range(6)]
    groups = [item.group_id for item in picked]

    assert {group: groups.count(group) for group in set(groups)} == {"g1": 2, "g2": 2, "g3": 2}


def test_login_spreads_within_same_subscription_group_before_reusing_exit():
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config.per_exit_rate_per_second = 20
    for idx in range(3):
        _add_ready_socks5(dispatcher, f"same-group-{idx}", 10001 + idx, group_id="g1")

    picked = [dispatcher.pick_login_exit().name for _ in range(3)]

    assert set(picked) == {"same-group-0", "same-group-1", "same-group-2"}


def test_login_prefers_less_used_subscription_group_over_fast_group():
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config.per_exit_rate_per_second = 20
    _add_ready_socks5(dispatcher, "fast-used", 10001, group_id="g1")
    _add_ready_socks5(dispatcher, "slow-idle", 10002, group_id="g2")
    dispatcher.exits[1].latency_ms = 1
    dispatcher.exits[2].latency_ms = 500
    for _ in range(3):
        dispatcher.exits[1].reserve_login()

    picked = dispatcher.pick_login_exit()

    assert picked.name == "slow-idle"


def test_fallback_sequence_tries_three_tunnels_then_direct_across_groups():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "failed", 10001, group_id="g1")
    _add_ready_socks5(dispatcher, "same-group", 10002, group_id="g1")
    _add_ready_socks5(dispatcher, "group-2", 10003, group_id="g2")
    _add_ready_socks5(dispatcher, "group-3", 10004, group_id="g3")
    _add_ready_socks5(dispatcher, "group-4", 10005, group_id="g4")

    attempts = dispatcher._fallback_sequence(dispatcher.exits[1], "Public_ACE")

    assert [item.name for item in attempts] == ["group-2", "group-3", "group-4", "direct"]


def test_fallback_sequence_keeps_availability_before_group_spread():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "failed", 10001, group_id="g1")
    _add_ready_socks5(dispatcher, "frozen-other-group", 10002, group_id="g2")
    _add_ready_socks5(dispatcher, "unhealthy-other-group", 10003, group_id="g3")
    _add_ready_socks5(dispatcher, "healthy-same-group", 10004, group_id="g1")
    dispatcher.exits[2].freeze(60, "test")
    dispatcher.exits[3].healthy = False

    attempts = dispatcher._fallback_sequence(dispatcher.exits[1], "My_Subaccount")

    assert [item.name for item in attempts] == ["healthy-same-group", "direct"]


def test_fallback_spreads_across_available_subscription_groups():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "failed", 10001, group_id="g1")
    for idx, group_id in enumerate(["g2", "g3", "g4"], start=2):
        _add_ready_socks5(dispatcher, f"group-{idx}", 10000 + idx, group_id=group_id)

    attempts = dispatcher._fallback_sequence(dispatcher.exits[1], "My_Subaccount")

    assert [item.name for item in attempts] == ["group-2", "group-3", "group-4", "direct"]


@pytest.mark.anyio
async def test_start_starts_initial_and_periodic_source_probe_tasks(monkeypatch):
    dispatcher = OutboundDispatcher()
    created = []

    class DummyTask:
        def __init__(self, name):
            self.name = name

        def done(self):
            return False

    def fake_create_task(coro, name=""):
        coro.close()
        created.append(name)
        return DummyTask(name)

    monkeypatch.setattr(dispatcher, "_ensure_health_check_started", lambda: None)
    monkeypatch.setattr(dispatcher, "_safe_create_task", fake_create_task)

    await dispatcher.start()

    assert created == ["initial_source_probe", "periodic_source_probe", "failed_source_probe"]
    assert dispatcher._initial_source_probe_task is not None
    assert dispatcher._periodic_source_probe_task is not None
    assert dispatcher._failed_source_probe_task is not None


@pytest.mark.anyio
async def test_probe_failed_sources_only_probes_due_unavailable_exits(monkeypatch):
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "healthy", 10001)
    _add_ready_socks5(dispatcher, "failed-a", 10002)
    _add_ready_socks5(dispatcher, "failed-b", 10003)
    dispatcher.exits[1].source_probe_ready = False
    dispatcher.exits[2].source_probe_ready = False
    dispatcher.exits[2].source_probe_failures = 2
    dispatcher.exits[3].source_probe_ready = False
    dispatcher.exits[3].source_probe_last_error = "timeout"
    probed = []

    async def fake_probe(exits_snapshot):
        probed.extend(ex.name for ex in exits_snapshot)
        return [True, False, False]

    monkeypatch.setattr(dispatcher, "_probe_source_batch", fake_probe)

    recovered = await dispatcher.probe_failed_sources()

    assert probed == ["healthy", "failed-a", "failed-b"]
    assert recovered == 1


def test_health_check_source_probe_requests_are_batched(monkeypatch):
    dispatcher = OutboundDispatcher()
    first = _add_ready_socks5(dispatcher, "first", 10001)
    second = _add_ready_socks5(dispatcher, "second", 10002)
    dispatcher.exits[first].source_probe_ready = False
    dispatcher.exits[second].source_probe_ready = False
    scheduled = []

    class PendingTask:
        def done(self):
            return False

    def fake_create_task(coro, name=""):
        coro.close()
        scheduled.append(name)
        return PendingTask()

    monkeypatch.setattr(dispatcher, "_safe_create_task", fake_create_task)

    dispatcher._schedule_single_exit_source_probe(dispatcher.exits[first])
    dispatcher._schedule_single_exit_source_probe(dispatcher.exits[second])

    assert scheduled == ["pending_source_probe_batch"]


@pytest.mark.anyio
async def test_source_probe_403_enables_dispatch_and_resets_failures(monkeypatch):
    class Probe:
        async def probe(self, client, **kwargs):
            return SourceProbeResult(True, 403, "", 12)

    async def fake_get_client(self):
        return object()

    monkeypatch.setattr(OutboundExit, "get_client", fake_get_client)
    dispatcher = OutboundDispatcher()
    dispatcher.source_probe = Probe()
    idx = dispatcher.add_socks5("recovering", 10001)
    ex = dispatcher.exits[idx]
    ex.source_probe_failures = 3
    ex.source_probe_last_error = "timeout"
    ex.healthy = True

    assert await dispatcher._probe_source_exit(ex) is True
    assert ex.source_probe_ready is True
    assert ex.source_probe_failures == 0
    assert ex.source_probe_last_error == ""
    assert ex.source_probe_status_code == 403


@pytest.mark.anyio
async def test_source_probe_429_remains_unavailable_with_capped_failures(monkeypatch):
    class Probe:
        async def probe(self, client, **kwargs):
            return SourceProbeResult(False, 429, "HTTP 429", 12)

    async def fake_get_client(self):
        return object()

    monkeypatch.setattr(OutboundExit, "get_client", fake_get_client)
    dispatcher = OutboundDispatcher()
    dispatcher.source_probe = Probe()
    idx = dispatcher.add_socks5("limited", 10001)
    ex = dispatcher.exits[idx]
    ex.source_probe_failures = 3
    ex.healthy = True

    assert await dispatcher._probe_source_exit(ex) is False
    assert ex.source_probe_ready is False
    assert ex.source_probe_failures == 3
    assert ex.source_probe_last_error == "HTTP 429"


@pytest.mark.anyio
async def test_source_probe_cancellation_always_clears_probing_state(monkeypatch):
    started = asyncio.Event()

    class Probe:
        async def probe(self, client, **kwargs):
            started.set()
            await asyncio.Event().wait()

    async def fake_get_client(self):
        return object()

    monkeypatch.setattr(OutboundExit, "get_client", fake_get_client)
    dispatcher = OutboundDispatcher()
    dispatcher.source_probe = Probe()
    idx = dispatcher.add_socks5("cancelled", 10001)
    ex = dispatcher.exits[idx]

    task = asyncio.create_task(dispatcher._probe_source_exit(ex))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert ex.source_probing is False


@pytest.mark.anyio
async def test_source_probe_hard_timeout_becomes_retryable_failure(monkeypatch):
    class Probe:
        async def probe(self, client, **kwargs):
            await asyncio.Event().wait()

    async def fake_get_client(self):
        return object()

    monkeypatch.setattr(OutboundExit, "get_client", fake_get_client)
    dispatcher = OutboundDispatcher()
    dispatcher.SOURCE_PROBE_HARD_TIMEOUT_SECONDS = 0.01
    dispatcher.source_probe = Probe()
    idx = dispatcher.add_socks5("timed-out", 10001)
    ex = dispatcher.exits[idx]

    assert await dispatcher._probe_source_exit(ex) is False
    assert ex.source_probing is False
    assert ex.source_probe_failures == 1
    assert ex.source_probe_last_error == "源站探测超时（0.01 秒）"


@pytest.mark.anyio
async def test_quic_source_probe_retries_transport_failure_and_recovers(monkeypatch):
    calls = []
    closed = []

    class Probe:
        async def probe(self, client, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                return SourceProbeResult(False, None, "QUIC handshake timeout", 22000)
            return SourceProbeResult(True, 403, "", 20)

    async def fake_get_client(self):
        return object()

    async def fake_close_client(self, reason="closed"):
        closed.append(reason)

    monkeypatch.setattr(OutboundExit, "get_client", fake_get_client)
    monkeypatch.setattr(OutboundExit, "close_client", fake_close_client)
    dispatcher = OutboundDispatcher()
    dispatcher.QUIC_SOURCE_PROBE_RETRY_DELAY_SECONDS = 0
    dispatcher.source_probe = Probe()
    idx = dispatcher.add_socks5("hy2", 10001, node_type="hysteria2")
    ex = dispatcher.exits[idx]

    assert await dispatcher._probe_source_exit(ex) is True
    assert len(calls) == 2
    assert calls[0]["timeout_seconds"] == 22
    assert calls[0]["connect_timeout_seconds"] == 10
    assert closed == ["source_probe_retry"]
    assert ex.source_probe_ready is True
    assert ex.source_probe_failures == 0
    assert ex.source_probe_last_error == ""


@pytest.mark.anyio
async def test_quic_revalidation_does_not_close_available_exit_client(monkeypatch):
    calls = 0
    closed = []

    class Probe:
        async def probe(self, client, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                return SourceProbeResult(False, None, "temporary QUIC error", 20)
            return SourceProbeResult(True, 403, "", 20)

    async def fake_get_client(self):
        return object()

    async def fake_close_client(self, reason="closed"):
        closed.append(reason)

    monkeypatch.setattr(OutboundExit, "get_client", fake_get_client)
    monkeypatch.setattr(OutboundExit, "close_client", fake_close_client)
    dispatcher = OutboundDispatcher()
    dispatcher.QUIC_SOURCE_PROBE_RETRY_DELAY_SECONDS = 0
    dispatcher.source_probe = Probe()
    idx = dispatcher.add_socks5("hy2", 10001, node_type="hysteria2")
    ex = dispatcher.exits[idx]
    ex.source_probe_ready = True

    assert await dispatcher._probe_source_exit(ex) is True
    assert calls == 2
    assert closed == []


@pytest.mark.anyio
async def test_quic_source_probe_does_not_retry_http_failure(monkeypatch):
    calls = 0

    class Probe:
        async def probe(self, client, **kwargs):
            nonlocal calls
            calls += 1
            return SourceProbeResult(False, 429, "HTTP 429", 12)

    async def fake_get_client(self):
        return object()

    monkeypatch.setattr(OutboundExit, "get_client", fake_get_client)
    dispatcher = OutboundDispatcher()
    dispatcher.QUIC_SOURCE_PROBE_RETRY_DELAY_SECONDS = 0
    dispatcher.source_probe = Probe()
    idx = dispatcher.add_socks5("hy2", 10001, node_type="hysteria2")

    assert await dispatcher._probe_source_exit(dispatcher.exits[idx]) is False
    assert calls == 1


@pytest.mark.anyio
async def test_source_probe_batch_applies_separate_protocol_concurrency(monkeypatch):
    dispatcher = OutboundDispatcher()
    dispatcher.SOURCE_PROBE_BATCH_CONCURRENCY = 2
    dispatcher.QUIC_SOURCE_PROBE_BATCH_CONCURRENCY = 1
    exits = [
        OutboundExit(f"tcp-{index}", f"socks5://127.0.0.1:{10000 + index}", node_type="vless")
        for index in range(4)
    ] + [
        OutboundExit(f"quic-{index}", f"socks5://127.0.0.1:{11000 + index}", node_type="hysteria2")
        for index in range(3)
    ]
    active = {"default": 0, "quic": 0}
    maximum = {"default": 0, "quic": 0}

    async def fake_probe(ex, policy=None):
        active[policy.pool] += 1
        maximum[policy.pool] = max(maximum[policy.pool], active[policy.pool])
        await asyncio.sleep(0.01)
        active[policy.pool] -= 1
        return True

    monkeypatch.setattr(dispatcher, "_probe_source_exit", fake_probe)

    results = await dispatcher._probe_source_batch(exits)

    assert all(results)
    assert maximum == {"default": 2, "quic": 1}


@pytest.mark.anyio
@pytest.mark.parametrize("anyio_backend", ["asyncio"])
async def test_latency_probe_concurrent_callers_share_one_batch():
    dispatcher = OutboundDispatcher()
    calls = 0

    async def probe_all_sources():
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.03)
        return 3

    dispatcher.probe_all_sources = probe_all_sources
    first, second = await asyncio.gather(
        dispatcher.probe_latencies_now(),
        dispatcher.probe_latencies_now(),
    )

    assert calls == 1
    assert first["success"] is True
    assert second["success"] is True
    assert "可用 3 个出口" in first["message"]


@pytest.mark.anyio
@pytest.mark.parametrize("anyio_backend", ["asyncio"])
async def test_full_source_probe_callers_share_one_batch():
    dispatcher = OutboundDispatcher()
    calls = 0

    async def probe_once():
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.03)
        return 4

    dispatcher._probe_all_sources_once = probe_once
    first, second = await asyncio.gather(
        dispatcher.probe_all_sources(),
        dispatcher.probe_all_sources(),
    )

    assert calls == 1
    assert first == second == 4


def test_login_forward_timeout_is_twenty_seconds():
    assert LOGIN_RPC_TIMEOUT_SECONDS == 20


@pytest.mark.anyio
async def test_read_timeout_after_dispatch_does_not_retry_or_freeze_exit():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "slow-upstream", 10001)
    _add_ready_socks5(dispatcher, "fallback", 10002)
    attempts = []

    async def fake_request(exit_obj, *_args, **_kwargs):
        attempts.append(exit_obj.name)
        raise httpx.ReadTimeout("upstream response timed out")

    dispatcher._do_request = fake_request

    with pytest.raises(httpx.ReadTimeout, match="upstream response timed out"):
        await dispatcher.forward(
            dispatcher.exits[1],
            "POST",
            "https://example.test/RPC/ACE_Sell",
            {},
            content_type="application/x-www-form-urlencoded",
            params={"account": "demo"},
            raw_body=b"",
            api_path="ACE_Sell",
        )

    assert attempts == ["slow-upstream"]
    assert dispatcher.exits[1]._connect_failures == 0
    assert dispatcher.exits[1].is_frozen is False


@pytest.mark.anyio
async def test_connect_failure_before_dispatch_retries_another_exit():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "connect-failed", 10001)
    _add_ready_socks5(dispatcher, "fallback", 10002)
    attempts = []

    async def fake_request(exit_obj, *_args, **_kwargs):
        attempts.append(exit_obj.name)
        if exit_obj.name == "connect-failed":
            raise httpx.ConnectError("proxy connection failed")
        return httpx.Response(
            200,
            json={"Error": False, "Data": {"ok": True}},
            headers={"content-type": "application/json"},
        )

    dispatcher._do_request = fake_request
    response = await dispatcher.forward(
        dispatcher.exits[1],
        "POST",
        "https://example.test/RPC/Public_ACE",
        {},
        content_type="application/x-www-form-urlencoded",
        params={"account": "demo"},
        raw_body=b"",
        api_path="Public_ACE",
    )

    assert attempts == ["connect-failed", "fallback"]
    assert response.json()["Data"]["ok"] is True


@pytest.mark.anyio
async def test_login_non_json_response_retries_next_exit():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "bad-html", 10001)
    _add_ready_socks5(dispatcher, "good-json", 10002)
    attempts = []

    async def fake_request(exit_obj, method, url, headers, content_type, params, raw_body, timeout, connect_timeout=None):
        attempts.append(exit_obj.name)
        if exit_obj.name == "bad-html":
            return httpx.Response(
                200,
                content=b"<html>bad gateway</html>",
                headers={"content-type": "text/html"},
            )
        return httpx.Response(
            200,
            json={"Error": False, "UserData": {"Id": 1}},
            headers={"content-type": "application/json"},
        )

    dispatcher._do_request = fake_request
    response = await dispatcher.forward(
        dispatcher.exits[1],
        "POST",
        "https://example.test/RPC/Login",
        {},
        content_type="application/x-www-form-urlencoded",
        params={"account": "demo"},
        raw_body=b"",
        api_path="Login",
    )

    assert attempts == ["bad-html", "good-json"]
    assert response.json()["Error"] is False


@pytest.mark.anyio
async def test_login_invalid_json_content_type_retries_next_exit():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "bad-json", 10001)
    _add_ready_socks5(dispatcher, "good-json", 10002)
    attempts = []

    async def fake_request(exit_obj, method, url, headers, content_type, params, raw_body, timeout, connect_timeout=None):
        attempts.append(exit_obj.name)
        if exit_obj.name == "bad-json":
            return httpx.Response(
                200,
                content=b"not-json",
                headers={"content-type": "application/json"},
            )
        return httpx.Response(
            200,
            json={"Error": False, "UserData": {"Id": 1}},
            headers={"content-type": "application/json"},
        )

    dispatcher._do_request = fake_request
    response = await dispatcher.forward(
        dispatcher.exits[1],
        "POST",
        "https://example.test/RPC/Login",
        {},
        content_type="application/x-www-form-urlencoded",
        params={"account": "demo"},
        raw_body=b"",
        api_path="Login",
    )

    assert attempts == ["bad-json", "good-json"]
    assert response.json()["Error"] is False


@pytest.mark.anyio
async def test_login_html_403_response_retries_next_exit_freezes_and_records_current():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "bad-403", 10001, group_id="g1")
    _add_ready_socks5(dispatcher, "good-json", 10002, group_id="g2")
    attempts = []

    async def fake_request(exit_obj, method, url, headers, content_type, params, raw_body, timeout, connect_timeout=None):
        attempts.append(exit_obj.name)
        if exit_obj.name == "bad-403":
            return httpx.Response(
                403,
                content=b"<html><body>forbidden</body></html>",
                headers={"content-type": "text/html"},
            )
        return httpx.Response(
            200,
            json={"Error": False, "UserData": {"Id": 1}},
            headers={"content-type": "application/json"},
        )

    dispatcher._do_request = fake_request
    response = await dispatcher.forward(
        dispatcher.exits[1],
        "POST",
        "https://example.test/RPC/Login",
        {},
        content_type="application/x-www-form-urlencoded",
        params={"account": "demo"},
        raw_body=b"",
        api_path="Login",
    )

    assert attempts == ["bad-403", "good-json"]
    assert dispatcher.exits[1].warn_403 == 1
    assert dispatcher.exits[1].is_frozen
    assert response.json()["Error"] is False


@pytest.mark.anyio
async def test_rpc_json_403_retries_another_exit_and_resets_protection_after_success():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "bad-403", 10001, group_id="g1")
    _add_ready_socks5(dispatcher, "good-json", 10002, group_id="g2")
    attempts = []

    async def fake_request(exit_obj, method, url, headers, content_type, params, raw_body, timeout, connect_timeout=None):
        attempts.append(exit_obj.name)
        if exit_obj.name == "bad-403":
            return httpx.Response(
                403,
                json={"Error": True, "Msg": "Forbidden"},
                headers={"content-type": "application/json"},
            )
        return httpx.Response(
            200,
            json={"Error": False, "Data": {"ok": True}},
            headers={"content-type": "application/json"},
        )

    dispatcher._do_request = fake_request
    response = await dispatcher.forward(
        dispatcher.exits[1],
        "POST",
        "https://example.test/RPC/Public_ACE",
        {},
        content_type="application/x-www-form-urlencoded",
        params={"account": "demo"},
        raw_body=b"",
        api_path="Public_ACE",
    )

    assert attempts == ["bad-403", "good-json"]
    assert dispatcher.exits[1].warn_403 == 1
    assert dispatcher.exits[1]._403_freeze_level == 1
    assert dispatcher.exits[1].is_frozen is True
    assert dispatcher.exits[1].rate_limit == 0
    assert response.extensions["ak_exit_name"] == "good-json"
    assert response.json()["Data"]["ok"] is True


@pytest.mark.anyio
async def test_rpc_html_429_response_is_recorded_before_non_json_rejection():
    dispatcher = OutboundDispatcher()

    async def fake_request(*_args, **_kwargs):
        return httpx.Response(
            429,
            content=b"<html><body>too many requests</body></html>",
            headers={"content-type": "text/html"},
        )

    dispatcher._do_request = fake_request

    with pytest.raises(RpcUpstreamNonJsonError, match="网络异常，请刷新重试！"):
        await dispatcher.forward(
            dispatcher.exits[0],
            "POST",
            "https://example.test/RPC/My_Subaccount",
            {},
            content_type="application/x-www-form-urlencoded",
            params={"account": "demo"},
            raw_body=b"",
            api_path="My_Subaccount",
        )

    assert dispatcher.exits[0].warn_429 == 1


@pytest.mark.anyio
async def test_rpc_non_json_response_retries_next_exit_and_records_diagnostic():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "bad-html", 10001, group_id="g1")
    _add_ready_socks5(dispatcher, "good-json", 10002, group_id="g2")
    attempts = []
    diagnostics = []

    def record_non_json(exit_obj, resp, api_path, client_ip, account, attempt_index):
        diagnostics.append((exit_obj.name, api_path, client_ip, account, attempt_index, resp.status_code))

    async def fake_request(exit_obj, method, url, headers, content_type, params, raw_body, timeout, connect_timeout=None):
        attempts.append(exit_obj.name)
        if exit_obj.name == "bad-html":
            return httpx.Response(
                200,
                content=b"<html>bad gateway</html>",
                headers={"content-type": "text/html"},
            )
        return httpx.Response(
            200,
            json={"Error": False, "Data": {"ok": True}},
            headers={"content-type": "application/json"},
        )

    dispatcher.rpc_non_json_callback = record_non_json
    dispatcher._do_request = fake_request

    response = await dispatcher.forward(
        dispatcher.exits[1],
        "POST",
        "https://example.test/RPC/Public_ACE",
        {},
        content_type="application/x-www-form-urlencoded",
        params={"account": "demo"},
        raw_body=b"",
        api_path="Public_ACE",
        client_ip="1.2.3.4",
        account="demo",
    )

    assert attempts == ["bad-html", "good-json"]
    assert diagnostics == [("bad-html", "Public_ACE", "1.2.3.4", "demo", 1, 200)]
    assert not dispatcher.exits[1].is_frozen
    assert response.json()["Data"]["ok"] is True


@pytest.mark.anyio
async def test_rpc_non_json_response_raises_after_all_fallbacks_fail():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "bad-json-1", 10001, group_id="g1")
    _add_ready_socks5(dispatcher, "bad-json-2", 10002, group_id="g2")
    attempts = []

    async def fake_request(exit_obj, method, url, headers, content_type, params, raw_body, timeout, connect_timeout=None):
        attempts.append(exit_obj.name)
        return httpx.Response(
            200,
            content=b"not-json",
            headers={"content-type": "application/json"},
        )

    dispatcher._do_request = fake_request

    with pytest.raises(RpcUpstreamNonJsonError, match="网络异常，请刷新重试！"):
        await dispatcher.forward(
            dispatcher.exits[1],
            "POST",
            "https://example.test/RPC/Public_ACE",
            {},
            content_type="application/x-www-form-urlencoded",
            params={"account": "demo"},
            raw_body=b"",
            api_path="Public_ACE",
        )

    assert attempts == ["bad-json-1", "bad-json-2", "direct"]
    assert not dispatcher.exits[1].is_frozen
    assert not dispatcher.exits[2].is_frozen


@pytest.mark.anyio
async def test_sell_non_json_response_is_not_replayed_after_response_arrived():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "sell-html", 10001, group_id="g1")
    _add_ready_socks5(dispatcher, "sell-json", 10002, group_id="g2")
    attempts = []

    async def fake_request(exit_obj, method, url, headers, content_type, params, raw_body, timeout, connect_timeout=None):
        attempts.append(exit_obj.name)
        return httpx.Response(200, content=b"<html>processed</html>", headers={"content-type": "text/html"})

    dispatcher._do_request = fake_request

    with pytest.raises(RpcUpstreamNonJsonError):
        await dispatcher.forward(
            dispatcher.exits[1],
            "POST",
            "https://example.test/RPC/ACE_Sell",
            {},
            content_type="application/x-www-form-urlencoded",
            params={"account": "demo"},
            raw_body=b"count=10",
            api_path="ACE_Sell",
        )

    assert attempts == ["sell-html"]


@pytest.mark.anyio
async def test_successful_response_resets_connect_failure_gradient():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "recovering", 10001)
    recovering = dispatcher.exits[1]
    recovering.freeze_for_connect_error("boom")
    recovering._frozen_until = 0

    async def fake_request(exit_obj, method, url, headers, content_type, params, raw_body, timeout, connect_timeout=None):
        return httpx.Response(
            200,
            json={"Error": False, "Data": {"ok": True}},
            headers={"content-type": "application/json"},
        )

    dispatcher._do_request = fake_request

    response = await dispatcher.forward(
        recovering,
        "POST",
        "https://example.test/RPC/Public_ACE",
        {},
        content_type="application/x-www-form-urlencoded",
        params={"account": "demo"},
        raw_body=b"",
        api_path="Public_ACE",
    )

    assert recovering._connect_failures == 0
    assert recovering._frozen_reason == ""
    assert response.json()["Data"]["ok"] is True


@pytest.mark.anyio
async def test_successful_response_resets_403_protection_gradient():
    dispatcher = OutboundDispatcher()
    _add_ready_socks5(dispatcher, "recovering", 10001)
    recovering = dispatcher.exits[1]
    recovering.freeze_for_403_gradient(dispatcher.BUSINESS_403_FREEZE_SCHEDULE)
    recovering._frozen_until = 0

    async def fake_request(exit_obj, method, url, headers, content_type, params, raw_body, timeout, connect_timeout=None):
        return httpx.Response(
            200,
            json={"Error": False, "Data": {"ok": True}},
            headers={"content-type": "application/json"},
        )

    dispatcher._do_request = fake_request
    response = await dispatcher.forward(
        recovering,
        "POST",
        "https://example.test/RPC/Public_ACE",
        {},
        content_type="application/x-www-form-urlencoded",
        params={"account": "demo"},
        raw_body=b"",
        api_path="Public_ACE",
    )

    assert recovering._403_freeze_level == 0
    assert recovering._frozen_reason == ""
    assert response.json()["Data"]["ok"] is True


@pytest.mark.anyio
async def test_request_deadline_is_total_and_carries_diagnostics():
    class SlowClient:
        async def post(self, *_args, **_kwargs):
            await asyncio.sleep(0.15)

    class FakeExit:
        async def get_client(self):
            return SlowClient()

        def client_request_state(self, _client):
            return {"client_closed": False, "client_retired": False}

    dispatcher = OutboundDispatcher()
    with pytest.raises(httpx.ReadTimeout) as captured:
        await dispatcher._do_request(
            FakeExit(),
            "POST",
            "https://example.test/RPC/ACE_Sell",
            {},
            "application/x-www-form-urlencoded",
            {},
            b"",
            0.01,
        )

    error = captured.value
    assert getattr(error, "_ak_timeout_scope") == "total_deadline"
    assert getattr(error, "_ak_deadline_seconds") == pytest.approx(0.1)
