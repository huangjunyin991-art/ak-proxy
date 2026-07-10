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
                    "Title": "銆怉K绗?9娆℃寚瀵奸攢鍞叕鍛娿€?",
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
