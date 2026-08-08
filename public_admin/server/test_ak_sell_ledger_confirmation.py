import pytest

from public_admin.server.ak_sell_ledger.confirmation import (
    AKSellBalanceConfirmationService,
    BalanceSnapshot,
)


class FakeRepository:
    def __init__(self, tasks):
        self.tasks = list(tasks)
        self.confirmed = []
        self.retried = []

    async def claim_due_balance_confirmations(self, limit=20):
        tasks, self.tasks = self.tasks, []
        return tasks[:limit]

    async def mark_balance_confirmation_confirmed(self, task_id):
        self.confirmed.append(task_id)

    async def retry_balance_confirmation(self, task_id, error, retry_seconds=5):
        self.retried.append((task_id, error, retry_seconds))
        return "pending"


class FakeLedger:
    def __init__(self):
        self.calls = []

    async def record_success(self, **payload):
        self.calls.append(payload)
        return True


class FakeLogger:
    def __init__(self):
        self.messages = []

    def info(self, message, *args):
        self.messages.append(message % args)

    def warning(self, message, *args):
        self.messages.append(message % args)


def task(*, task_id="task-1", initial="500", amount="200"):
    return {
        "task_id": task_id,
        "account": "demo",
        "endpoint": "ACE_Sell_Son",
        "sub_account_id": "sub-8",
        "amount": amount,
        "initial_balance": initial,
        "source": "ak_sell_api",
    }


@pytest.mark.asyncio
async def test_exact_balance_delta_records_a_confirmed_sale():
    repository = FakeRepository([task()])
    ledger = FakeLedger()

    async def probe(_task):
        return BalanceSnapshot(value=300)

    service = AKSellBalanceConfirmationService(repository, ledger, probe, FakeLogger())

    assert await service.run_once() == 1
    assert repository.confirmed == ["task-1"]
    assert repository.retried == []
    assert ledger.calls[0]["confirmation_method"] == "balance_delta"
    assert ledger.calls[0]["request_data"] == {"sonId": "sub-8", "count": "200"}
    assert ledger.calls[0]["payload"]["Confirmation"]["expected_balance"] == 300


@pytest.mark.asyncio
async def test_non_exact_balance_delta_never_records_a_sale():
    repository = FakeRepository([task()])
    ledger = FakeLedger()

    async def probe(_task):
        return BalanceSnapshot(value=299)

    service = AKSellBalanceConfirmationService(repository, ledger, probe, FakeLogger())

    assert await service.run_once() == 1
    assert ledger.calls == []
    assert repository.confirmed == []
    assert repository.retried == [("task-1", "balance=299, expected=300", 5)]
