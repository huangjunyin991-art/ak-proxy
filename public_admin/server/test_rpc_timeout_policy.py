import asyncio

import httpx
import pytest

from .outbound_dispatcher import OutboundDispatcher
from .rpc_timeout_policy import (
    AK_SELL_READ_TIMEOUT_SECONDS,
    AK_SELL_WRITE_TIMEOUT_SECONDS,
    LOGIN_RPC_TIMEOUT_SECONDS,
    NOTICE_GUIDANCE_REQUEST_TIMEOUT_SECONDS,
    PUBLIC_AK_SELL_FORWARD_TIMEOUT_SECONDS,
    REGULAR_RPC_TIMEOUT_SECONDS,
    resolve_connect_timeout,
    resolve_public_ak_sell_forward_timeout,
    resolve_rpc_forward_timeout,
)


def test_business_rpc_forward_timeouts_are_unified():
    assert {
        REGULAR_RPC_TIMEOUT_SECONDS,
        LOGIN_RPC_TIMEOUT_SECONDS,
        AK_SELL_READ_TIMEOUT_SECONDS,
        AK_SELL_WRITE_TIMEOUT_SECONDS,
        NOTICE_GUIDANCE_REQUEST_TIMEOUT_SECONDS,
    } == {20.0}


def test_rpc_timeout_policy_keeps_login_longer_than_regular_rpc():
    assert resolve_rpc_forward_timeout("Public_ACE") == REGULAR_RPC_TIMEOUT_SECONDS
    assert resolve_rpc_forward_timeout("My_Subaccount") == REGULAR_RPC_TIMEOUT_SECONDS
    assert resolve_rpc_forward_timeout("Login") == LOGIN_RPC_TIMEOUT_SECONDS
    assert resolve_rpc_forward_timeout("/RPC/Login") == LOGIN_RPC_TIMEOUT_SECONDS
    assert resolve_rpc_forward_timeout("Public_ACE", is_login=True) == LOGIN_RPC_TIMEOUT_SECONDS


def test_public_ak_sell_timeout_is_longer_without_changing_other_rpc_paths():
    assert resolve_public_ak_sell_forward_timeout("ACE_Sell") == PUBLIC_AK_SELL_FORWARD_TIMEOUT_SECONDS == 30.0
    assert resolve_public_ak_sell_forward_timeout("/RPC/ACE_Sell_Son") == PUBLIC_AK_SELL_FORWARD_TIMEOUT_SECONDS
    assert resolve_public_ak_sell_forward_timeout("Public_ACE") is None


@pytest.mark.anyio
async def test_dispatcher_do_request_uses_short_connect_timeout(monkeypatch):
    dispatcher = OutboundDispatcher()
    exit_obj = dispatcher.exits[0]
    captured = {}

    class FakeClient:
        async def post(self, *args, **kwargs):
            captured.update(kwargs)
            return httpx.Response(
                200,
                json={"Error": False, "Data": {"ok": True}},
                headers={"content-type": "application/json"},
            )

    async def fake_get_client(self):
        return FakeClient()

    monkeypatch.setattr(type(exit_obj), "get_client", fake_get_client)

    response = await dispatcher._do_request(
        exit_obj,
        "POST",
        "https://example.test/RPC/Public_ACE",
        {},
        "application/x-www-form-urlencoded",
        {"account": "demo"},
        b"",
        timeout=REGULAR_RPC_TIMEOUT_SECONDS,
    )

    timeout = captured["timeout"]
    assert timeout.connect == resolve_connect_timeout(REGULAR_RPC_TIMEOUT_SECONDS)
    assert timeout.read == REGULAR_RPC_TIMEOUT_SECONDS
    assert response.json()["Data"]["ok"] is True


@pytest.mark.anyio
async def test_dispatcher_uses_prepared_client_without_extending_request_deadline(monkeypatch):
    dispatcher = OutboundDispatcher()
    exit_obj = dispatcher.exits[0]

    class PreparedClient:
        async def post(self, *_args, **_kwargs):
            await asyncio.sleep(0.01)
            return httpx.Response(200, json={"Error": False})

    async def unexpected_get_client(_self):
        raise AssertionError("prepared client should be reused")

    monkeypatch.setattr(type(exit_obj), "get_client", unexpected_get_client)
    response = await dispatcher._do_request(
        exit_obj,
        "POST",
        "https://example.test/RPC/ACE_Sell",
        {},
        "application/x-www-form-urlencoded",
        {},
        b"",
        timeout=0.1,
        client=PreparedClient(),
    )

    assert response.status_code == 200


@pytest.mark.anyio
async def test_dispatcher_total_deadline_marks_nested_read_phase():
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
            FakeExit(), "POST", "https://example.test/RPC/ACE_Sell", {},
            "application/x-www-form-urlencoded", {}, b"", 0.01,
        )

    assert getattr(captured.value, "_ak_transport_phase") == "unknown"
