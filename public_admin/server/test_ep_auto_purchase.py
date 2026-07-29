import asyncio

import pytest

from .ep_auto_purchase.provider import EPAutoPurchaseProvider
from .ep_auto_purchase.service import EPAutoPurchaseService
from .upstream_rpc_gate.service import UpstreamRpcGate


class _Response:
    status_code = 200

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _Client:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    async def post(self, url, data):
        self.calls.append((url, dict(data)))
        return _Response(self.payload)


@pytest.mark.anyio
async def test_ep_buy_sends_only_order_and_auth_fields():
    client = _Client({"Error": False, "Msg": "ok"})
    provider = EPAutoPurchaseProvider("http://local/RPC/")

    result = await provider.buy(
        client,
        {"key": "buyer-key", "user_id": "103"},
        "88",
        "order-secret",
    )

    assert result == {"success": True, "message": "ok"}
    assert set(client.calls[0][1]) == {"sId", "Sokey", "key", "UserID", "v", "lang"}
    assert client.calls[0][1]["sId"] == "88"
    assert "password" not in client.calls[0][1]
    assert "gCode" not in client.calls[0][1]


@pytest.mark.anyio
async def test_pending_list_uses_confirmed_market_parameters():
    client = _Client({"Error": False, "Data": {"List": [{"sId": 1}]}})
    provider = EPAutoPurchaseProvider("http://local/RPC/")

    rows = await provider.list_pending(client, {"key": "buyer-key", "user_id": "103"})

    assert rows == [{"sId": 1}]
    request = client.calls[0][1]
    assert request["p"] == "1"
    assert request["pageSize"] == "50"
    assert request["type"] == "1"
    assert request["Position"] == "1"
    assert request["account"] == ""


class _Gate:
    def __init__(self):
        self.lease = object()
        self.released = 0

    async def try_reserve_background(self, identity):
        return self.lease

    async def release(self, lease):
        assert lease is self.lease
        self.released += 1


class _Repository:
    def __init__(self, claimed=True):
        self.claimed = claimed
        self.claim_calls = 0
        self.finished = []

    async def claim_order(self, *args):
        self.claim_calls += 1
        return self.claimed

    async def finish_order(self, sid, state, message):
        self.finished.append((sid, state, message))


@pytest.mark.anyio
async def test_order_timeout_is_recorded_unknown_without_second_buy():
    repository = _Repository()
    gate = _Gate()
    service = EPAutoPurchaseService(repository, auth_store=None, rpc_gate=gate)
    calls = 0

    async def fail_buy(client, auth, sid, sokey):
        nonlocal calls
        calls += 1
        raise TimeoutError("timeout")

    service.provider.buy = fail_buy

    success = await service._purchase_listing(
        None,
        "buyer",
        {"user_id": "103", "key": "key"},
        {"sId": "88", "Sokey": "secret", "Account": "seller", "EPAmount": "5"},
    )

    assert success is False
    assert calls == 1
    assert repository.finished == [("88", "unknown", "timeout")]
    assert gate.released == 1


@pytest.mark.anyio
async def test_existing_order_is_not_purchased_again():
    repository = _Repository(claimed=False)
    gate = _Gate()
    service = EPAutoPurchaseService(repository, auth_store=None, rpc_gate=gate)

    async def should_not_buy(*args):
        raise AssertionError("duplicate order must not reach EP_Buy")

    service.provider.buy = should_not_buy

    success = await service._purchase_listing(
        None,
        "buyer",
        {"user_id": "103", "key": "key"},
        {"sId": "88", "Sokey": "secret"},
    )

    assert success is False
    assert repository.claim_calls == 1
    assert repository.finished == []
    assert gate.released == 1


@pytest.mark.anyio
async def test_external_gate_retries_while_background_gate_is_one_shot():
    class Repository:
        def __init__(self):
            self.results = [False, True]
            self.external_flags = []

        async def try_claim(self, identity, holder, external):
            self.external_flags.append(external)
            return self.results.pop(0)

        async def release(self, identity, holder):
            return None

    repository = Repository()
    gate = UpstreamRpcGate(repository)
    lease = await gate.reserve_external("user:1", wait_seconds=1)

    assert lease is not None
    assert repository.external_flags == [True, True]
