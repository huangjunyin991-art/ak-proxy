import httpx
import pytest

from .outbound_dispatcher import OutboundDispatcher
from .rpc_timeout_policy import (
    LOGIN_RPC_TIMEOUT_SECONDS,
    REGULAR_RPC_TIMEOUT_SECONDS,
    resolve_connect_timeout,
    resolve_rpc_forward_timeout,
)


def test_rpc_timeout_policy_keeps_login_longer_than_regular_rpc():
    assert resolve_rpc_forward_timeout("Public_ACE") == REGULAR_RPC_TIMEOUT_SECONDS
    assert resolve_rpc_forward_timeout("My_Subaccount") == REGULAR_RPC_TIMEOUT_SECONDS
    assert resolve_rpc_forward_timeout("Login") == LOGIN_RPC_TIMEOUT_SECONDS
    assert resolve_rpc_forward_timeout("/RPC/Login") == LOGIN_RPC_TIMEOUT_SECONDS
    assert resolve_rpc_forward_timeout("Public_ACE", is_login=True) == LOGIN_RPC_TIMEOUT_SECONDS


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
