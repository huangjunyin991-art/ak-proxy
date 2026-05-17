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


def build_notification_content(event: dict[str, Any]) -> str:
    title = build_notification_title(event)
    sent_at = normalize_text(event.get('sent_at'), 40)
    sender_name = normalize_text(event.get('sender_display_name') or event.get('sender_username'), 40)
    message_type = normalize_message_type(event.get('message_type'))
    lines = [title]
    if sender_name:
        lines.append(f'发送人：{sender_name}')
    if message_type:
        lines.append(f'消息类型：{message_type}')
    if sent_at:
        lines.append(f'时间：{sent_at}')
    return '<br/>'.join(lines)


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


def normalize_message_type(value: Any) -> str:
    message_type = str(value or '').strip().lower()
    labels = {
        'text': '文本',
        'image': '图片',
        'voice': '语音',
        'file': '文件',
        'video': '视频',
        'location': '位置',
        'emoji_custom': '表情',
    }
    return labels.get(message_type, '消息')
