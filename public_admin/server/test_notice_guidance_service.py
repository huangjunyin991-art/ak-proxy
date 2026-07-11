import asyncio

from public_admin.server.notice_guidance.service import NoticeGuidanceService


NOTICE_HTML = """
<p>全球AK玩家：</p>
<p>2026年7月10日9：00am -7月10日20：00 pm（开曼群岛时间，GMT-5）</p>
<p>将进行第19次指导销售</p>
<p>本次指导销售规则为：</p>
<p>2024年9月26日-2024年9月27日之间注册的账户</p>
<p>指导销售后：</p>
"""

SCREENSHOT_NOTICE_HTML = """
<p>全球AK玩家：</p>
<p><br /></p>
2026年6月15日9：00am -6月16日20：00 pm（开曼群岛时间，GMT-5）<br />
将进行18次指导销售<br />
本次指导销售规则为：<br />
2024年9月23日-2024年9月25日之间注册的账户<br />
指导销售后：<br />
每个二星账户保留1000张AK<br />
每个三星账户保留2000张AK<br />
<p>多出的AK按注册时间的先后顺序依次售出</p>
"""


class FakeProvider:
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

    def build_client(self):
        return self._Client()

    async def fetch_subaccount_page(self, client, auth, page, page_size):
        self.calls.append((page, page_size, dict(auth)))
        return self.pages.get(page, {"rows": [], "page_size": page_size, "count": 0})


class SlowFakeProvider(FakeProvider):
    async def fetch_subaccount_page(self, client, auth, page, page_size):
        await asyncio.sleep(0.02)
        return await super().fetch_subaccount_page(client, auth, page, page_size)


class FakePauseCoordinator:
    def __init__(self, remaining_seconds=0.0, pause_until_epoch_ms=0.0):
        self.remaining_seconds = remaining_seconds
        self.pause_until_epoch_ms = pause_until_epoch_ms
        self.calls = []

    def get_pause_info(self, auth):
        self.calls.append(dict(auth))
        return {
            "remaining_seconds": self.remaining_seconds,
            "pause_until_epoch_ms": self.pause_until_epoch_ms,
        }


class FakeCacheRepository:
    def __init__(self):
        self.entries = {}
        self.read_calls = []
        self.write_calls = []

    @staticmethod
    def _key(scope):
        return (
            scope["viewer_user_id"],
            scope["auth_key_fingerprint"],
            scope["notice_key"],
            scope["start_date_key"],
            scope["end_date_key"],
        )

    async def get_completed_scan(self, scope):
        self.read_calls.append(dict(scope))
        value = self.entries.get(self._key(scope))
        return dict(value) if value else None

    async def save_completed_scan(self, scope, result):
        self.write_calls.append((dict(scope), dict(result)))
        self.entries[self._key(scope)] = {
            "accounts": list(result.get("accounts") or []),
            "rows": list(result.get("rows") or []),
            "pages_scanned": result.get("pages_scanned") or 0,
            "stop_reason": result.get("stop_reason") or "",
        }


class FailingCacheRepository:
    async def get_completed_scan(self, scope):
        raise RuntimeError("cache database unavailable")

    async def save_completed_scan(self, scope, result):
        raise RuntimeError("cache database unavailable")


def test_extract_guided_sale_window_reads_target_line_and_line_length():
    service = NoticeGuidanceService(provider=FakeProvider({}), page_interval_seconds=0.0)
    info = service.extract_guided_sale_window(
        {
            "Id": "604",
            "Title": "【AK第19次指导销售公告】",
            "Text": NOTICE_HTML,
        }
    )

    assert info is not None
    assert info["target_line"] == "2024年9月26日-2024年9月27日之间注册的账户"
    assert info["start_date_key"] == 20240926
    assert info["end_date_key"] == 20240927
    assert info["max_line_length"] >= len(info["target_line"])


def test_extract_guided_sale_window_supports_notice_markup_from_detail_page():
    service = NoticeGuidanceService(provider=FakeProvider({}), page_interval_seconds=0.0)
    info = service.extract_guided_sale_window(
        {
            "Id": "216",
            "Title": "【AK第18次指导销售公告】",
            "Text": SCREENSHOT_NOTICE_HTML,
        }
    )

    assert info is not None
    assert info["target_line"] == "2024年9月23日-2024年9月25日之间注册的账户"
    assert info["start_date_key"] == 20240923
    assert info["end_date_key"] == 20240925


def test_analyze_notice_payload_returns_disabled_for_non_guided_sale_notice():
    service = NoticeGuidanceService(provider=FakeProvider({}), page_interval_seconds=0.0)
    result = asyncio.run(
        service.analyze_notice_payload(
            {
                "notice": {"Id": "1", "Title": "普通公告", "Text": "<p>hello</p>"},
                "auth": {"key": "k", "userId": "u1", "account": "demo"},
            }
        )
    )

    assert result == {"success": True, "enabled": False}


