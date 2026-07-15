import asyncio

from public_admin.server.account_identity.admin.service import AccountIdentityAdminService


class FakeRepository:
    def __init__(self):
        self.ensure_calls = 0
        self.created_runs = []
        self.finished_runs = []

    async def ensure_tables(self):
        self.ensure_calls += 1

    async def create_sync_run(self, **kwargs):
        self.created_runs.append(dict(kwargs))
        return len(self.created_runs)

    async def finish_sync_run(self, **kwargs):
        self.finished_runs.append(dict(kwargs))


class FakeSystemConfig:
    async def get(self, key, default=None):
        return default


def _build_service(pending_specs):
    calls = {"ensure": 0, "find": 0, "backfill": []}

    async def ensure_columns(**kwargs):
        calls["ensure"] += 1
        return []

    async def collect_stats(**kwargs):
        raise AssertionError("sync execution must not collect full-table stats")

    async def find_pending(**kwargs):
        calls["find"] += 1
        return list(pending_specs)

    async def backfill(**kwargs):
        calls["backfill"].append(dict(kwargs))
        return []

    service = AccountIdentityAdminService(
        pool_supplier=lambda: None,
        system_config=FakeSystemConfig(),
        ensure_columns=ensure_columns,
        collect_stats=collect_stats,
        find_pending=find_pending,
        backfill=backfill,
        get_plan=lambda: [],
    )
    repository = FakeRepository()
    service.repository = repository
    return service, repository, calls


def test_sync_skips_without_pending_rows_or_a_run_record():
    async def scenario():
        service, repository, calls = _build_service([])

        result = await service.start_sync(triggered_by="system:auto", trigger_mode="auto")

        assert result["success"] is True
        assert result["started"] is False
        assert result["skipped"] is True
        assert repository.created_runs == []
        assert calls["backfill"] == []
        assert calls["ensure"] == 1
        assert calls["find"] == 1

    asyncio.run(scenario())


def test_sync_backfills_only_preflight_matched_specs_without_full_stats():
    async def scenario():
        pending_spec = {
            "phase": "core",
            "table_name": "user_stats",
            "username_column": "username",
            "account_id_column": "account_id",
        }
        service, repository, calls = _build_service([pending_spec])

        result = await service.start_sync(triggered_by="system:auto", trigger_mode="auto")
        task = service._active_task
        assert result["started"] is True
        assert task is not None
        await task

        assert len(repository.created_runs) == 1
        assert len(repository.finished_runs) == 1
        assert calls["backfill"] == [
            {
                "phase_key": "",
                "limit_per_spec": 0,
                "dry_run": False,
                "spec_keys": {("user_stats", "username", "account_id")},
            }
        ]

    asyncio.run(scenario())
