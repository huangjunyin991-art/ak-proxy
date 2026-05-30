from __future__ import annotations

from typing import Any

from .security import normalize_text, normalize_username


def build_notification_title(event: dict[str, Any]) -> str:
    conversation_type = str(event.get('conversation_type') or '').strip().lower()
    sender_name = normalize_text(event.get('sender_display_name') or event.get('sender_username'), 40)
    if conversation_type == 'group':
        title = normalize_text(event.get('conversation_title'), 60) or '群聊'
        return f'【群聊】{title} 有新消息'
    return f'{sender_name or "有人"} 向您发送了新消息'


def build_notification_body(event: dict[str, Any], *, show_preview: bool = False) -> str:
    if show_preview:
        preview = normalize_text(event.get('message_preview') or event.get('content') or '', 80)
        if preview:
            return preview
    return '点击查看'


def build_notification_url(event: dict[str, Any], public_base_url: str = '') -> str:
    conversation_id = int(event.get('conversation_id') or 0)
    recipient = normalize_username(event.get('recipient_username') or event.get('im_username') or event.get('username'))
    path = '/pages/home.html?first=true&ak_im_open=1'
    if conversation_id > 0:
        path = f'/pages/home.html?first=true&ak_im_open=1&conversation_id={conversation_id}'
    if recipient:
        separator = '&' if '?' in path else '?'
        path = f'{path}{separator}im_username={recipient}'
    base = str(public_base_url or '').strip().rstrip('/')
    return f'{base}{path}' if base else path


def build_recipient_usernames(event: dict[str, Any]) -> list[str]:
    sender = normalize_username(event.get('sender_username'))
    recipients: list[str] = []
    seen: set[str] = set()
    for item in event.get('recipient_usernames') or []:
        username = normalize_username(item)
        if not username or username == sender or username in seen:
            continue
        seen.add(username)
        recipients.append(username)
    return recipients
