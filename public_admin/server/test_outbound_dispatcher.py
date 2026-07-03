import pytest
import httpx

from .outbound_dispatcher import OutboundDispatcher, RpcUpstreamNonJsonError


def _saturate_regular_direct(dispatcher: OutboundDispatcher) -> None:
    direct = dispatcher.exits[0]
    for _ in range(dispatcher.DIRECT_FALLBACK_RATE_PER_MINUTE):
        direct.record_request()


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


def test_direct_exhaustion_overflows_to_non_frozen_tunnel_instead_of_rejecting():
    dispatcher = OutboundDispatcher()
    dispatcher.add_socks5("tunnel-1", 10001)
    tunnel = dispatcher.exits[1]
    tunnel.rate_limit = 1
    tunnel.record_request()
    _saturate_regular_direct(dispatcher)

    picked = dispatcher.pick_api_exit("ACE_Sell_Son")

    assert picked is tunnel


def test_login_direct_exhaustion_overflows_to_non_frozen_tunnel():
    dispatcher = OutboundDispatcher()
    dispatcher.add_socks5("login-tunnel", 10002)
    tunnel = dispatcher.exits[1]
    tunnel.rate_limit = 1
    tunnel.record_request()
    _saturate_regular_direct(dispatcher)

    picked = dispatcher.pick_login_exit()

    assert picked is tunnel


def test_critical_direct_fallback_has_own_rate_limit():
    dispatcher = OutboundDispatcher()
    dispatcher.DIRECT_CRITICAL_FALLBACK_RATE_PER_SECOND = 2
    dispatcher.DIRECT_CRITICAL_FALLBACK_RATE_PER_MINUTE = 2

    dispatcher.pick_api_exit("/RPC/Logout")
    dispatcher.pick_api_exit("Logout")

    with pytest.raises(RuntimeError, match="all api exits"):
        dispatcher.pick_api_exit("Logout")


def test_wide_spread_rpc_spreads_across_more_tunnels_without_latency_priority():
    dispatcher = OutboundDispatcher()
    for idx in range(3):
        dispatcher.add_socks5(f"tunnel-{idx}", 10001 + idx)
        dispatcher.exits[idx + 1].latency_ms = idx + 1

    picked = [dispatcher.pick_api_exit("My_Subaccount").name for _ in range(6)]

    assert set(picked) == {"tunnel-0", "tunnel-1", "tunnel-2"}


def test_wide_spread_rpc_does_not_change_regular_latency_strategy():
    dispatcher = OutboundDispatcher()
    for idx, latency in enumerate([300, 10, 200]):
        dispatcher.add_socks5(f"tunnel-{idx}", 10001 + idx)
        dispatcher.exits[idx + 1].latency_ms = latency

    picked = dispatcher.pick_api_exit("Public_ACE")

    assert picked.name == "tunnel-1"


def test_ace_sell_uses_wide_spread_rpc_policy():
    dispatcher = OutboundDispatcher()
    for idx in range(2):
        dispatcher.add_socks5(f"sell-tunnel-{idx}", 10001 + idx)

    picked = [dispatcher.pick_api_exit("ACE_Sell").name for _ in range(4)]

    assert set(picked) == {"sell-tunnel-0", "sell-tunnel-1"}


def test_wide_spread_rpc_ignores_dedicated_fast_pool_size():
    dispatcher = OutboundDispatcher()
    dispatcher.DEDICATED_FAST_EXIT_COUNT = 1
    for idx, latency in enumerate([1, 200, 300]):
        dispatcher.add_socks5(f"tunnel-{idx}", 10001 + idx)
        dispatcher.exits[idx + 1].latency_ms = latency

    picked = [dispatcher.pick_api_exit("My_Subaccount").name for _ in range(6)]

    assert set(picked) == {"tunnel-0", "tunnel-1", "tunnel-2"}


