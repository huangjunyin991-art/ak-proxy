from __future__ import annotations

from typing import Any


def build_ntfy_payload(notification: dict[str, Any]) -> dict[str, str]:
    data = notification.get('data') if isinstance(notification.get('data'), dict) else {}
    event_type = str(data.get('event_type') or '').strip().lower()
    call_kind = str(data.get('call_kind') or '').strip().lower()
    url = str(notification.get('url') or '').strip()

    if event_type == 'im.call.invite':
        title = _normalize_text(notification.get('title'), 120) or '有人邀请你通话'
        body = _normalize_text(notification.get('body'), 800) or '点击接听或查看'
        return {
            'title': title,
            'message': body,
            'click_url': url,
            'priority': 'urgent',
            'tags': 'movie_camera' if call_kind == 'video' else 'telephone_receiver',
        }

    title = _normalize_text(notification.get('title'), 120) or '你有一条新消息'
    body = _normalize_text(notification.get('body'), 800)
    message = '打开 IM 查看' if not body or body == '点击查看' else body
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
