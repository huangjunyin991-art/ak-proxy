from __future__ import annotations

from typing import Any


def build_pushdeer_payload(notification: dict[str, Any]) -> dict[str, str]:
    title = _normalize_text(notification.get('title'), 120) or '你有一条新消息'
    body = _normalize_text(notification.get('body'), 500)
    url = str(notification.get('url') or '').strip()
    lines = []
    if body and body != '点击查看':
        lines.append(body)
    if url:
        lines.append(f'[点击查看]({url})')
    if not lines:
        lines.append('点击查看')
    return {
        'text': title,
        'desp': '\n\n'.join(lines),
        'type': 'markdown',
    }


def _normalize_text(value: Any, limit: int) -> str:
    text = ' '.join(str(value or '').strip().split())
    if limit > 0 and len(text) > limit:
        return text[:limit]
    return text
