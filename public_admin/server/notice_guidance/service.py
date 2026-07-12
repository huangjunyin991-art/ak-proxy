from __future__ import annotations

import asyncio
import re
from html.parser import HTMLParser
from typing import Any

from .provider import DEFAULT_PAGE_SIZE, NoticeGuidanceProvider
from .repository import NoticeGuidanceCacheRepository
from .cache_scope import build_guided_sale_cache_scope
from .subaccount_pause import (
    NoticeGuidanceMySubaccountPauseCoordinator,
    notice_guidance_my_subaccount_pause_coordinator,
)

DEFAULT_PAGE_INTERVAL_SECONDS = 0.3
DEFAULT_MAX_LINE_LENGTH = 24

GUIDED_SALE_KEYWORD = "指导销售"
GUIDED_SALE_TARGET_SUFFIX = "之间注册的账户"
DATE_KEY_RE = re.compile(r"(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?")


def trim_string(value: Any) -> str:
    return str(value or "").strip()


def normalize_inline_text(value: Any) -> str:
    return re.sub(r"[ \t\r\f\v]+", " ", trim_string(value).replace("\xa0", " "))


def normalize_line_text(value: Any) -> str:
    return normalize_inline_text(value).replace("\n", " ")


def parse_date_key(value: Any) -> int:
    match = DATE_KEY_RE.search(trim_string(value).replace("\xa0", " "))
    if not match:
        return 0
    year = int(match.group(1))
    month = int(match.group(2))
    day = int(match.group(3))
    if year <= 0 or month < 1 or month > 12 or day < 1 or day > 31:
        return 0
    return year * 10000 + month * 100 + day


def format_date_key(year: int, month: int, day: int) -> int:
    return year * 10000 + month * 100 + day


def format_date_label(year: int, month: int, day: int) -> str:
    return f"{year}年{month}月{day}日"