def test_scan_subaccounts_stops_after_crossing_start_date_and_collects_matches():
    provider = FakeProvider(
        {
            1: {
                "rows": [
                    {"MemberNo": "a1", "CreateTime": "2024-09-27"},
                    {"MemberNo": "a2", "CreateTime": "2024-09-26"},
                    {"MemberNo": "a3", "CreateTime": "2024-09-25"},
                ],
                "page_size": 15,
                "count": 3,
            }
        }
    )
    service = NoticeGuidanceService(provider=provider, page_interval_seconds=0.0)
    result = asyncio.run(
        service.analyze_notice_payload(
            {
                "notice": {
                    "Id": "604",
                    "Title": "【AK第19次指导销售公告】",
                    "Text": NOTICE_HTML,
                },
                "auth": {"key": "k", "userId": "u1", "account": "demo"},
            }
        )
    )

    assert result["success"] is True
    assert result["enabled"] is True
    assert result["result"]["accounts"] == ["a1", "a2"]
    assert result["result"]["stopReason"] == "reached_before_start"
    assert provider.calls == [(1, 15, {"account": "demo", "key": "k", "user_id": "u1"})]


def test_scan_subaccounts_stops_immediately_when_first_page_is_before_window():
    provider = FakeProvider(
        {
            1: {
                "rows": [
                    {"MemberNo": "a1", "CreateTime": "2024-09-24"},
                    {"MemberNo": "a2", "CreateTime": "2024-09-23"},
                ],
                "page_size": 15,
                "count": 2,
            }
        }
    )
    service = NoticeGuidanceService(provider=provider, page_interval_seconds=0.0)
    result = asyncio.run(
        service.analyze_notice_payload(
            {
                "notice": {
                    "Id": "604",
                    "Title": "【AK第19次指导销售公告】",
                    "Text": NOTICE_HTML,
                },
                "auth": {"key": "k", "userId": "u1", "account": "demo"},
            }
        )
    )

    assert result["success"] is True
    assert result["enabled"] is True
    assert result["result"]["accounts"] == []
    assert result["result"]["stopReason"] == "first_page_before_start"


def test_analyze_notice_payload_returns_paused_result_without_calling_provider():
    provider = FakeProvider({})
    pause_coordinator = FakePauseCoordinator(remaining_seconds=42.5, pause_until_epoch_ms=1899999999000.0)
    service = NoticeGuidanceService(
        provider=provider,
        page_interval_seconds=0.0,
        pause_coordinator=pause_coordinator,
    )

    result = asyncio.run(
        service.analyze_notice_payload(
            {
                "notice": {
                    "Id": "604",
                    "Title": "【AK第19次指导销售公告】",
                    "Text": NOTICE_HTML,
                },
                "auth": {"key": "k", "userId": "u1", "account": "demo"},
            }
        )
    )

    assert result["success"] is True
    assert result["enabled"] is True
    assert result["deferred"] is True
    assert result["result"]["paused"] is True
    assert result["result"]["retryAfterSeconds"] == 42.5
    assert result["result"]["pauseUntilEpochMs"] == 1899999999000.0
    assert provider.calls == []
    assert pause_coordinator.calls == [{"account": "demo", "key": "k", "user_id": "u1"}]


def test_analyze_notice_payload_uses_persistent_cache_without_upstream_call():
    provider = FakeProvider({})
    cache = FakeCacheRepository()
    service = NoticeGuidanceService(
        provider=provider,
        page_interval_seconds=0.0,
        cache_repository=cache,
    )
    auth = {"account": "demo", "key": "k", "userId": "u1"}
    info = service.extract_guided_sale_window(
        {"Id": "604", "Title": "銆怉K绗?9娆℃寚瀵奸攢鍞叕鍛娿€?", "Text": NOTICE_HTML}
    )
    assert info is not None
    scope = service.build_cache_scope(info, service._normalize_auth(auth))
    cache.entries[cache._key(scope)] = {
        "accounts": ["cached-a1"],
        "rows": [{"account": "cached-a1", "createTime": "2024-09-26"}],
        "pages_scanned": 2,
        "stop_reason": "reached_before_start",
    }

    result = asyncio.run(
        service.analyze_notice_payload(
            {
                "notice": {"Id": "604", "Title": "銆怉K绗?9娆℃寚瀵奸攢鍞叕鍛娿€?", "Text": NOTICE_HTML},
                "auth": auth,
            }
        )
    )

    assert result["result"]["accounts"] == ["cached-a1"]
    assert result["result"]["cacheHit"] is True
    assert provider.calls == []
    assert cache.write_calls == []


