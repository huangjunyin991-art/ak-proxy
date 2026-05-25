from __future__ import annotations

from typing import Any


def build_ntfy_payload(notification: dict[str, Any]) -> dict[str, str]:
    title = _normalize_text(notification.get('title'), 120) or '你有一条新消息'
    body = _normalize_text(notification.get('body'), 800)
    url = str(notification.get('url') or '').strip()
    message = body or '点击查看'
    return {
        'title': title,
        'message': message,
        'click_url': url,
        'priority': 'high',
        'tags': 'speech_balloon',
    }


def _normalize_text(value: Any, limit: int) -> str:
    text = ' '.join(str(value or '').strip().split())
    if limit > 0 and len(text) > limit:
        return text[:limit]
    return text