def test_wide_spread_rpc_prefers_lower_recent_rate_over_latency():
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config.per_exit_rate_per_second = 20
    dispatcher.add_socks5("hot-fast", 10001, group_id="g1")
    dispatcher.add_socks5("idle-slow", 10002, group_id="g2")
    dispatcher.exits[1].latency_ms = 1
    dispatcher.exits[2].latency_ms = 300
    for _ in range(5):
        dispatcher.exits[1].record_request()

    picked = dispatcher.pick_api_exit("ACE_Sell")

    assert picked.name == "idle-slow"


def test_regular_rpc_keeps_latency_strategy_even_when_other_exit_is_idle():
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config.per_exit_rate_per_second = 20
    dispatcher.add_socks5("hot-fast", 10001, group_id="g1")
    dispatcher.add_socks5("idle-slow", 10002, group_id="g2")
    dispatcher.exits[1].latency_ms = 1
    dispatcher.exits[2].latency_ms = 300
    for _ in range(5):
        dispatcher.exits[1].record_request()

    picked = dispatcher.pick_api_exit("Public_ACE")

    assert picked.name == "hot-fast"


def test_login_spreads_across_subscription_groups_without_latency_bias():
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config.per_exit_rate_per_second = 20
    for group_idx, latency in enumerate([1, 200, 400], start=1):
        for node_idx in range(2):
            dispatcher.add_socks5(f"g{group_idx}-node-{node_idx}", 10000 + group_idx * 10 + node_idx, group_id=f"g{group_idx}")
            dispatcher.exits[-1].latency_ms = latency

    picked = [dispatcher.pick_login_exit() for _ in range(6)]
    groups = [item.group_id for item in picked]

    assert {group: groups.count(group) for group in set(groups)} == {"g1": 2, "g2": 2, "g3": 2}


def test_login_spreads_within_same_subscription_group_before_reusing_exit():
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config.per_exit_rate_per_second = 20
    for idx in range(3):
        dispatcher.add_socks5(f"same-group-{idx}", 10001 + idx, group_id="g1")

    picked = [dispatcher.pick_login_exit().name for _ in range(3)]

    assert set(picked) == {"same-group-0", "same-group-1", "same-group-2"}


def test_login_prefers_less_used_subscription_group_over_fast_group():
    dispatcher = OutboundDispatcher()
    dispatcher.policy_config.per_exit_rate_per_second = 20
    dispatcher.add_socks5("fast-used", 10001, group_id="g1")
    dispatcher.add_socks5("slow-idle", 10002, group_id="g2")
    dispatcher.exits[1].latency_ms = 1
    dispatcher.exits[2].latency_ms = 500
    for _ in range(3):
        dispatcher.exits[1].reserve_login()

    picked = dispatcher.pick_login_exit()

    assert picked.name == "slow-idle"


def test_fallback_sequence_tries_three_tunnels_then_direct_across_groups():
    dispatcher = OutboundDispatcher()
    dispatcher.add_socks5("failed", 10001, group_id="g1")
    dispatcher.add_socks5("same-group", 10002, group_id="g1")
    dispatcher.add_socks5("group-2", 10003, group_id="g2")
    dispatcher.add_socks5("group-3", 10004, group_id="g3")
    dispatcher.add_socks5("group-4", 10005, group_id="g4")

    attempts = dispatcher._fallback_sequence(dispatcher.exits[1], "Public_ACE")

    assert [item.name for item in attempts] == ["group-2", "group-3", "group-4", "direct"]


def test_fallback_sequence_keeps_availability_before_group_spread():
    dispatcher = OutboundDispatcher()
    dispatcher.add_socks5("failed", 10001, group_id="g1")
    dispatcher.add_socks5("frozen-other-group", 10002, group_id="g2")
    dispatcher.add_socks5("unhealthy-other-group", 10003, group_id="g3")
    dispatcher.add_socks5("healthy-same-group", 10004, group_id="g1")
    dispatcher.exits[2].freeze(60, "test")
    dispatcher.exits[3].healthy = False

    attempts = dispatcher._fallback_sequence(dispatcher.exits[1], "My_Subaccount")

    assert [item.name for item in attempts] == ["healthy-same-group", "direct"]


