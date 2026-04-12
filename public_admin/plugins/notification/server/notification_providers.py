from __future__ import annotations

import re
from typing import Any

from .tencent_meeting_resolver import TencentMeetingShareLinkResolver
from .tencent_meeting_resolver import TencentMeetingShareLinkResolverError


_URL_WITH_SCHEME_RE = re.compile(r'^[a-zA-Z][a-zA-Z0-9+.-]*:')
_MEETING_CODE_COMPACT_RE = re.compile(r'[\s-]+')
_SHARE_LINK_RESOLVER = TencentMeetingShareLinkResolver()


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
        resolve_mode = _normalize_text(meeting.get('resolve_mode'), 16)
        if resolve_mode == 'raw':
            raw_title = _normalize_text(title, 120)
            raw_content = _normalize_text(content or meeting.get('content'), 4000)
            if not raw_title and not raw_content:
                raise NotificationProviderError('会议通知至少需要标题或内容')
            return {
                'notification_type': self.notification_type,
                'title': raw_title or '会议通知',
                'content': raw_content,
                'payload': {
                    'kind': 'meeting',
                    'provider': 'tencent_meeting',
                    'meeting_title': raw_title,
                    'creator_name': '',
                    'meeting_code': '',
                    'meeting_password': '',
                    'start_time': '',
                    'end_time': '',
                    'duration_text': '',
                    'time_zone': '',
                    'start_timestamp': '',
                    'end_timestamp': '',
                    'web_fallback_url': '',
                    'launch_targets': [],
                    'source_url': '',
                    'resolution_source': 'raw',
                },
            }
        share_url = _normalize_url(
            meeting.get('share_url')
            or meeting.get('meeting_share_url')
            or meeting.get('invite_url')
            or meeting.get('source_url')
        )
        resolved_meeting: dict[str, str] = {}
        if share_url:
            try:
                resolved_meeting = _SHARE_LINK_RESOLVER.resolve(share_url)
            except TencentMeetingShareLinkResolverError as exc:
                if not _has_manual_meeting_payload(title=title, content=content, meeting=meeting):
                    raise NotificationProviderError(str(exc)) from exc
        meeting_title = _normalize_text(meeting.get('meeting_title') or title, 120) or _normalize_text(resolved_meeting.get('meeting_title'), 120)
        meeting_content = _normalize_text(content or meeting.get('content'), 4000)
        meeting_code = _normalize_meeting_code(meeting.get('meeting_code') or resolved_meeting.get('meeting_code'))
        meeting_password = _normalize_text(meeting.get('meeting_password'), 64)
        start_time = _normalize_text(meeting.get('start_time'), 64) or _normalize_text(resolved_meeting.get('start_time'), 64)
        end_time = _normalize_text(meeting.get('end_time'), 64) or _normalize_text(resolved_meeting.get('end_time'), 64)
        duration_text = _normalize_text(meeting.get('duration_text'), 64) or _normalize_text(resolved_meeting.get('duration_text'), 64)
        time_zone = _normalize_text(meeting.get('time_zone'), 120) or _normalize_text(resolved_meeting.get('time_zone'), 120)
        creator_name = _normalize_text(meeting.get('creator_name'), 120) or _normalize_text(resolved_meeting.get('creator_name'), 120)
        start_timestamp = _normalize_text(meeting.get('start_timestamp'), 32) or _normalize_text(resolved_meeting.get('start_timestamp'), 32)
        end_timestamp = _normalize_text(meeting.get('end_timestamp'), 32) or _normalize_text(resolved_meeting.get('end_timestamp'), 32)
        source_url = _normalize_url(meeting.get('source_url') or resolved_meeting.get('source_url') or share_url)
        resolution_source = _normalize_text(meeting.get('resolution_source') or '', 32) or ('share_link' if resolved_meeting else 'manual')
        web_fallback_url = _normalize_url(
            meeting.get('web_fallback_url')
            or meeting.get('web_url')
            or resolved_meeting.get('web_fallback_url')
            or source_url
        )
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
        if not launch_targets and meeting_code:
            launch_targets = _build_tencent_meeting_launch_targets(meeting_code)
        launch_targets = _dedupe_launch_targets(launch_targets)
        if not meeting_content:
            meeting_content = _build_meeting_summary(
                creator_name=creator_name,
                start_time=start_time,
                duration_text=duration_text,
            )
        if not meeting_title and not meeting_content:
            raise NotificationProviderError('会议通知至少需要分享链接、标题或内容')
        if not web_fallback_url and not launch_targets:
            raise NotificationProviderError('会议通知至少需要分享链接、网页回退地址或任一拉起地址')
        return {
            'notification_type': self.notification_type,
            'title': meeting_title or '会议通知',
            'content': meeting_content,
            'payload': {
                'kind': 'meeting',
                'provider': 'tencent_meeting',
                'meeting_title': meeting_title or '会议通知',
                'creator_name': creator_name,
                'meeting_code': meeting_code,
                'meeting_password': meeting_password,
                'start_time': start_time,
                'end_time': end_time,
                'duration_text': duration_text,
                'time_zone': time_zone,
                'start_timestamp': start_timestamp,
                'end_timestamp': end_timestamp,
                'web_fallback_url': web_fallback_url,
                'launch_targets': launch_targets,
                'source_url': source_url,
                'resolution_source': resolution_source,
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


def _normalize_meeting_code(value: Any) -> str:
    text = _normalize_text(value, 64)
    if not text:
        return ''
    return _MEETING_CODE_COMPACT_RE.sub('', text)[:64]


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


def _build_tencent_meeting_launch_targets(meeting_code: str) -> list[dict[str, str]]:
    normalized_code = _normalize_meeting_code(meeting_code)
    if not normalized_code:
        return []
    deep_link = f'wemeet://page/inmeeting?meeting_code={normalized_code}'
    return [
        {
            'platform': 'desktop',
            'url': deep_link,
            'method': 'location',
            'label': 'desktop_auto',
        },
        {
            'platform': 'mobile',
            'url': deep_link,
            'method': 'location',
            'label': 'mobile_auto',
        },
    ]


def _build_meeting_summary(*, creator_name: str, start_time: str, duration_text: str) -> str:
    parts: list[str] = []
    if creator_name:
        parts.append(f'发起人：{creator_name}')
    if start_time:
        parts.append(f'开始：{start_time}')
    if duration_text:
        parts.append(f'时长：{duration_text}')
    return _normalize_text(' · '.join(parts), 4000)


def _has_manual_meeting_payload(*, title: str, content: str, meeting: dict[str, Any]) -> bool:
    return any([
        _normalize_text(meeting.get('meeting_title') or title, 120),
        _normalize_text(content or meeting.get('content'), 4000),
        _normalize_meeting_code(meeting.get('meeting_code')),
        _normalize_url(meeting.get('web_fallback_url') or meeting.get('web_url')),
        _normalize_url(meeting.get('desktop_launch_url')),
        _normalize_url(meeting.get('mobile_launch_url')),
        bool(_normalize_launch_targets(meeting.get('launch_targets'))),
    ])
