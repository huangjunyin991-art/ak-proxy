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
