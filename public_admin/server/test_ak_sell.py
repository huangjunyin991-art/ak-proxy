import pytest

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


@pytest.mark.asyncio
async def test_submit_uses_main_account_endpoint_with_only_allowed_fields():
    provider = FakeProvider()
    service = AKSellService(provider=provider)

    result = await service.invoke(
        "submit",
        {
            "key": "key-1",
            "UserID": "42",
            "v": "2069",
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
                "v": "2069",
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


@pytest.mark.asyncio
async def test_submit_uses_subaccount_endpoint_when_son_id_is_present():
    provider = FakeProvider()
    service = AKSellService(provider=provider)

    await service.invoke(
        "submit",
        {
            "key": "key-1",
            "user_id": "42",
            "v": "2069",
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


@pytest.mark.asyncio
async def test_submit_read_timeout_is_unknown_and_not_retried():
    provider = FakeProvider(error=AKSellUpstreamError("ReadTimeout", is_read_timeout=True))
    service = AKSellService(provider=provider)

    result = await service.invoke(
        "submit",
        {
            "key": "key-1",
            "UserID": "42",
            "v": "2069",
            "mnemonicid1": "3",
            "mnemonickey": "challenge-key",
            "mnemonicstr1": "word",
            "gCode": "123456",
            "count": "200",
        },
    )

    assert result["state"] == "unknown"
    assert len(provider.calls) == 1


@pytest.mark.asyncio
async def test_missing_required_field_is_rejected_before_the_upstream_call():
    provider = FakeProvider()
    service = AKSellService(provider=provider)

    with pytest.raises(AKSellInputError, match="gCode"):
        await service.invoke(
            "submit",
            {
                "key": "key-1",
                "UserID": "42",
                "v": "2069",
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
    service = AKSellService(provider=provider)

    result = await service.invoke("login", {"account": "demo", "password": "secret"})

    assert result["success"] is False
    assert result["state"] == "rejected"
    assert result["payload"] == {"Error": True, "Msg": "insufficient balance"}
    assert len(provider.calls) == 1
