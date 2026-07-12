from __future__ import annotations

import hashlib
from typing import Any, Mapping


def _trim(value: Any) -> str:
    return str(value or "").strip()


def build_guided_sale_cache_scope(
    info: Mapping[str, Any], auth: Mapping[str, Any]
) -> dict[str, Any]:
    """Build the stable scope shared by notice viewing and statistics jobs."""
    notice_id = _trim(info.get("notice_id"))
    if notice_id:
        notice_key = f"id:{notice_id}"
    else:
        fallback = "\x00".join([
            _trim(info.get("title")),
            _trim(info.get("target_line")),
            _trim(info.get("start_date_label")),
            _trim(info.get("end_date_label")),
        ])
        notice_key = "fallback:" + hashlib.sha256(fallback.encode("utf-8")).hexdigest()
    return {
        "viewer_user_id": _trim(auth.get("user_id")),
        "auth_key_fingerprint": hashlib.sha256(_trim(auth.get("key")).encode("utf-8")).hexdigest(),
        "notice_key": notice_key,
        "notice_id": notice_id,
        "start_date_key": int(info.get("start_date_key") or 0),
        "end_date_key": int(info.get("end_date_key") or 0),
    }