def test_wide_spread_fallback_ignores_dedicated_fast_pool_size():
    dispatcher = OutboundDispatcher()
    dispatcher.DEDICATED_FAST_EXIT_COUNT = 1
    dispatcher.add_socks5("failed", 10001, group_id="g1")
    for idx, group_id in enumerate(["g2", "g3", "g4"], start=2):
        dispatcher.add_socks5(f"group-{idx}", 10000 + idx, group_id=group_id)

    attempts = dispatcher._fallback_sequence(dispatcher.exits[1], "My_Subaccount")

    assert [item.name for item in attempts] == ["group-2", "group-3", "group-4", "direct"]


@pytest.mark.anyio
async def test_start_starts_initial_and_periodic_ip_detect_tasks(monkeypatch):
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
    monkeypatch.setattr(dispatcher, "_ensure_latency_probe_started", lambda: None)
    monkeypatch.setattr(dispatcher, "_safe_create_task", fake_create_task)

    await dispatcher.start()

    assert created == ["initial_ip_detect", "periodic_ip_detect"]
    assert dispatcher._initial_ip_detect_task is not None
    assert dispatcher._periodic_ip_detect_task is not None


@pytest.mark.anyio
async def test_login_non_json_response_retries_next_exit():
    dispatcher = OutboundDispatcher()
    dispatcher.DEDICATED_FAST_EXIT_COUNT = 0
    dispatcher.add_socks5("bad-html", 10001)
    dispatcher.add_socks5("good-json", 10002)
    attempts = []

    async def fake_request(exit_obj, method, url, headers, content_type, params, raw_body, timeout):
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
    dispatcher.DEDICATED_FAST_EXIT_COUNT = 0
    dispatcher.add_socks5("bad-json", 10001)
    dispatcher.add_socks5("good-json", 10002)
    attempts = []

    async def fake_request(exit_obj, method, url, headers, content_type, params, raw_body, timeout):
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
async def test_login_403_response_retries_next_exit_and_freezes_current():
    dispatcher = OutboundDispatcher()
    dispatcher.DEDICATED_FAST_EXIT_COUNT = 0
    dispatcher.add_socks5("bad-403", 10001, group_id="g1")
    dispatcher.add_socks5("good-json", 10002, group_id="g2")
    attempts = []

    async def fake_request(exit_obj, method, url, headers, content_type, params, raw_body, timeout):
        attempts.append(exit_obj.name)
        if exit_obj.name == "bad-403":
            return httpx.Response(
                403,
                json={"Error": True, "Msg": "forbidden"},
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

    assert attempts == ["bad-403", "good-json"]
    assert dispatcher.exits[1].warn_403 == 1
    assert dispatcher.exits[1].is_frozen
    assert response.json()["Error"] is False


@pytest.mark.anyio
async def test_rpc_non_json_response_retries_next_exit_and_records_diagnostic():
    dispatcher = OutboundDispatcher()
    dispatcher.DEDICATED_FAST_EXIT_COUNT = 0
    dispatcher.add_socks5("bad-html", 10001, group_id="g1")
    dispatcher.add_socks5("good-json", 10002, group_id="g2")
    attempts = []
    diagnostics = []

    def record_non_json(exit_obj, resp, api_path, client_ip, account, attempt_index):
        diagnostics.append((exit_obj.name, api_path, client_ip, account, attempt_index, resp.status_code))

    async def fake_request(exit_obj, method, url, headers, content_type, params, raw_body, timeout):
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
    dispatcher.DEDICATED_FAST_EXIT_COUNT = 0
    dispatcher.add_socks5("bad-json-1", 10001, group_id="g1")
    dispatcher.add_socks5("bad-json-2", 10002, group_id="g2")
    attempts = []

    async def fake_request(exit_obj, method, url, headers, content_type, params, raw_body, timeout):
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
async def test_successful_response_resets_connect_failure_gradient():
    dispatcher = OutboundDispatcher()
    dispatcher.add_socks5("recovering", 10001)
    recovering = dispatcher.exits[1]
    recovering.freeze_for_connect_error("boom", 30)
    recovering._frozen_until = 0

    async def fake_request(exit_obj, method, url, headers, content_type, params, raw_body, timeout):
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
