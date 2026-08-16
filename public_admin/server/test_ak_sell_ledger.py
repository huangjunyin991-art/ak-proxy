from __future__ import annotations

import pytest

from public_admin.server.ak_sell_ledger.parser import build_record, parse_success_payload, sanitize_payload
from public_admin.server.ak_sell_ledger.service import AKSellLedgerService


class FakeRepository:
    def __init__(self):
        self.records = []
        self.attempts = []
        self.config_value = {"retention_days": 365}
        self.cleaned_days = None

    async def record(self, record):
        self.records.append(dict(record))
        return True

    async def record_attempt(self, record):
        self.attempts.append(dict(record))
        return True

    async def dashboard(self, **kwargs):
        return {"summary": {"records": len(self.records)}, "rows": self.records, "config": self.config_value}

    async def get_config(self):
        return dict(self.config_value)

    async def save_config(self, days):
        self.config_value = {"retention_days": days}
        return dict(self.config_value)

    async def cleanup(self):
        self.cleaned_days = self.config_value["retention_days"]
        return {"deleted": 3, "cutoff": "2026-01-01 00:00:00", "retention_days": self.cleaned_days}


def test_parser_requires_explicit_upstream_success():
    assert parse_success_payload({"Error": False, "Msg": "出售成功"}) == (True, "出售成功")
    assert parse_success_payload({"Error": "false", "Msg": "出售成功"}) == (True, "出售成功")
    assert parse_success_payload({"error": False, "message": "sold"}) == (True, "sold")
    assert parse_success_payload({"success": True, "message": "sold"}) == (True, "sold")
    assert parse_success_payload({"Error": True, "Msg": "失败"}) == (False, "失败")
    assert parse_success_payload({"Msg": "没有明确状态"})[0] is False


def test_record_uses_request_amount_and_strips_secrets():
    record = build_record(
        account="Main001",
        endpoint="ACE_Sell_Son",
        request_data={"count": "123", "sonId": "88", "key": "secret", "gCode": "123456"},
        payload={"Error": False, "Msg": "出售成功", "key": "should-not-persist"},
        source="ak_sell_api",
    )
    assert record is not None
    assert record["account"] == "main001"
    assert record["amount"] == "123"
    assert record["sub_account_id"] == "88"
    assert "key" not in record["upstream_payload"]
    assert "should-not-persist" not in str(sanitize_payload({"key": "should-not-persist"}))


@pytest.mark.asyncio
async def test_failed_sale_is_not_recorded():
    repository = FakeRepository()
    service = AKSellLedgerService(repository)
    saved = await service.record_success(
        account="buyer",
        endpoint="ACE_Sell",
        request_data={"count": "10"},
        payload={"Error": True, "Msg": "失败"},
        source="admin_web",
    )
    assert saved is False
    assert repository.records == []


@pytest.mark.asyncio
async def test_attempt_record_accepts_string_success_and_strips_secrets():
    repository = FakeRepository()
    service = AKSellLedgerService(repository)

    saved = await service.record_attempt(
        account="Main001",
        endpoint="ACE_Sell",
        request_data={
            "count": "10",
            "key": "secret-key",
            "mnemonickey": "secret-mnemonic-key",
            "mnemonicstr1": "secret-word",
            "gCode": "123456",
        },
        payload={"Error": "false", "Msg": "出售成功", "Sokey": "secret-sokey"},
        source="ak_sell_api",
        trace_id="ak-sell-test",
    )

    assert saved is True
    assert repository.attempts[0]["state"] == "success"
    dumped = str(repository.attempts[0])
    assert "secret-key" not in dumped
    assert "secret-mnemonic-key" not in dumped
    assert "secret-word" not in dumped
    assert "123456" not in dumped
    assert "secret-sokey" not in dumped


@pytest.mark.asyncio
async def test_cleanup_uses_saved_retention_only_when_called():
    repository = FakeRepository()
    service = AKSellLedgerService(repository)
    await service.save_config({"retention_days": 90})
    assert repository.cleaned_days is None
    result = await service.cleanup()
    assert repository.cleaned_days == 90
    assert result["deleted"] == 3


@pytest.mark.asyncio
async def test_retention_range_is_validated():
    service = AKSellLedgerService(FakeRepository())
    with pytest.raises(ValueError):
        await service.save_config({"retention_days": 0})
    with pytest.raises(ValueError):
        await service.save_config({"retention_days": 3651})
