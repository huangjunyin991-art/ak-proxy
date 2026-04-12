from __future__ import annotations

import re
from typing import Any


_URL_WITH_SCHEME_RE = re.compile(r'^[a-zA-Z][a-zA-Z0-9+.-]*:')


class NotificationProviderError(ValueError):
    pass


class BaseNotificationProvider:
    notification_type = ''

    def normalize(self, title: str, content: str, raw_payload: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError()


class GeneralNotificationProvider(BaseNotificationProvider):
    notification_type = 'general'

    def normalize(self, title: str, content: str, raw_payload: dict[str, Any]) -> dict[str, Any]:
        normalized_title = _normalize_text(title, 120)
        normalized_content = _normalize_text(content, 4000)
        if not normalized_title and not normalized_content:
            raise NotificationProviderError('一般通知至少需要标题或内容')
        return {
            'notification_type': self.notification_type,
            'title': normalized_title,
            'content': normalized_content,
            'payload': {},
        }


class TencentMeetingNotificationProvider(BaseNotificationProvider):
    notification_type = 'meeting'

    def normalize(self, title: str, content: str, raw_payload: dict[str, Any]) -> dict[str, Any]:
        meeting = raw_payload.get('meeting') if isinstance(raw_payload.get('meeting'), dict) else {}
        meeting_title = _normalize_text(meeting.get('meeting_title') or title, 120)
        meeting_content = _normalize_text(content or meeting.get('content'), 4000)
        meeting_code = _normalize_text(meeting.get('meeting_code'), 64)
        meeting_password = _normalize_text(meeting.get('meeting_password'), 64)
        start_time = _normalize_text(meeting.get('start_time'), 64)
        web_fallback_url = _normalize_url(meeting.get('web_fallback_url') or meeting.get('web_url'))
        mobile_launch_url = _normalize_url(meeting.get('mobile_launch_url'))
        desktop_launch_url = _normalize_url(meeting.get('desktop_launch_url'))
        launch_targets = _normalize_launch_targets(meeting.get('launch_targets'))
        if mobile_launch_url:
            launch_targets.insert(0, {
                'platform': 'mobile',
                'url': mobile_launch_url,
                'method': 'location',
                'label': 'mobile_primary',
            })
        if desktop_launch_url:
            launch_targets.insert(0, {
                'platform': 'desktop',
                'url': desktop_launch_url,
                'method': 'location',
                'label': 'desktop_primary',
            })
        launch_targets = _dedupe_launch_targets(launch_targets)
        if not meeting_title and not meeting_content:
            raise NotificationProviderError('会议通知至少需要标题或内容')
        if not web_fallback_url and not launch_targets:
            raise NotificationProviderError('会议通知至少需要网页回退地址或任一拉起地址')
        return {
            'notification_type': self.notification_type,
            'title': meeting_title or '会议通知',
            'content': meeting_content,
            'payload': {
                'kind': 'meeting',
                'provider': 'tencent_meeting',
                'meeting_title': meeting_title or '会议通知',
                'meeting_code': meeting_code,
                'meeting_password': meeting_password,
                'start_time': start_time,
                'web_fallback_url': web_fallback_url,
                'launch_targets': launch_targets,
            },
        }


_PROVIDERS: dict[str, BaseNotificationProvider] = {
    'general': GeneralNotificationProvider(),
    'meeting': TencentMeetingNotificationProvider(),
}


def normalize_notification_payload(notification_type: str, title: str, content: str, raw_payload: dict[str, Any] | None = None) -> dict[str, Any]:
    normalized_type = str(notification_type or '').strip().lower()
    provider = _PROVIDERS.get(normalized_type)
    if not provider:
        raise NotificationProviderError(f'不支持的通知类型: {notification_type}')
    return provider.normalize(title=title, content=content, raw_payload=raw_payload or {})


def get_notification_types() -> list[dict[str, str]]:
    return [
        {'key': 'general', 'label': '一般通知'},
        {'key': 'meeting', 'label': '会议通知'},
    ]


def _normalize_text(value: Any, max_length: int) -> str:
    text = str(value or '').strip()
    if not text:
        return ''
    text = re.sub(r'\s+', ' ', text)
    return text[:max_length]


def _normalize_url(value: Any) -> str:
    text = str(value or '').strip()
    if not text:
        return ''
    if _URL_WITH_SCHEME_RE.match(text):
        return text
    if text.startswith('//'):
        return f'https:{text}'
    return ''


def _normalize_launch_targets(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    normalized: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        url = _normalize_url(item.get('url'))
        if not url:
            continue
        platform = str(item.get('platform') or '').strip().lower()
        if platform not in {'mobile', 'desktop'}:
            continue
        method = str(item.get('method') or 'location').strip().lower()
        if method not in {'location', 'iframe', 'new_window'}:
            method = 'location'
        normalized.append({
            'platform': platform,
            'url': url,
            'method': method,
            'label': _normalize_text(item.get('label') or '', 64),
        })
    return normalized


def _dedupe_launch_targets(targets: list[dict[str, str]]) -> list[dict[str, str]]:
    deduped: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for item in targets:
        key = (str(item.get('platform') or ''), str(item.get('url') or ''), str(item.get('method') or 'location'))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped
