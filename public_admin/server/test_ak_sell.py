from datetime import datetime
import json

import httpx
import pytest
from fastapi import FastAPI
from starlette.requests import Request

from .ak_sell.account_state import CachedAKAccountAuth, UserStatsAKAccountState
from .ak_sell.clock import AKSellClock, BEIJING_TIMEZONE
from .ak_sell.license_guard import AKSellLicenseGuard, MACHINE_AUTHORIZATION_HEADER
from .ak_sell.internal_rpc import AK_SELL_INTERNAL_RPC_HEADER
from .ak_sell.provider import AKSellUpstreamError, AKSellUpstreamReply
from .ak_sell.routes import create_ak_sell_router
from .ak_sell.service import AKSellInputError, AKSellService
from .rpc_timeout_policy import (
    AK_SELL_READ_TIMEOUT_SECONDS,
    AK_SELL_WRITE_TIMEOUT_SECONDS,
    resolve_ak_sell_forward_timeout,
    resolve_ak_sell_response_timeout,
)


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

    def build_client(self, _operation=""):
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


class FakeAccountState:
    def __init__(self, auth=None, password="saved-password"):
        self.auth = auth
        self.password = password
        self.invalidated = []

    async def get_auth(self, _account):
        return self.auth

    async def get_password(self, _account):
        return self.password

    async def invalidate_auth(self, account):
        self.invalidated.append(account)
        self.auth = None


class FakeLedgerRecorder:
    def __init__(self):
        self.calls = []

    async def record_success(self, **payload):
        self.calls.append(payload)
        return True


def fixed_clock() -> AKSellClock:
    return AKSellClock(lambda: datetime(2026, 7, 30, 21, 12, 34, 567000, tzinfo=BEIJING_TIMEZONE))


def test_ak_sell_timeout_policy_keeps_reads_fast_and_submit_separate():
    assert resolve_ak_sell_forward_timeout("My_Subaccount") == AK_SELL_READ_TIMEOUT_SECONDS
    assert resolve_ak_sell_forward_timeout("ACE_Sell_Son") == AK_SELL_WRITE_TIMEOUT_SECONDS
    assert resolve_ak_sell_response_timeout("submit") > AK_SELL_WRITE_TIMEOUT_SECONDS


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
async def test_successful_submit_records_once_after_upstream_confirmation():
    provider = FakeProvider(result={"Error": False, "Msg": "出售成功"})
    ledger = FakeLedgerRecorder()
    service = AKSellService(provider=provider, clock=fixed_clock(), ledger_recorder=ledger)

    await service.invoke(
        "submit",
        {
            "account": "buyer-1",
            "key": "key-1",
            "UserID": "42",
            "mnemonicid1": "3",
            "mnemonickey": "challenge-key",
            "mnemonicstr1": "word",
            "gCode": "123456",
            "count": "200",
            "request_id": "sell-job-1",
        },
    )

    assert len(ledger.calls) == 1
    assert ledger.calls[0]["account"] == "buyer-1"
    assert ledger.calls[0]["endpoint"] == "ACE_Sell"
    assert ledger.calls[0]["request_data"]["count"] == "200"
    assert ledger.calls[0]["request_id"] == "sell-job-1"


@pytest.mark.asyncio
async def test_rejected_submit_does_not_write_ledger():
    provider = FakeProvider(result={"Error": True, "Msg": "拒绝"})
    ledger = FakeLedgerRecorder()
    service = AKSellService(provider=provider, clock=fixed_clock(), ledger_recorder=ledger)

    await service.invoke(
        "submit",
        {
            "key": "key-1", "UserID": "42", "mnemonicid1": "3",
            "mnemonickey": "challenge-key", "mnemonicstr1": "word",
            "gCode": "123456", "count": "200",
        },
    )

    assert ledger.calls == []


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
async def test_submit_timeout_does_not_read_balance_before_forwarding():
    state = FakeAccountState(CachedAKAccountAuth("demo", "cached-key", "42"))
    provider = FakeProvider(error=AKSellUpstreamError("ReadTimeout", is_read_timeout=True))
    service = AKSellService(
        provider=provider,
        clock=fixed_clock(),
        account_state=state,
    )

    result = await service.invoke(
        "submit",
        {
            "account": "Demo",
            "mnemonicid1": "3",
            "mnemonickey": "challenge-key",
            "mnemonicstr1": "word",
            "gCode": "123456",
            "count": "200",
            "request_id": "timeout-job-1",
        },
    )

    assert result["state"] == "unknown"
    assert [call[0] for call in provider.calls] == ["ACE_Sell"]


@pytest.mark.asyncio
async def test_submit_gateway_timeout_is_unknown():
    provider = FakeProvider(error=AKSellUpstreamError("upstream returned HTTP 504", status_code=504))
    service = AKSellService(provider=provider, clock=fixed_clock())

    result = await service.invoke(
        "submit",
        {
            "key": "key-1", "UserID": "42", "mnemonicid1": "3",
            "mnemonickey": "challenge-key", "mnemonicstr1": "word",
            "gCode": "123456", "count": "200",
        },
    )

    assert result["state"] == "unknown"
    assert result["status_code"] == 504


@pytest.mark.asyncio
async def test_submit_auth_refresh_timeout_before_write_is_retryable_failure():
    state = FakeAccountState()
    provider = FakeProvider(error=AKSellUpstreamError("ReadTimeout", is_read_timeout=True))
    service = AKSellService(provider=provider, clock=fixed_clock(), account_state=state)

    result = await service.invoke(
        "submit",
        {
            "account": "demo",
            "mnemonicid1": "3",
            "mnemonickey": "challenge-key",
            "mnemonicstr1": "word",
            "gCode": "123456",
            "count": "200",
        },
    )

    assert result["state"] == "failed"
    assert result["message"] == "上游读取超时，可稍后重试"
    assert [call[0] for call in provider.calls] == ["Login"]


@pytest.mark.asyncio
async def test_login_reuses_the_server_cached_identity_without_an_upstream_login():
    cached = CachedAKAccountAuth(account="account-1", userkey="cached-key", user_id="cached-user")
    provider = FakeProvider()
    service = AKSellService(provider=provider, clock=fixed_clock(), account_state=FakeAccountState(auth=cached))

    result = await service.invoke("login", {"account": "account-1", "password": "password"})

    assert result["success"] is True
    assert result["payload"]["Key"] == "cached-key"
    assert result["payload"]["UserData"]["Id"] == "cached-user"
    assert provider.calls == []


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


@pytest.mark.asyncio
async def test_account_uses_existing_user_stats_login_state_without_relogin():
    provider = FakeProvider()
    state = FakeAccountState(CachedAKAccountAuth("demo", "cached-key", "42"))
    service = AKSellService(provider=provider, clock=fixed_clock(), account_state=state)

    result = await service.invoke("balance", {"account": "Demo"})

    assert result["success"] is True
    assert provider.calls == [
        ("public_IndexData", {"key": "cached-key", "UserID": "42", "v": "2096", "lang": "cn"}),
    ]


@pytest.mark.asyncio
async def test_account_refreshes_login_only_after_cached_state_is_missing():
    state = FakeAccountState()

    class RefreshingProvider(FakeProvider):
        async def post_rpc(self, client, endpoint, data):
            self.calls.append((endpoint, data))
            if endpoint == "Login":
                state.auth = CachedAKAccountAuth("demo", "fresh-key", "73")
                return {"Error": False, "Key": "fresh-key", "UserData": {"Id": "73"}}
            return {"Error": False, "Data": {"ACECount": 100}}

    provider = RefreshingProvider()
    service = AKSellService(provider=provider, clock=fixed_clock(), account_state=state)

    result = await service.invoke("balance", {"account": "demo"})

    assert result["success"] is True
    assert [call[0] for call in provider.calls] == ["Login", "public_IndexData"]
    assert provider.calls[0][1] == {"account": "demo", "password": "saved-password", "client": "WEB"}
    assert provider.calls[1][1]["key"] == "fresh-key"
    assert provider.calls[1][1]["UserID"] == "73"


@pytest.mark.asyncio
async def test_read_operation_refreshes_once_after_an_explicit_login_rejection():
    state = FakeAccountState(CachedAKAccountAuth("demo", "stale-key", "42"))

    class ExpiringProvider(FakeProvider):
        async def post_rpc(self, client, endpoint, data):
            self.calls.append((endpoint, data))
            if endpoint == "public_IndexData" and len([item for item in self.calls if item[0] == endpoint]) == 1:
                return {"Error": True, "Msg": "用户未登录"}
            if endpoint == "Login":
                state.auth = CachedAKAccountAuth("demo", "fresh-key", "42")
                return {"Error": False, "Key": "fresh-key", "UserData": {"Id": "42"}}
            return {"Error": False}

    provider = ExpiringProvider()
    service = AKSellService(provider=provider, clock=fixed_clock(), account_state=state)

    result = await service.invoke("balance", {"account": "demo"})

    assert result["success"] is True
    assert [call[0] for call in provider.calls] == ["public_IndexData", "Login", "public_IndexData"]
    assert state.invalidated == ["demo"]
    assert provider.calls[-1][1]["key"] == "fresh-key"


@pytest.mark.asyncio
async def test_submit_does_not_retry_when_cached_key_is_explicitly_rejected():
    state = FakeAccountState(CachedAKAccountAuth("demo", "stale-key", "42"))
    provider = FakeProvider(result={"Error": True, "Msg": "用户未登录"})
    service = AKSellService(provider=provider, clock=fixed_clock(), account_state=state)

    result = await service.invoke(
        "submit",
        {
            "account": "demo",
            "mnemonicid1": 1,
            "mnemonickey": "challenge-key",
            "mnemonicstr1": "word",
            "gCode": "123456",
            "count": 100,
        },
    )

    assert result["state"] == "auth_expired"
    assert [call[0] for call in provider.calls] == ["ACE_Sell"]
    assert state.invalidated == ["demo"]


@pytest.mark.asyncio
async def test_user_stats_adapter_extracts_key_and_user_id_from_login_state():
    async def load_auth_state(account):
        assert account == "demo"
        return {"userkey": "cached-key", "login_result": {"UserData": {"Id": "56"}}}

    async def get_password(_account):
        return "saved-password"

    async def clear_auth_state(_account):
        return True

    state = UserStatsAKAccountState(
        load_auth_state=load_auth_state,
        get_password=get_password,
        clear_auth_state=clear_auth_state,
    )

    auth = await state.get_auth("Demo")

    assert auth == CachedAKAccountAuth(account="demo", userkey="cached-key", user_id="56")


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
async def test_google_bind_retries_google_secret_only_with_redirect_following():
    class RedirectProvider(FakeProvider):
        async def post_rpc_reply(self, client, endpoint, data, **options):
            self.calls.append((endpoint, data, options.get("follow_redirects")))
            if options.get("follow_redirects") is False:
                return AKSellUpstreamReply(payload={}, headers={}, url="https://gateway.example/RPC/Google_Secret")
            return AKSellUpstreamReply(
                payload={"BindKey": "JBSWY3DPEHPK3PXP"},
                headers={},
                url="https://gateway.example/RPC/Google_Secret?ac=JBSWY3DPEHPK3PXP",
            )

        async def post_rpc(self, client, endpoint, data):
            self.calls.append((endpoint, data))
            return {"Error": False}

    provider = RedirectProvider()
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
    assert [call[2] for call in provider.calls if len(call) == 3] == [False, True]
    assert provider.calls[-1][0] == "Google_Bind"


@pytest.mark.asyncio
async def test_google_write_read_timeout_is_unknown_and_not_retried():
    provider = FakeProvider(error=AKSellUpstreamError("ReadTimeout", is_read_timeout=True))
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

    assert result["state"] == "unknown"
    assert len(provider.calls) == 1


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


@pytest.mark.asyncio
async def test_google_unbind_rejects_invalid_upstream_challenge_as_input_error():
    class InvalidChallengeProvider(FakeProvider):
        async def post_rpc(self, _client, endpoint, data):
            self.calls.append((endpoint, data))
            if endpoint == "Mnemonic_Get03":
                return {"Error": False, "mnemonicid1": "not-a-number"}
            raise AssertionError("Google_Unbind must not be called")

    service = AKSellService(provider=InvalidChallengeProvider(), clock=fixed_clock())

    with pytest.raises(AKSellInputError, match="upstream mnemonic challenge"):
        await service.invoke(
            "google-unbind",
            {
                "key": "key-1",
                "UserID": "42",
                "tradePassword": "trade-pin",
                "mnemonicWords": [f"word-{index}" for index in range(1, 13)],
            },
        )
