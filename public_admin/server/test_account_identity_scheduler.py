import asyncio
from datetime import datetime

from public_admin.server.account_identity.admin.scheduler import AccountIdentitySyncScheduler


class FakeService:
    def __init__(self, policy=None, latest_auto_run=None, sync_result=None):
        self.policy = policy or {"enabled": True, "daily_time": "04:30", "limit_per_spec": 0}
        self.latest_auto_run = latest_auto_run
        self.sync_result = sync_result or {"started": True}
        self.start_calls = []
        self.scheduler = None

    def attach_scheduler(self, scheduler) -> None:
        self.scheduler = scheduler

    async def get_policy(self):
        return dict(self.policy)

    async def get_latest_auto_sync_run_for_day(self, now=None):
        return self.latest_auto_run

    async def start_sync(self, **kwargs):
        self.start_calls.append(dict(kwargs))
        return dict(self.sync_result)


def test_scheduler_does_not_trigger_outside_daily_window():
    now = datetime(2026, 7, 10, 20, 37, 50)
    service = FakeService()
    scheduler = AccountIdentitySyncScheduler(
        service=service,
        poll_seconds=30.0,
        auto_trigger_grace_seconds=300.0,
        now_provider=lambda: now,
    )

    asyncio.run(scheduler._tick())

    assert service.start_calls == []
    assert scheduler.snapshot()["last_auto_run_day"] == ""


def test_scheduler_triggers_once_within_daily_window():
    now = datetime(2026, 7, 10, 4, 31, 0)
    service = FakeService()
    scheduler = AccountIdentitySyncScheduler(
        service=service,
        poll_seconds=30.0,
        auto_trigger_grace_seconds=300.0,
        now_provider=lambda: now,
    )

    asyncio.run(scheduler._tick())

    assert len(service.start_calls) == 1
    assert service.start_calls[0]["triggered_by"] == "system:auto"
    assert service.start_calls[0]["trigger_mode"] == "auto"
    assert scheduler.snapshot()["last_auto_run_day"] == "2026-07-10"


def test_scheduler_window_includes_one_poll_cycle_buffer():
    now = datetime(2026, 7, 10, 4, 35, 10)
    service = FakeService()
    scheduler = AccountIdentitySyncScheduler(
        service=service,
        poll_seconds=30.0,
        auto_trigger_grace_seconds=300.0,
        now_provider=lambda: now,
    )

    asyncio.run(scheduler._tick())

    assert len(service.start_calls) == 1


def test_scheduler_uses_persisted_auto_run_to_prevent_duplicate_trigger():
    now = datetime(2026, 7, 10, 4, 31, 0)
    service = FakeService(
        latest_auto_run={
            "id": 9,
            "trigger_mode": "auto",
            "started_at": datetime(2026, 7, 10, 4, 30, 12),
        }
    )
    scheduler = AccountIdentitySyncScheduler(
        service=service,
        poll_seconds=30.0,
        auto_trigger_grace_seconds=300.0,
        now_provider=lambda: now,
    )

    asyncio.run(scheduler._tick())

    assert service.start_calls == []
    snapshot = scheduler.snapshot()
    assert snapshot["last_auto_run_day"] == "2026-07-10"
    assert snapshot["last_auto_trigger_at"] == "2026-07-10 04:30:12"


def test_scheduler_marks_empty_auto_check_without_creating_a_run():
    now = datetime(2026, 7, 10, 4, 31, 0)
    service = FakeService(sync_result={"success": True, "started": False, "skipped": True})
    scheduler = AccountIdentitySyncScheduler(
        service=service,
        poll_seconds=30.0,
        auto_trigger_grace_seconds=300.0,
        now_provider=lambda: now,
    )

    asyncio.run(scheduler._tick())
    asyncio.run(scheduler._tick())

    assert len(service.start_calls) == 1
    snapshot = scheduler.snapshot()
    assert snapshot["last_auto_check_day"] == "2026-07-10"
    assert snapshot["last_auto_run_day"] == ""
