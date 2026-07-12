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

    async def cached_notice(force_retry=False):
        assert force_retry is False
        return _fresh_global_notice()

    service._ensure_global_notice = cached_notice
    result = asyncio.run(service.dashboard("operator-a", False))

    assert repository.dashboard_source == "system-source"
    assert repository.discovery is None
    result = asyncio.run(service.request_scan("operator-a", False))

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

        async def claim_global_notice_refresh(self, holder, force_retry=False):
            assert force_retry is False
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


def test_load_auth_allows_one_attempt_with_locally_expired_key():
    class AuthStore:
        def __init__(self):
            self.allow_expired = None

        async def get_ak_auth_state(self, account, allow_expired=False):
            assert account == "system-source"
            self.allow_expired = allow_expired
            return {
                "userkey": "saved-key",
                "login_result": {"Data": {"UserID": "source-user"}},
            }

    auth_store = AuthStore()
    service = GuidedSaleStatisticsService(repository=None, auth_store=auth_store, system_config=_SystemConfig())

    auth = asyncio.run(service._load_auth("system-source"))

    assert auth_store.allow_expired is True
    assert auth == {"account": "system-source", "key": "saved-key", "user_id": "source-user"}


def test_valid_cached_key_calls_notice_without_login_refresh():
    class Repository:
        pass

    service = GuidedSaleStatisticsService(Repository(), auth_store=None, system_config=_SystemConfig())
    calls = []

    async def gated_post(client, identity, endpoint, data):
        calls.append((identity, endpoint, dict(data)))
        return {"Data": {"List": []}}

    async def refresh_auth(*args, **kwargs):
        raise AssertionError("a usable cached key must be tried before Login")

    service._gated_post = gated_post
    service._refresh_auth = refresh_auth
    payload, auth = asyncio.run(service._call_with_one_refresh(
        None,
        "system-source",
        {"account": "system-source", "key": "saved-key", "user_id": "source-user"},
        endpoint="Notice_List",
        data={"p": "1"},
        refresh_attempted=False,
        mark_refresh_attempted=lambda: None,
    ))

    assert payload == {"Data": {"List": []}}
    assert auth["key"] == "saved-key"
    assert calls == [("source-user", "Notice_List", {"p": "1", "key": "saved-key", "UserID": "source-user"})]


def test_refresh_auth_prefers_existing_user_password_store():
    class Repository:
        async def get_account_password(self, account):
            raise AssertionError("legacy password fallback should not be queried")

    class AuthStore:
        def __init__(self):
            self.saved = None

        async def get_user_password(self, account):
            assert account == "system-source"
            return "stored-password"

        async def save_ak_auth_state(self, account, **kwargs):
            self.saved = (account, kwargs)

    auth_store = AuthStore()
    service = GuidedSaleStatisticsService(Repository(), auth_store=auth_store, system_config=_SystemConfig())
    sent = []

    async def gated_post(client, identity, endpoint, data):
        sent.append((identity, endpoint, dict(data)))
        return {"Data": {"UserID": "source-user", "UserKey": "new-key"}}

    service._gated_post = gated_post
    auth = asyncio.run(service._refresh_auth(None, "system-source", {"user_id": "old-user"}))

    assert auth == {"account": "system-source", "key": "new-key", "user_id": "source-user"}
    assert sent[0][1] == "Login"
    assert sent[0][2]["password"] == "stored-password"
    assert auth_store.saved[0] == "system-source"
