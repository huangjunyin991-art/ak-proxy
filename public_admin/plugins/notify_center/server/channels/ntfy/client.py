from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import quote
from urllib.parse import urlencode
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from ..base import ChannelSendResult


class NtfyClient:
    def __init__(self, *, timeout_seconds: int = 8):
        self._timeout_seconds = max(1, int(timeout_seconds or 8))

    async def send(self, *, server_url: str, topic: str, title: str, message: str, click_url: str = '', priority: str = 'default', tags: str = '') -> ChannelSendResult:
        try:
            normalized_server_url = normalize_server_url(server_url)
            normalized_topic = normalize_topic(topic)
            payload = {
                'title': str(title or '').strip() or '你有一条新消息',
                'message': str(message or '').strip() or '点击查看',
                'click_url': str(click_url or '').strip(),
                'priority': str(priority or 'default').strip() or 'default',
                'tags': str(tags or '').strip(),
            }
            return await asyncio.wait_for(
                asyncio.to_thread(self._send_sync, normalized_server_url, normalized_topic, payload),
                timeout=self._timeout_seconds,
            )
        except Exception as exc:
            return ChannelSendResult(success=False, error=str(exc))

    def _send_sync(self, server_url: str, topic: str, payload: dict[str, str]) -> ChannelSendResult:
        query = {
            'title': payload.get('title') or '你有一条新消息',
            'priority': payload.get('priority') or 'default',
        }
        click_url = payload.get('click_url') or ''
        tags = payload.get('tags') or ''
        if click_url:
            query['click'] = click_url
        if tags:
            query['tags'] = tags
        url = f'{server_url}/{quote(topic, safe="")}?{urlencode(query)}'
        headers = {
            'Content-Type': 'text/plain; charset=utf-8',
            'Accept': 'application/json',
        }
        request = Request(
            url,
            data=(payload.get('message') or '点击查看').encode('utf-8'),
            headers=headers,
            method='POST',
        )
        with urlopen(request, timeout=self._timeout_seconds) as response:
            status_code = int(getattr(response, 'status', 0) or response.getcode() or 0)
            response_text = response.read().decode('utf-8', errors='replace')
        data = _load_json(response_text)
        success = 200 <= status_code < 300
        error = '' if success else str(data.get('error') or data.get('message') or f'ntfy HTTP {status_code}')
        return ChannelSendResult(
            success=success,
            provider_message_id=str(data.get('id') or ''),
            provider_record_id=str(data.get('time') or status_code),
            error=error,
            raw={'status_code': status_code, 'response': data},
        )


def normalize_server_url(value: str) -> str:
    text = str(value or '').strip().rstrip('/')
    if not text:
        return 'https://ntfy.ak2025.vip'
    parsed = urlparse(text)
    if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
        raise ValueError('ntfy 服务地址必须是 HTTP/HTTPS URL')
    return text


def normalize_topic(value: str) -> str:
    text = str(value or '').strip()
    if not text:
        raise ValueError('ntfy topic 为空')
    if len(text) > 120:
        raise ValueError('ntfy topic 过长')
    if not all(ch.isascii() and (ch.isalnum() or ch in {'-', '_'}) for ch in text):
        raise ValueError('ntfy topic 只能包含字母、数字、横线和下划线')
    return text


def _load_json(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value or '{}')
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}
