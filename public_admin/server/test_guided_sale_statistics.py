import asyncio
from datetime import datetime, timedelta

from public_admin.server.guided_sale_statistics.parser import find_latest_guided_sale
from public_admin.server.guided_sale_statistics.service import GuidedSaleStatisticsService


def _notice(count: int, created_at: str, start: str, end: str) -> dict:
    return {
        "Id": str(count),
        "Title": f"【AK第{count}次指导销售公告】",
        "CreateTime": created_at,
        "Text": f"<p>本次指导销售规则为：</p><p>{start}至{end}之间注册的账户</p>",
    }


def test_find_latest_guided_sale_sorts_by_create_time_and_extracts_window():
    payload = {
        "Data": {
            "List": [
                _notice(18, "2026-06-01 09:00:00", "2026年5月1日", "2026年5月31日"),
                _notice(19, "2026-07-01 09:00:00", "2026年6月1日", "2026年6月30日"),
            ]
        }
    }

    result = find_latest_guided_sale(payload)

    assert result is not None
    assert result["sale_count"] == 19
    assert result["start_date_key"] == 20260601
    assert result["end_date_key"] == 20260630


def test_page_filter_keeps_window_matches_and_stops_after_older_page():
    rows = [
        {"MemberNo": "child-new", "CreateTime": "2026年6月30日"},
        {"MemberNo": "child-match", "CreateTime": "2026年6月15日"},
        {"MemberNo": "child-old", "CreateTime": "2026年5月31日"},
    ]

    matches, reached_before_start = GuidedSaleStatisticsService._filter_page_rows(
        rows, 20260601, 20260630
    )

    assert matches == [
        {"account": "child-new", "createTime": "2026年6月30日"},
        {"account": "child-match", "createTime": "2026年6月15日"},
    ]
    assert reached_before_start is True


class _SystemConfig:
    async def get(self, key, default):
        return default


class _GlobalDashboardRepository:
    def __init__(self):
        self.dashboard_source = ""
        self.discovery = None

    async def list_scope_accounts(self, owner_scope, is_super_admin):
        return [{"username": "target-a", "nickname": "A"}]

    async def get_run(self, owner_scope, source_account):
        return None

    async def create_or_get_run(self, owner_scope, source_account):
        return {"id": 41, "owner_scope": owner_scope, "source_account": source_account}

    async def reset_run(self, run_id):
        assert run_id == 41

    async def complete_discovery(self, run_id, source_user_id, notice, targets):
        self.discovery = (run_id, source_user_id, dict(notice), targets)

    async def ensure_run_jobs(self, run_id, targets):
        raise AssertionError("new runs must be initialized through complete_discovery")

    async def dashboard(self, owner_scope, source_account, retention_days):
        self.dashboard_source = source_account
        return {
            "run": {"state": "scanning", "notice_id": "45", "cache_written_at": datetime.now()},
            "jobs": [{"target_account": "target-a", "state": "pending", "matched_count": 0}],
            "rows": [],
        }


def _fresh_global_notice():
    return {
        "source_account": "system-source",
        "source_user_id": "10001",
        "notice_id": "45",
        "sale_count": 45,
        "title": "第45次指导销售公告",
        "target_line": "2026-06-01 至 2026-06-30",
        "start_date_key": 20260601,
        "end_date_key": 20260630,
        "start_date_label": "2026-06-01",
        "end_date_label": "2026-06-30",
        "notice_cached_at": datetime.now(),
        "refresh_state": "ready",
    }


def test_dashboard_uses_global_notice_without_exposing_source_to_normal_admin():
    repository = _GlobalDashboardRepository()
    service = GuidedSaleStatisticsService(repository, auth_store=None, system_config=_SystemConfig())

    async def cached_notice():
        return _fresh_global_notice()

    service._ensure_global_notice = cached_notice
    result = asyncio.run(service.dashboard("operator-a", False))

    assert repository.dashboard_source == "system-source"
    assert repository.discovery[1] == "10001"
    assert repository.discovery[3] == ["target-a"]
    assert result["source_account"] == ""
    assert result["notice"]["source_account"] == ""
    assert result["notice"]["sale_count"] == 45
    assert result["notice"]["fresh"] is True


def test_worker_never_claims_legacy_source_notice_jobs():
    class Repository:
        async def claim_next_job(self, worker_id):
            return None

    service = GuidedSaleStatisticsService(Repository(), auth_store=None, system_config=_SystemConfig())

    assert asyncio.run(service._run_once()) is False


def test_global_notice_freshness_is_exactly_one_hour():
    fresh = _fresh_global_notice()
    fresh["notice_cached_at"] = datetime.now() - timedelta(minutes=59, seconds=59)
    stale = dict(fresh)
    stale["notice_cached_at"] = datetime.now() - timedelta(hours=1, seconds=1)

    assert GuidedSaleStatisticsService._global_notice_is_fresh(fresh) is True
    assert GuidedSaleStatisticsService._global_notice_is_fresh(stale) is False


def test_global_refresh_reads_notice_without_checking_source_presence():
    class Repository:
        def __init__(self):
            self.record = {
                "source_account": "system-source",
                "source_user_id": "",
                "notice_id": "",
                "title": "",
                "notice_cached_at": None,
                "refresh_state": "pending",
            }

        async def get_global_notice(self):
            return dict(self.record)

        async def claim_global_notice_refresh(self, holder):
            self.record["lease_owner"] = holder
            return dict(self.record)

        async def get_active_account(self, account):
            assert account == "system-source"
            return {"username": account}

        async def cache_global_notice(self, holder, source_account, source_user_id, notice):
            assert source_account == "system-source"
            assert source_user_id == "source-user"
            self.record.update(notice)
            self.record.update({
                "source_user_id": source_user_id,
                "notice_cached_at": datetime.now(),
                "refresh_state": "ready",
                "lease_owner": "",
            })
            return True

        async def defer_global_notice_refresh(self, holder, seconds, error=""):
            raise AssertionError("notice refresh must not be deferred")

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

    class Provider:
        def build_client(self):
            return Client()

    repository = Repository()
    service = GuidedSaleStatisticsService(repository, auth_store=None, system_config=_SystemConfig())
    service.provider = Provider()

    async def fake_load_auth(account):
        return {"account": account, "key": "cached-key", "user_id": "source-user"}

    async def fake_call(client, account, auth, *, endpoint, data, refresh_attempted, mark_refresh_attempted):
        assert account == "system-source"
        assert endpoint == "Notice_List"
        assert data["p"] == "1"
        return {"Data": {"List": [_notice(45, "2026-07-01 09:00:00", "2026年6月1日", "2026年6月30日")]}}, {
            "account": account, "key": "cached-key", "user_id": "source-user"
        }

    service._load_auth = fake_load_auth
    service._call_with_one_refresh = fake_call
    result = asyncio.run(service._ensure_global_notice())

    assert result["refresh_state"] == "ready"
    assert result["sale_count"] == 45
    assert result["notice_cached_at"] is not None
