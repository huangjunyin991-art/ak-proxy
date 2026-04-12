from __future__ import annotations

import base64
import json
import re
from datetime import datetime
from html import unescape
from typing import Any
from urllib.parse import urlparse
from urllib.request import Request, urlopen


_NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)
_HTML_TAG_RE = re.compile(r'<[^>]+>')
_WHITESPACE_RE = re.compile(r'\s+')
_MEETING_CODE_RE = re.compile(r'[\s-]+')
_BASE64_TEXT_RE = re.compile(r'^[A-Za-z0-9+/=_-]+$')
_SHARE_URL_RE = re.compile(r'https?://(?:meeting\.tencent\.com/(?:dm|dw|dp|s)/[^\s<>"\'\u3002\uff0c\uff1b\uff09\u3001]+|wemeet\.qq\.com/w/[^\s<>"\'\u3002\uff0c\uff1b\uff09\u3001]+)', re.I)
_SUPPORTED_HOSTS = ('meeting.tencent.com', 'wemeet.qq.com')


class TencentMeetingShareLinkResolverError(ValueError):
    pass


class TencentMeetingShareLinkResolver:
    def __init__(self, *, timeout_seconds: float = 8.0, user_agent: str | None = None) -> None:
        self.timeout_seconds = timeout_seconds
        self.user_agent = user_agent or 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36'

    def resolve(self, url: str) -> dict[str, str]:
        normalized_url = _normalize_http_url(url)
        if not normalized_url:
            raise TencentMeetingShareLinkResolverError('请输入有效的腾讯会议分享链接')
        parsed = urlparse(normalized_url)
        host = str(parsed.hostname or '').strip().lower()
        if not any(host == supported or host.endswith(f'.{supported}') for supported in _SUPPORTED_HOSTS):
            raise TencentMeetingShareLinkResolverError('暂不支持该分享链接域名')
        final_url, html_text = self._fetch_html(normalized_url)
        next_data = _extract_next_data(html_text)
        page_props = next_data.get('props', {}).get('pageProps', {}) if isinstance(next_data, dict) else {}
        meeting_info = page_props.get('meetingInfo') if isinstance(page_props.get('meetingInfo'), dict) else {}
        meeting_title = _normalize_text(
            _extract_text_by_id(html_text, 'tm-meeting-subject')
            or _decode_base64_text(meeting_info.get('subject')),
            120,
        )
        meeting_code = _normalize_meeting_code(
            _extract_text_by_id(html_text, 'tm-meeting-code')
            or meeting_info.get('meeting_code')
        )
        start_timestamp = _normalize_timestamp(meeting_info.get('begin_time'))
        end_timestamp = _normalize_timestamp(meeting_info.get('end_time'))
        start_time = _normalize_text(
            _compose_date_time(
                _extract_text_by_id(html_text, 'tm-meeting-start-date'),
                _extract_text_by_id(html_text, 'tm-meeting-start-time'),
            ) or _format_timestamp(start_timestamp),
            64,
        )
        end_time = _normalize_text(
            _compose_date_time(
                _extract_text_by_id(html_text, 'tm-meeting-end-date'),
                _extract_text_by_id(html_text, 'tm-meeting-end-time'),
            ) or _format_timestamp(end_timestamp),
            64,
        )
        duration_text = _normalize_text(
            _extract_text_by_id(html_text, 'tm-meeting-duration') or _format_duration(start_timestamp, end_timestamp),
            64,
        )
        time_zone = _normalize_text(
            _extract_text_by_id(html_text, 'tm-meeting-timezone')
            or _decode_base64_text(meeting_info.get('time_zone')),
            120,
        )
        creator_name = _normalize_text(_decode_base64_text(meeting_info.get('creator_nickname')), 120)
        decoded_share_url = _normalize_http_url(_decode_base64_text(meeting_info.get('url')))
        source_url = _normalize_http_url(final_url) or normalized_url
        web_fallback_url = decoded_share_url or source_url
        if not meeting_title and not meeting_code:
            raise TencentMeetingShareLinkResolverError('分享链接未解析出会议信息')
        return {
            'meeting_title': meeting_title,
            'creator_name': creator_name,
            'meeting_code': meeting_code,
            'start_time': start_time,
            'end_time': end_time,
            'duration_text': duration_text,
            'time_zone': time_zone,
            'web_fallback_url': web_fallback_url,
            'source_url': source_url,
            'start_timestamp': str(start_timestamp) if start_timestamp else '',
            'end_timestamp': str(end_timestamp) if end_timestamp else '',
        }

    def _fetch_html(self, url: str) -> tuple[str, str]:
        request = Request(
            url,
            headers={
                'User-Agent': self.user_agent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                final_url = str(response.geturl() or url)
                charset = response.headers.get_content_charset() or 'utf-8'
                body = response.read()
        except Exception as exc:
            raise TencentMeetingShareLinkResolverError(f'分享链接抓取失败: {exc}') from exc
        try:
            html_text = body.decode(charset, errors='replace')
        except Exception:
            html_text = body.decode('utf-8', errors='replace')
        return final_url, html_text


def extract_tencent_meeting_share_url(value: Any) -> str:
    text = str(value or '').strip()
    if not text:
        return ''
    match = _SHARE_URL_RE.search(text)
    if not match:
        return ''
    return _normalize_http_url(match.group(0))


def build_tencent_meeting_content(meeting: dict[str, Any], *, share_url: str = '') -> str:
    if not isinstance(meeting, dict):
        return ''
    lines: list[str] = []
    meeting_title = _normalize_text(meeting.get('meeting_title'), 120)
    creator_name = _normalize_text(meeting.get('creator_name'), 120)
    start_time = _normalize_text(meeting.get('start_time'), 64)
    end_time = _normalize_text(meeting.get('end_time'), 64)
    duration_text = _normalize_text(meeting.get('duration_text'), 64)
    meeting_code = _normalize_meeting_code(meeting.get('meeting_code'))
    resolved_share_url = _normalize_http_url(share_url or meeting.get('source_url') or meeting.get('web_fallback_url'))
    if meeting_title:
        lines.append(f'会议标题：{meeting_title}')
    if creator_name:
        lines.append(f'发起人：{creator_name}')
    if start_time:
        lines.append(f'开始时间：{start_time}')
    if end_time:
        lines.append(f'结束时间：{end_time}')
    if duration_text:
        lines.append(f'会议时长：{duration_text}')
    if meeting_code:
        lines.append(f'会议号：{meeting_code}')
    if resolved_share_url:
        lines.append(f'会议链接：{resolved_share_url}')
    return '\n'.join(lines)


def _extract_next_data(html_text: str) -> dict[str, Any]:
    if not html_text:
        return {}
    match = _NEXT_DATA_RE.search(html_text)
    if not match:
        return {}
    raw_json = str(match.group(1) or '').strip()
    if not raw_json:
        return {}
    try:
        data = json.loads(unescape(raw_json))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _extract_text_by_id(html_text: str, element_id: str) -> str:
    if not html_text or not element_id:
        return ''
    pattern = re.compile(rf'<[^>]+id=["\']{re.escape(element_id)}["\'][^>]*>(.*?)</[^>]+>', re.S)
    match = pattern.search(html_text)
    if not match:
        return ''
    return _cleanup_html_text(match.group(1))


def _cleanup_html_text(value: Any) -> str:
    text = _HTML_TAG_RE.sub(' ', str(value or ''))
    text = unescape(text)
    text = _WHITESPACE_RE.sub(' ', text).strip()
    return text


def _normalize_http_url(value: Any) -> str:
    text = str(value or '').strip()
    if not text:
        return ''
    parsed = urlparse(text)
    if parsed.scheme not in {'http', 'https'}:
        return ''
    return text


def _normalize_text(value: Any, max_length: int) -> str:
    text = _cleanup_html_text(value)
    if not text:
        return ''
    return text[:max_length]


def _normalize_meeting_code(value: Any) -> str:
    text = _normalize_text(value, 64)
    if not text:
        return ''
    return _MEETING_CODE_RE.sub('', text)[:64]


def _decode_base64_text(value: Any) -> str:
    text = str(value or '').strip()
    if not text or not _BASE64_TEXT_RE.fullmatch(text):
        return text
    padded = text + ('=' * (-len(text) % 4))
    try:
        decoded = base64.b64decode(padded).decode('utf-8')
    except Exception:
        return text
    if any(ord(char) < 32 and char not in '\t\r\n' for char in decoded):
        return text
    return decoded.strip() or text


def _normalize_timestamp(value: Any) -> int:
    text = str(value or '').strip()
    if not text:
        return 0
    try:
        return int(float(text))
    except Exception:
        return 0


def _compose_date_time(date_text: Any, time_text: Any) -> str:
    normalized_date = _normalize_text(date_text, 64)
    normalized_time = _normalize_text(time_text, 32)
    if normalized_date and normalized_time:
        return f'{normalized_date} {normalized_time}'
    return normalized_date or normalized_time


def _format_timestamp(timestamp: int) -> str:
    if not timestamp:
        return ''
    try:
        return datetime.fromtimestamp(timestamp).strftime('%Y-%m-%d %H:%M')
    except Exception:
        return ''


def _format_duration(start_timestamp: int, end_timestamp: int) -> str:
    if not start_timestamp or not end_timestamp or end_timestamp <= start_timestamp:
        return ''
    total_minutes = (end_timestamp - start_timestamp) // 60
    hours, minutes = divmod(int(total_minutes), 60)
    if hours and minutes:
        return f'{hours}小时{minutes}分钟'
    if hours:
        return f'{hours}小时'
    if minutes:
        return f'{minutes}分钟'
    return ''
