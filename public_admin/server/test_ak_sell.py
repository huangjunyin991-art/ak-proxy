from datetime import datetime
import json

import pytest
from starlette.requests import Request

from .ak_sell.clock import AKSellClock, BEIJING_TIMEZONE
from .ak_sell.license_guard import AKSellLicenseGuard, MACHINE_AUTHORIZATION_HEADER
from .ak_sell.provider import AKSellUpstreamError
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
