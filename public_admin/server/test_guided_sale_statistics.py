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
