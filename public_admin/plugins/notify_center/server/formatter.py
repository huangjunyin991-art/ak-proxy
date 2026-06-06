from __future__ import annotations

import hashlib
import hmac
import time
from typing import Any
from urllib.parse import quote_plus

from .security import normalize_text, normalize_username


def build_notification_title(event: dict[str, Any]) -> str:
    if _is_call_invite_event(event):
        sender_name = normalize_text(event.get('sender_display_name') or event.get('sender_username'), 40)
        return f'{sender_name or "有人"} 邀请你{_call_kind_label(event)}'

    conversation_type = str(event.get('conversation_type') or '').strip().lower()
    sender_name = normalize_text(event.get('sender_display_name') or event.get('sender_username'), 40)
    if conversation_type == 'group':
        title = normalize_text(event.get('conversation_title'), 60) or '群聊'
        return f'【群聊】{title} 有新消息'
    return f'{sender_name or "有人"} 向您发送了新消息'


def build_notification_body(event: dict[str, Any], *, show_preview: bool = False) -> str:
    if _is_call_invite_event(event):
        return '点击接听或查看'

    if show_preview:
        preview = normalize_text(event.get('message_preview') or event.get('content') or '', 80)
        if preview:
            return preview
    return '点击查看'


def _is_call_invite_event(event: dict[str, Any]) -> bool:
    event_type = str(event.get('event_type') or '').strip().lower()
    message_type = str(event.get('message_type') or '').strip().lower()
    return event_type == 'im.call.invite' or message_type == 'call_invite'


def _call_kind_label(event: dict[str, Any]) -> str:
    kind = str(event.get('call_kind') or '').strip().lower()
    return '视频通话' if kind == 'video' else '语音通话'


def _build_im_switch_token(secret: str, username: str, ts: int, nonce: str, conversation_id: int = 0) -> str:
    """短期一次性 token：HMAC_SHA256(ts\nnonce\nusername\nconversation_id)."""
    normalized_secret = str(secret or '').strip()
    if not normalized_secret:
        return ''
    payload = '\n'.join([
        str(int(ts)),
        str(nonce or ''),
        str(username or '').strip().lower(),
        str(int(conversation_id or 0)),
    ]).encode('utf-8')
    return hmac.new(normalized_secret.encode('utf-8'), payload, hashlib.sha256).hexdigest()


def build_notification_url(event: dict[str, Any], public_base_url: str = '', *, internal_secret: str = '') -> str:
    conversation_id = int(event.get('conversation_id') or 0)
    recipient = normalize_username(event.get('recipient_username') or event.get('im_username') or event.get('username'))
    path = '/pages/home.html?first=true&ak_im_open=1'
    if conversation_id > 0:
        path = f'/pages/home.html?first=true&ak_im_open=1&conversation_id={conversation_id}'
    if recipient:
        separator = '&' if '?' in path else '?'
        path = f'{path}{separator}im_username={recipient}'
    if _is_call_invite_event(event):
        path = _append_query_param(path, 'ak_im_call', 'invite')
        path = _append_query_param(path, 'call_id', event.get('call_id'))

    # 一次性 token，不依赖 cookie/bs，用于打开通知时切换 userkey。
    secret = str(internal_secret or '').strip()
    if secret and recipient:
        ts = int(time.time())
        nonce = str(event.get('nonce') or '') or str(int(time.time() * 1000))
        token = _build_im_switch_token(secret, recipient, ts, nonce, conversation_id)
        if token:
            path = f"{path}&im_switch_ts={ts}&im_switch_nonce={quote_plus(nonce)}&im_switch_sig={token}"

    base = str(public_base_url or '').strip().rstrip('/')
    return f'{base}{path}' if base else path


def _append_query_param(path: str, name: str, value: Any) -> str:
    normalized_value = str(value or '').strip()
    if not normalized_value:
        return path
    separator = '&' if '?' in path else '?'
    return f'{path}{separator}{quote_plus(str(name))}={quote_plus(normalized_value)}'


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
