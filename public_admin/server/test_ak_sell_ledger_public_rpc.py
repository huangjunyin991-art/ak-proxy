import pytest

from public_admin.server.ak_sell_ledger.public_rpc import PublicRpcSaleRecorder


class FakeLedgerService:
    def __init__(self):
        self.calls = []

    async def record_success(self, **payload):
        self.calls.append(payload)
        return True


class FakeLogger:
    def __init__(self):
        self.warnings = []
        self.infos = []

    def warning(self, message, *args):
        self.warnings.append(message % args)

    def info(self, message, *args):
        self.infos.append(message % args)


@pytest.mark.asyncio
async def test_records_confirmed_public_subaccount_sale_with_cookie_identity():
    ledger = FakeLedgerService()
    recorder = PublicRpcSaleRecorder(ledger, lambda _key: _resolved(""), FakeLogger())

    saved = await recorder.record_if_success(
        normalized_path="ace_sell_son",
        params={"key": "secret", "UserID": "42", "sonId": "88", "count": "123"},
        payload={"Error": False, "Msg": "sold"},
        cookies={"ak_username": "Main001"},
        request_id="request-1",
    )

    assert saved is True
    assert ledger.calls == [{
        "account": "main001",
        "endpoint": "ACE_Sell_Son",
        "request_data": {"key": "secret", "UserID": "42", "sonId": "88", "count": "123"},
        "payload": {"Error": False, "Msg": "sold"},
        "source": "public_rpc",
        "request_id": "request-1",
    }]


@pytest.mark.asyncio
async def test_resolves_public_sale_account_from_saved_key_when_cookie_is_missing():
    ledger = FakeLedgerService()
    resolved_keys = []

    async def resolve_account(key):
        resolved_keys.append(key)
        return "main002"

    recorder = PublicRpcSaleRecorder(ledger, resolve_account, FakeLogger())
    saved = await recorder.record_if_success(
        normalized_path="ace_sell",
        params={"Key": "persisted-key", "UserID": "43", "count": "99"},
        payload={"Error": False, "Msg": "sold"},
        cookies={},
    )

    assert saved is True
    assert resolved_keys == ["persisted-key"]
    assert ledger.calls[0]["account"] == "main002"
    assert ledger.calls[0]["endpoint"] == "ACE_Sell"


@pytest.mark.asyncio
async def test_cookie_identity_wins_over_a_spoofed_request_account():
    ledger = FakeLedgerService()
    recorder = PublicRpcSaleRecorder(ledger, lambda _key: _resolved("main002"), FakeLogger())

    saved = await recorder.record_if_success(
        normalized_path="ace_sell",
        params={"account": "spoofed", "key": "persisted-key", "count": "99"},
        payload={"Error": False, "Msg": "sold"},
        cookies={"ak_username": "Main004"},
    )

    assert saved is True
    assert ledger.calls[0]["account"] == "main004"


@pytest.mark.asyncio
async def test_does_not_record_http_success_when_upstream_business_response_failed():
    ledger = FakeLedgerService()
    logger = FakeLogger()
    recorder = PublicRpcSaleRecorder(ledger, lambda _key: _resolved("main003"), logger)

    saved = await recorder.record_if_success(
        normalized_path="ace_sell",
        params={"key": "key-3", "count": "99"},
        payload={"Error": True, "Msg": "rejected"},
        cookies={},
    )

    assert saved is False
    assert ledger.calls == []
    assert "reason=upstream_rejected" in logger.infos[0]


@pytest.mark.asyncio
async def test_logs_unresolved_account_for_confirmed_public_sale():
    ledger = FakeLedgerService()
    logger = FakeLogger()
    recorder = PublicRpcSaleRecorder(ledger, lambda _key: _resolved(""), logger)

    saved = await recorder.record_if_success(
        normalized_path="ace_sell",
        params={"key": "unmapped-key", "UserID": "44", "count": "99"},
        payload={"Error": False, "Msg": "sold"},
        cookies={},
    )

    assert saved is False
    assert ledger.calls == []
    assert "reason=unresolved_account" in logger.warnings[0]


async def _resolved(value):
    return value
