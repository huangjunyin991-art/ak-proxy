from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Mapping

from ..notice_guidance.service import NoticeGuidanceService, extract_lines_from_html, trim_string


_SALE_COUNT_RE = re.compile(r"第\s*(\d{1,5})\s*次\s*指导销售")
_AUTH_ERROR_MARKERS = ("key", "userkey", "token", "login", "登录", "失效", "无效", "认证")
_GUIDANCE_TIME_MARKERS = ("开曼群岛时间", "gmt-5", "gmt -5")


def _notice_list(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    data = payload.get("Data")
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if not isinstance(data, Mapping):
        return []
    for key in ("List", "list", "Rows", "rows", "Data"):
        value = data.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def _notice_sort_key(notice: Mapping[str, Any], position: int) -> tuple[datetime, int]:
    value = trim_string(
        notice.get("CreateTime") or notice.get("createTime") or notice.get("create_time")
    )
    normalized = value.replace("/", "-").replace("T", " ")
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(normalized[:19], fmt), -position
        except ValueError:
            continue
    return datetime.min, -position


def find_latest_guided_sale(payload: Mapping[str, Any]) -> dict[str, Any] | None:
    """Return the newest complete guided-sale announcement from Notice_List."""
    extractor = NoticeGuidanceService()
    candidates: list[tuple[tuple[datetime, int], dict[str, Any]]] = []
    for position, notice in enumerate(_notice_list(payload)):
        window = extractor.extract_guided_sale_window(notice)
        if window is None:
            continue
        title = trim_string(notice.get("Title") or notice.get("title"))
        text = str(notice.get("Text") or notice.get("text") or "")
        match = _SALE_COUNT_RE.search(f"{title}\n{text}")
        if match is None:
            continue
        item = dict(window)
        item["sale_count"] = int(match.group(1))
        item["created_at"] = trim_string(
            notice.get("CreateTime") or notice.get("createTime") or notice.get("create_time")
        )
        item["guidance_time"] = extract_guidance_time(notice)
        candidates.append((_notice_sort_key(notice, position), item))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def extract_guidance_time(notice: Mapping[str, Any]) -> str:
    """Return the announcement's guidance-time line without mixing it with the sale window."""
    html = str(notice.get("Text") or notice.get("text") or "")
    for line in extract_lines_from_html(html):
        text = trim_string(line)
        lowered = text.lower()
        if text and any(marker in lowered for marker in _GUIDANCE_TIME_MARKERS):
            return text
    return ""


def is_auth_error(exc: Exception) -> bool:
    text = str(exc or "").strip().lower()
    return bool(text) and any(marker in text for marker in _AUTH_ERROR_MARKERS)


def extract_auth_fields(login_payload: Mapping[str, Any], fallback_key: str = "") -> dict[str, str]:
    """Read the known AK login response variants without logging any secrets."""
    containers: list[Mapping[str, Any]] = [login_payload]
    for key in ("UserData", "userData", "Data", "data"):
        value = login_payload.get(key)
        if isinstance(value, Mapping):
            containers.append(value)
    user_id = ""
    key_value = trim_string(fallback_key)
    for item in containers:
        if not user_id:
            for name in ("UserID", "UserId", "userId", "user_id", "Id", "ID", "userid", "UID", "uid"):
                user_id = trim_string(item.get(name))
                if user_id:
                    break
        if not key_value:
            for name in ("UserKey", "userKey", "userkey", "Key", "key"):
                key_value = trim_string(item.get(name))
                if key_value:
                    break
    return {"user_id": user_id, "key": key_value}