def test_completed_scan_is_persisted_and_reused_by_later_service_instance():
    cache = FakeCacheRepository()
    first_provider = FakeProvider(
        {
            1: {
                "rows": [
                    {"MemberNo": "a1", "CreateTime": "2024-09-27"},
                    {"MemberNo": "a2", "CreateTime": "2024-09-25"},
                ],
                "page_size": 15,
                "count": 2,
            }
        }
    )
    payload = {
        "notice": {"Id": "604", "Title": "銆怉K绗?9娆℃寚瀵奸攢鍞叕鍛娿€?", "Text": NOTICE_HTML},
        "auth": {"account": "demo", "key": "k", "userId": "u1"},
    }
    first_service = NoticeGuidanceService(
        provider=first_provider,
        page_interval_seconds=0.0,
        cache_repository=cache,
    )
    first_result = asyncio.run(first_service.analyze_notice_payload(payload))

    assert first_result["result"]["cacheHit"] is False
    assert len(cache.write_calls) == 1
    assert first_provider.calls

    later_provider = FakeProvider({})
    later_service = NoticeGuidanceService(
        provider=later_provider,
        page_interval_seconds=0.0,
        cache_repository=cache,
    )
    later_result = asyncio.run(later_service.analyze_notice_payload(payload))

    assert later_result["result"]["accounts"] == ["a1"]
    assert later_result["result"]["cacheHit"] is True
    assert later_provider.calls == []


def test_paused_scan_is_not_persisted():
    cache = FakeCacheRepository()
    service = NoticeGuidanceService(
        provider=FakeProvider({}),
        page_interval_seconds=0.0,
        pause_coordinator=FakePauseCoordinator(remaining_seconds=15.0),
        cache_repository=cache,
    )
    result = asyncio.run(
        service.analyze_notice_payload(
            {
                "notice": {"Id": "604", "Title": "銆怉K绗?9娆℃寚瀵奸攢鍞叕鍛娿€?", "Text": NOTICE_HTML},
                "auth": {"account": "demo", "key": "k", "userId": "u1"},
            }
        )
    )

    assert result["deferred"] is True
    assert cache.write_calls == []


def test_persistent_cache_requires_the_same_auth_key_fingerprint():
    cache = FakeCacheRepository()
    first_provider = FakeProvider(
        {
            1: {
                "rows": [{"MemberNo": "a1", "CreateTime": "2024-09-27"}],
                "page_size": 15,
                "count": 1,
            }
        }
    )
    first_service = NoticeGuidanceService(
        provider=first_provider,
        page_interval_seconds=0.0,
        cache_repository=cache,
    )
    first_payload = {
        "notice": {"Id": "604", "Title": "銆怉K绗?9娆℃寚瀵奸攢鍞叕鍛娿€?", "Text": NOTICE_HTML},
        "auth": {"account": "demo", "key": "first-key", "userId": "u1"},
    }
    asyncio.run(first_service.analyze_notice_payload(first_payload))

    second_provider = FakeProvider(
        {
            1: {
                "rows": [{"MemberNo": "a2", "CreateTime": "2024-09-27"}],
                "page_size": 15,
                "count": 1,
            }
        }
    )
    second_service = NoticeGuidanceService(
        provider=second_provider,
        page_interval_seconds=0.0,
        cache_repository=cache,
    )
    second_payload = {
        "notice": first_payload["notice"],
        "auth": {"account": "demo", "key": "different-key", "userId": "u1"},
    }
    second_result = asyncio.run(second_service.analyze_notice_payload(second_payload))

    assert second_result["result"]["accounts"] == ["a2"]
    assert second_result["result"]["cacheHit"] is False
    assert second_provider.calls


def test_concurrent_same_notice_scan_is_shared():
    provider = SlowFakeProvider(
        {
            1: {
                "rows": [{"MemberNo": "a1", "CreateTime": "2024-09-27"}],
                "page_size": 15,
                "count": 1,
            }
        }
    )
    service = NoticeGuidanceService(provider=provider, page_interval_seconds=0.0)
    payload = {
        "notice": {"Id": "604", "Title": "銆怉K绗?9娆℃寚瀵奸攢鍞叕鍛娿€?", "Text": NOTICE_HTML},
        "auth": {"account": "demo", "key": "k", "userId": "u1"},
    }

    async def run_concurrent_requests():
        return await asyncio.gather(
            service.analyze_notice_payload(payload),
            service.analyze_notice_payload(payload),
        )

    first_result, second_result = asyncio.run(run_concurrent_requests())

    assert first_result["result"]["accounts"] == ["a1"]
    assert second_result["result"]["accounts"] == ["a1"]
    assert len(provider.calls) == 1


def test_persistent_cache_failure_falls_back_to_live_scan():
    provider = FakeProvider(
        {
            1: {
                "rows": [{"MemberNo": "a1", "CreateTime": "2024-09-27"}],
                "page_size": 15,
                "count": 1,
            }
        }
    )
    service = NoticeGuidanceService(
        provider=provider,
        page_interval_seconds=0.0,
        cache_repository=FailingCacheRepository(),
    )

    result = asyncio.run(
        service.analyze_notice_payload(
            {
                "notice": {"Id": "604", "Title": "銆怉K绗?9娆℃寚瀵奸攢鍞叕鍛娿€?", "Text": NOTICE_HTML},
                "auth": {"account": "demo", "key": "k", "userId": "u1"},
            }
        )
    )

    assert result["result"]["accounts"] == ["a1"]
    assert result["result"]["cacheHit"] is False
    assert provider.calls