class _NoticeHtmlLineParser(HTMLParser):
    BLOCK_TAGS = {
        "P",
        "DIV",
        "LI",
        "UL",
        "OL",
        "SECTION",
        "ARTICLE",
        "HEADER",
        "FOOTER",
        "H1",
        "H2",
        "H3",
        "H4",
        "H5",
        "H6",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.lines: list[str] = []
        self._buffer: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        upper_tag = str(tag or "").upper()
        if upper_tag == "BR":
            self._flush()
            return
        if upper_tag in self.BLOCK_TAGS:
            self._flush()

    def handle_endtag(self, tag: str) -> None:
        if str(tag or "").upper() in self.BLOCK_TAGS:
            self._flush()

    def handle_data(self, data: str) -> None:
        if data:
            self._buffer.append(data.replace("\xa0", " "))

    def close(self) -> None:
        super().close()
        self._flush()

    def _flush(self) -> None:
        line = normalize_line_text("".join(self._buffer))
        self._buffer.clear()
        if line:
            self.lines.append(line)


def extract_lines_from_html(html: str) -> list[str]:
    parser = _NoticeHtmlLineParser()
    parser.feed(str(html or ""))
    parser.close()
    return parser.lines


def extract_longest_line_length(lines: list[str], fallback_line: str) -> int:
    max_length = 0
    for line in lines:
        max_length = max(max_length, len(normalize_line_text(line)))
    if not max_length:
        max_length = len(normalize_line_text(fallback_line))
    return max_length if max_length > 0 else DEFAULT_MAX_LINE_LENGTH


def extract_guided_sale_range_line(lines: list[str]) -> tuple[str, tuple[int, int, int], tuple[int, int, int]] | None:
    for raw_line in lines:
        line = normalize_line_text(raw_line)
        if "注册" not in line or "账户" not in line:
            continue
        target_end = line.find(GUIDED_SALE_TARGET_SUFFIX)
        if target_end < 0:
            continue
        target_end += len(GUIDED_SALE_TARGET_SUFFIX)
        dates = list(DATE_KEY_RE.finditer(line[:target_end]))
        if len(dates) < 2:
            continue
        start_match, end_match = dates[-2:]
        start = (int(start_match.group(1)), int(start_match.group(2)), int(start_match.group(3)))
        end = (int(end_match.group(1)), int(end_match.group(2)), int(end_match.group(3)))
        return line[start_match.start():target_end], start, end
    return None


class NoticeGuidanceService:
    def __init__(
        self,
        provider: NoticeGuidanceProvider | None = None,
        page_size: int = DEFAULT_PAGE_SIZE,
        page_interval_seconds: float = DEFAULT_PAGE_INTERVAL_SECONDS,
        logger=None,
        pause_coordinator: NoticeGuidanceMySubaccountPauseCoordinator | None = None,
        cache_repository: NoticeGuidanceCacheRepository | None = None,
    ) -> None:
        self.provider = provider or NoticeGuidanceProvider()
        self.page_size = max(1, min(int(page_size or DEFAULT_PAGE_SIZE), 100))
        self.page_interval_seconds = max(0.0, float(page_interval_seconds or 0.0))
        self.logger = logger
        self.pause_coordinator = pause_coordinator or notice_guidance_my_subaccount_pause_coordinator
        self.cache_repository = cache_repository
        self._inflight_scans: dict[str, asyncio.Task[dict[str, Any]]] = {}
        self._inflight_scans_lock = asyncio.Lock()

    async def analyze_notice_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        notice = payload.get("notice") if isinstance(payload.get("notice"), dict) else {}
        auth_payload = payload.get("auth") if isinstance(payload.get("auth"), dict) else {}
        auth = self._normalize_auth(auth_payload)
        if not auth["key"] or not auth["user_id"]:
            raise ValueError("missing key or UserID")
        info = self.extract_guided_sale_window(notice)
        if info is None:
            return {"success": True, "enabled": False}
        cache_scope = self.build_cache_scope(info, auth)
        cached_result = await self._load_cached_scan(cache_scope)
        if cached_result is not None:
            return self._build_completed_response(info, auth, cached_result, cache_hit=True)
        scan_result = await self._get_or_start_scan(info, auth, cache_scope)
        if scan_result.get("paused"):
            return {
                "success": True,
                "enabled": True,
                "deferred": True,
                "result": {
                    "paused": True,
                    "noticeKey": self.build_notice_key(info, auth),
                    "noticeId": info["notice_id"],
                    "title": info["title"],
                    "targetLine": info["target_line"],
                    "startDateLabel": info["start_date_label"],
                    "endDateLabel": info["end_date_label"],
                    "maxLineLength": info["max_line_length"],
                    "retryAfterSeconds": scan_result["retry_after_seconds"],
                    "pauseUntilEpochMs": scan_result["pause_until_epoch_ms"],
                    "pauseReason": "manual_my_subaccount_recently_used",
                },
            }
        return self._build_completed_response(info, auth, scan_result, cache_hit=False)

    def _build_completed_response(
        self,
        info: dict[str, Any],
        auth: dict[str, str],
        scan_result: dict[str, Any],
        *,
        cache_hit: bool,
    ) -> dict[str, Any]:
        return {
            "success": True,
            "enabled": True,
            "result": {
                "noticeKey": self.build_notice_key(info, auth),
                "noticeId": info["notice_id"],
                "title": info["title"],
                "targetLine": info["target_line"],
                "startDateLabel": info["start_date_label"],
                "endDateLabel": info["end_date_label"],
                "maxLineLength": info["max_line_length"],
                "accounts": scan_result["accounts"],
                "rows": scan_result["rows"],
                "pagesScanned": scan_result["pages_scanned"],
                "stopReason": scan_result["stop_reason"],
                "cacheHit": cache_hit,
            },
        }

    def extract_guided_sale_window(self, notice: dict[str, Any]) -> dict[str, Any] | None:
        title = trim_string(notice.get("Title") or notice.get("title"))
        html = str(notice.get("Text") or notice.get("text") or "")
        if not title and not html:
            return None
        lines = extract_lines_from_html(html)
        content_text = "\n".join(lines)
        full_text = f"{title}\n{content_text}"
        if GUIDED_SALE_KEYWORD not in full_text:
            return None
        range_info = extract_guided_sale_range_line(lines)
        if range_info is None:
            return None
        target_line, start_date, end_date = range_info
        start_year, start_month, start_day = start_date
        end_year, end_month, end_day = end_date
        start_date_key = format_date_key(start_year, start_month, start_day)
        end_date_key = format_date_key(end_year, end_month, end_day)
        if not start_date_key or not end_date_key:
            return None
        start_label = format_date_label(start_year, start_month, start_day)
        end_label = format_date_label(end_year, end_month, end_day)
        fallback_target_line = f"{start_label}-{end_label}{GUIDED_SALE_TARGET_SUFFIX}"
        return {
            "notice_id": trim_string(notice.get("Id") or notice.get("id")),
            "title": title,
            "target_line": target_line or fallback_target_line,
            "start_date_key": start_date_key,
            "end_date_key": end_date_key,
            "start_date_label": start_label,
            "end_date_label": end_label,
            "max_line_length": extract_longest_line_length(lines, target_line or fallback_target_line),
        }

    def build_notice_key(self, info: dict[str, Any], auth: dict[str, str]) -> str:
        return "|".join(
            [
                trim_string(auth.get("account")).lower() or trim_string(auth.get("user_id")),
                trim_string(info.get("notice_id")),
                trim_string(info.get("title")),
                trim_string(info.get("start_date_label")),
                trim_string(info.get("end_date_label")),
            ]
        )

    @staticmethod
    def build_cache_scope(info: dict[str, Any], auth: dict[str, str]) -> dict[str, Any]:
        return build_guided_sale_cache_scope(info, auth)

    async def _load_cached_scan(self, cache_scope: dict[str, Any]) -> dict[str, Any] | None:
        if self.cache_repository is None:
            return None
        try:
            return await self.cache_repository.get_completed_scan(cache_scope)
        except Exception as exc:
            self._log_cache_error("read", exc)
            return None

    async def _get_or_start_scan(
        self,
        info: dict[str, Any],
        auth: dict[str, str],
        cache_scope: dict[str, Any],
    ) -> dict[str, Any]:
        inflight_key = "|".join([
            trim_string(cache_scope.get("viewer_user_id")),
            trim_string(cache_scope.get("auth_key_fingerprint")),
            trim_string(cache_scope.get("notice_key")),
            str(cache_scope.get("start_date_key") or 0),
            str(cache_scope.get("end_date_key") or 0),
        ])
        async with self._inflight_scans_lock:
            task = self._inflight_scans.get(inflight_key)
            if task is None:
                task = asyncio.create_task(self._scan_and_cache(info, auth, cache_scope))
                self._inflight_scans[inflight_key] = task
                task.add_done_callback(
                    lambda completed_task: self._clear_inflight_scan(inflight_key, completed_task)
                )
        return await asyncio.shield(task)

    def _clear_inflight_scan(self, inflight_key: str, completed_task: asyncio.Task[dict[str, Any]]) -> None:
        if self._inflight_scans.get(inflight_key) is completed_task:
            self._inflight_scans.pop(inflight_key, None)

    async def _scan_and_cache(
        self,
        info: dict[str, Any],
        auth: dict[str, str],
        cache_scope: dict[str, Any],
    ) -> dict[str, Any]:
        scan_result = await self.scan_subaccounts_within_window(info, auth)
        if scan_result.get("paused") or self.cache_repository is None:
            return scan_result
        try:
            await self.cache_repository.save_completed_scan(cache_scope, scan_result)
        except Exception as exc:
            self._log_cache_error("write", exc)
        return scan_result

    def _log_cache_error(self, operation: str, exc: Exception) -> None:
        if self.logger is None:
            return
        try:
            self.logger.warning("[NoticeGuidance] persistent cache %s failed: %s", operation, str(exc)[:500])
        except Exception:
            pass

    async def scan_subaccounts_within_window(self, info: dict[str, Any], auth: dict[str, str]) -> dict[str, Any]:
        page = 1
        matched_rows: list[dict[str, Any]] = []
        seen_accounts: set[str] = set()
        pages_scanned = 0
        stop_reason = "empty"
        async with self.provider.build_client() as client:
            while True:
                pause_info = self.pause_coordinator.get_pause_info(auth)
                if pause_info["remaining_seconds"] > 0:
                    return {
                        "paused": True,
                        "accounts": [trim_string(item.get("account")) for item in matched_rows if trim_string(item.get("account"))],
                        "rows": matched_rows,
                        "pages_scanned": pages_scanned,
                        "stop_reason": "paused_for_manual_my_subaccount",
                        "retry_after_seconds": pause_info["remaining_seconds"],
                        "pause_until_epoch_ms": pause_info["pause_until_epoch_ms"],
                    }
                result = await self.provider.fetch_subaccount_page(client, auth, page, self.page_size)
                pages_scanned += 1
                rows = result.get("rows") or []
                if not rows:
                    stop_reason = "first_page_empty" if page == 1 else "page_empty"
                    break
                newest_date_key = 0
                oldest_date_key = 0
                for row in rows:
                    account = trim_string(
                        row.get("MemberNo")
                        or row.get("member_no")
                        or row.get("memberNo")
                        or row.get("Account")
                        or row.get("account")
                    )
                    create_time = trim_string(
                        row.get("CreateTime")
                        or row.get("create_time")
                        or row.get("createTime")
                    )
                    date_key = parse_date_key(create_time)
                    if date_key > newest_date_key:
                        newest_date_key = date_key
                    if date_key and (not oldest_date_key or date_key < oldest_date_key):
                        oldest_date_key = date_key
                    if not account or not date_key:
                        continue
                    if info["start_date_key"] <= date_key <= info["end_date_key"] and account not in seen_accounts:
                        seen_accounts.add(account)
                        matched_rows.append(
                            {
                                "account": account,
                                "createTime": create_time,
                                "raw": row,
                            }
                        )
                if page == 1 and newest_date_key and newest_date_key < info["start_date_key"]:
                    stop_reason = "first_page_before_start"
                    break
                if oldest_date_key and oldest_date_key < info["start_date_key"]:
                    stop_reason = "reached_before_start"
                    break
                if len(rows) < self.page_size:
                    stop_reason = "page_not_full"
                    break
                page += 1
                if self.page_interval_seconds > 0:
                    await asyncio.sleep(self.page_interval_seconds)
        matched_rows.sort(
            key=lambda item: (
                -parse_date_key(item.get("createTime")),
                trim_string(item.get("account")).lower(),
            )
        )
        accounts = [trim_string(item.get("account")) for item in matched_rows if trim_string(item.get("account"))]
        return {
            "paused": False,
            "accounts": accounts,
            "rows": matched_rows,
            "pages_scanned": pages_scanned,
            "stop_reason": stop_reason,
        }

    @staticmethod
    def _normalize_auth(auth_payload: dict[str, Any]) -> dict[str, str]:
        return {
            "account": trim_string(auth_payload.get("account")).lower(),
            "key": trim_string(auth_payload.get("key")),
            "user_id": trim_string(
                auth_payload.get("userId")
                or auth_payload.get("user_id")
                or auth_payload.get("UserID")
            ),
        }
