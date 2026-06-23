import pytest

from .outbound_dispatcher import OutboundDispatcher


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
