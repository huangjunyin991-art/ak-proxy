from datetime import datetime
import json

import httpx
import pytest
from fastapi import FastAPI
from starlette.requests import Request

from .ak_sell.clock import AKSellClock, BEIJING_TIMEZONE
from .ak_sell.license_guard import AKSellLicenseGuard, MACHINE_AUTHORIZATION_HEADER
from .ak_sell.internal_rpc import AK_SELL_INTERNAL_RPC_HEADER
from .ak_sell.provider import AKSellUpstreamError, AKSellUpstreamReply
from .ak_sell.routes import create_ak_sell_router
from .ak_sell.service import AKSellInputError, AKSellService


class FakeClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None


class FakeProvider:
    def __init__(self, result=None, error=None):
        self.result = result or {"Error": False, "Msg": "ok"}
        self.error = error
        self.calls = []

    def build_client(self):
        return FakeClient()

    async def post_rpc(self, _client, endpoint, data):
        self.calls.append((endpoint, data))
        if self.error is not None:
            raise self.error
        return self.result

    async def post_rpc_reply(self, client, endpoint, data, **_options):
        return AKSellUpstreamReply(
            payload=await self.post_rpc(client, endpoint, data),
            headers={},
            url="https://gateway.example/RPC/Google_Secret",
        )


def fixed_clock() -> AKSellClock:
    return AKSellClock(lambda: datetime(2026, 7, 30, 21, 12, 34, 567000, tzinfo=BEIJING_TIMEZONE))


def make_request(headers: dict[str, str] | None = None) -> Request:
    raw_headers = [(key.lower().encode("ascii"), value.encode("ascii")) for key, value in (headers or {}).items()]
    return Request({
        "type": "http",
        "method": "GET",
        "scheme": "https",
        "path": "/admin/api/ak-sell/time",
        "headers": raw_headers,
        "client": ("203.0.113.10", 443),
    })


def make_local_request(headers: dict[str, str]) -> Request:
    raw_headers = [(key.lower().encode("ascii"), value.encode("ascii")) for key, value in headers.items()]
    return Request({
        "type": "http",
        "method": "POST",
        "scheme": "https",
        "path": "/RPC/Login",
        "headers": raw_headers,
        "client": ("127.0.0.1", 443),
    })


@pytest.mark.asyncio
async def test_submit_uses_main_account_endpoint_with_only_allowed_fields():
    provider = FakeProvider()
    service = AKSellService(provider=provider, clock=fixed_clock())

    result = await service.invoke(
        "submit",
        {
            "key": "key-1",
            "UserID": "42",
            "v": "untrusted-client-value",
            "lang": "cn",
            "mnemonicid1": 3,
            "mnemonickey": "challenge-key",
            "mnemonicstr1": "word",
            "gCode": "123456",
            "count": 200,
            "ignored": "must-not-reach-upstream",
        },
    )

    assert result["success"] is True
    assert provider.calls == [
        (
            "ACE_Sell",
            {
                "key": "key-1",
                "UserID": "42",
                "v": "2096",
                "lang": "cn",
                "amount": "",
                "password": "",
                "sonId": "",
                "mnemonicid1": "3",
                "mnemonickey": "challenge-key",
                "mnemonicstr1": "word",
                "gCode": "123456",
                "count": "200",
            },
        )
    ]
    assert result["server_time"]["v"] == "2096"
    assert result["server_time"]["epoch_ms"] == 1785417154567


@pytest.mark.asyncio
async def test_submit_uses_subaccount_endpoint_when_son_id_is_present():
    provider = FakeProvider()
    service = AKSellService(provider=provider, clock=fixed_clock())

    await service.invoke(
        "submit",
        {
            "key": "key-1",
            "user_id": "42",
            "mnemonicid1": "3",
            "mnemonickey": "challenge-key",
            "mnemonicstr1": "word",
            "gcode": "123456",
            "count": "200",
            "son_id": "sub-8",
        },
    )

    assert provider.calls[0][0] == "ACE_Sell_Son"
    assert provider.calls[0][1]["sonId"] == "sub-8"
    assert provider.calls[0][1]["v"] == "2096"


@pytest.mark.asyncio
async def test_submit_read_timeout_is_unknown_and_not_retried():
    provider = FakeProvider(error=AKSellUpstreamError("ReadTimeout", is_read_timeout=True))
    service = AKSellService(provider=provider, clock=fixed_clock())

    result = await service.invoke(
        "submit",
        {
            "key": "key-1",
            "UserID": "42",
            "mnemonicid1": "3",
            "mnemonickey": "challenge-key",
            "mnemonicstr1": "word",
            "gCode": "123456",
            "count": "200",
        },
    )

    assert result["state"] == "unknown"
    assert result["server_time"]["v"] == "2096"
    assert len(provider.calls) == 1


@pytest.mark.asyncio
async def test_missing_required_field_is_rejected_before_the_upstream_call():
    provider = FakeProvider()
    service = AKSellService(provider=provider, clock=fixed_clock())

    with pytest.raises(AKSellInputError, match="gCode"):
        await service.invoke(
            "submit",
            {
                "key": "key-1",
                "UserID": "42",
                "mnemonicid1": "3",
                "mnemonickey": "challenge-key",
                "mnemonicstr1": "word",
                "count": "200",
            },
        )

    assert provider.calls == []


@pytest.mark.asyncio
async def test_upstream_business_rejection_is_returned_without_a_retry():
    provider = FakeProvider(result={"Error": True, "Msg": "insufficient balance"})
    service = AKSellService(provider=provider, clock=fixed_clock())

    result = await service.invoke("login", {"account": "demo", "password": "secret"})

    assert result["success"] is False
    assert result["state"] == "rejected"
    assert result["payload"] == {"Error": True, "Msg": "insufficient balance"}
    assert len(provider.calls) == 1


def test_server_time_is_utc_normalized_and_calculates_upstream_v():
    snapshot = fixed_clock().snapshot()

    assert snapshot == {
        "epoch_ms": 1785417154567,
        "utc": "2026-07-30T13:12:34.567000Z",
        "beijing": "2026-07-30T21:12:34.567000+08:00",
        "v": "2096",
    }


@pytest.mark.asyncio
async def test_license_guard_does_not_call_validator_without_machine_authorization():
    calls = []

    async def validator(code, client_ip):
        calls.append((code, client_ip))
        return {"success": True}

    response = await AKSellLicenseGuard(validator).authorize(make_request())

    assert response is not None
    assert response.status_code == 403
    assert json.loads(response.body)["error_code"] == "AUTHORIZATION_REQUIRED"
    assert calls == []


@pytest.mark.asyncio
async def test_license_guard_allows_only_a_server_verified_machine_authorization():
    calls = []

    async def validator(code, client_ip):
        calls.append((code, client_ip))
        return {"success": True}

    response = await AKSellLicenseGuard(validator).authorize(
        make_request({MACHINE_AUTHORIZATION_HEADER: "signed-machine-authorization"})
    )

    assert response is None
    assert calls == [("signed-machine-authorization", "203.0.113.10")]


@pytest.mark.asyncio
async def test_license_guard_rejects_a_revoked_or_disabled_machine_before_upstream_work():
    async def validator(_code, _client_ip):
        return {"success": False, "message": "机器已被禁用", "error_code": "DEVICE_BLACKLISTED"}

    response = await AKSellLicenseGuard(validator).authorize(
        make_request({MACHINE_AUTHORIZATION_HEADER: "revoked-machine-authorization"})
    )

    assert response is not None
    assert response.status_code == 403
    assert json.loads(response.body) == {
        "success": False,
        "message": "机器已被禁用",
        "error_code": "DEVICE_BLACKLISTED",
    }


@pytest.mark.asyncio
async def test_time_sync_only_requires_machine_authorization_not_admin_bearer_token():
    service = AKSellService(provider=FakeProvider(), clock=fixed_clock())
    app = FastAPI()

    async def validator(code, _client_ip):
        return {"success": code == "active-machine-authorization"}

    app.include_router(create_ak_sell_router(
        service=service,
        machine_authorization_validator=validator,
    ))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as client:
        response = await client.get(
            "/admin/api/ak-sell/time",
            headers={MACHINE_AUTHORIZATION_HEADER: "active-machine-authorization"},
        )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store, private"
    assert response.json()["server_time"]["v"] == "2096"


def test_ak_sell_internal_rpc_token_requires_loopback_and_matches_constant_time():
    service = AKSellService(provider=FakeProvider(), clock=fixed_clock())
    token = service._internal_rpc_token

    assert service.is_internal_rpc_request(make_local_request({AK_SELL_INTERNAL_RPC_HEADER: token})) is True
    assert service.is_internal_rpc_request(make_request({AK_SELL_INTERNAL_RPC_HEADER: token})) is False
    assert service.is_internal_rpc_request(make_local_request({AK_SELL_INTERNAL_RPC_HEADER: "wrong"})) is False


@pytest.mark.asyncio
async def test_google_bind_route_requires_only_machine_authorization():
    service = AKSellService(
        provider=FakeProvider(result={"Error": False, "BindKey": "0XYBCWJOQMMGH0R"}),
        clock=fixed_clock(),
    )
    app = FastAPI()

    async def validator(code, _client_ip):
        return {"success": code == "active-machine-authorization"}

    app.include_router(create_ak_sell_router(
        service=service,
        machine_authorization_validator=validator,
    ))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://testserver") as client:
        response = await client.post(
            "/admin/api/ak-sell/google-bind",
            headers={MACHINE_AUTHORIZATION_HEADER: "active-machine-authorization"},
            json={
                "key": "key-1",
                "UserID": "42",
                "activationCode": "activation-code",
                "tradePassword": "trade-pin",
            },
        )

    assert response.status_code == 200
    assert response.json()["success"] is True


@pytest.mark.asyncio
async def test_google_bind_uses_server_time_and_returns_secret_without_persisting_it():
    provider = FakeProvider(result={"Error": False, "BindKey": "0XYBCWJOQMMGH0R"})
    service = AKSellService(provider=provider, clock=fixed_clock())

    result = await service.invoke(
        "google-bind",
        {
            "key": "key-1",
            "UserID": "42",
            "activationCode": "activation-code",
            "tradePassword": "trade-pin",
        },
    )

    assert result["success"] is True
    assert result["google_secret"] == "OXYBCWJOQMMGHOR"
    assert [call[0] for call in provider.calls] == ["Google_Secret", "Google_Bind"]
    assert provider.calls[1][1]["gCode"].isdigit()
    assert provider.calls[1][1]["v"] == "2096"
    assert "aCode" not in provider.calls[1][1]
    assert "pin" not in provider.calls[1][1]


@pytest.mark.asyncio
async def test_google_unbind_uses_only_the_challenge_words_requested_by_ak():
    class UnbindProvider(FakeProvider):
        async def post_rpc(self, _client, endpoint, data):
            self.calls.append((endpoint, data))
            if endpoint == "Mnemonic_Get03":
                return {
                    "Error": False,
                    "mnemonicid1": 2,
                    "mnemonicid2": 5,
                    "mnemonicid3": 8,
                    "mnemonickey": "challenge-key",
                }
            return {"Error": False, "Msg": "unbound"}

    provider = UnbindProvider()
    service = AKSellService(provider=provider, clock=fixed_clock())

    result = await service.invoke(
        "google-unbind",
        {
            "key": "key-1",
            "UserID": "42",
            "tradePassword": "trade-pin",
            "mnemonicWords": [f"word-{index}" for index in range(1, 13)],
        },
    )

    assert result["success"] is True
    assert [call[0] for call in provider.calls] == ["Mnemonic_Get03", "Google_Unbind"]
    request = provider.calls[1][1]
    assert request["mnemonicstr1"] == "word-2"
    assert request["mnemonicstr2"] == "word-5"
    assert request["mnemonicstr3"] == "word-8"
