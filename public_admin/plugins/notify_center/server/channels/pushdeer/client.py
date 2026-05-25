from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import urlparse
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from ..base import ChannelSendResult


class PushDeerClient:
    def __init__(self, *, timeout_seconds: int = 8):
        self._timeout_seconds = max(1, int(timeout_seconds or 8))

    async def send(self, *, server_url: str, pushkey: str, text: str, desp: str, message_type: str = 'markdown') -> ChannelSendResult:
        try:
            normalized_server_url = normalize_server_url(server_url)
            normalized_pushkey = str(pushkey or '').strip()
            if not normalized_pushkey:
                return ChannelSendResult(success=False, error='PushDeer pushkey 为空')
            payload = {
                'pushkey': normalized_pushkey,
                'text': str(text or '').strip() or '新消息',
                'desp': str(desp or '').strip(),
                'type': str(message_type or 'markdown').strip() or 'markdown',
            }
            return await asyncio.wait_for(
                asyncio.to_thread(self._send_sync, normalized_server_url, payload),
                timeout=self._timeout_seconds,
            )
        except Exception as exc:
            return ChannelSendResult(success=False, error=str(exc))

    def _send_sync(self, server_url: str, payload: dict[str, str]) -> ChannelSendResult:
        url = f'{server_url}/message/push'
        body = urlencode(payload).encode('utf-8')
        request = Request(
            url,
            data=body,
            headers={
                'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
                'Accept': 'application/json',
            },
            method='POST',
        )
        with urlopen(request, timeout=self._timeout_seconds) as response:
            status_code = int(getattr(response, 'status', 0) or response.getcode() or 0)
            response_text = response.read().decode('utf-8', errors='replace')
        data = _load_json(response_text)
        code = data.get('code')
        success = 200 <= status_code < 300 and (code in (0, '0', None) or str(code).lower() == 'success')
        error = ''
        if not success:
            error = str(data.get('error') or data.get('message') or data.get('msg') or f'PushDeer HTTP {status_code}')
        return ChannelSendResult(
            success=success,
            provider_message_id=str(data.get('id') or data.get('message_id') or ''),
            provider_record_id=str(code if code is not None else status_code),
            error=error,
            raw={'status_code': status_code, 'response': data},
        )


def normalize_server_url(value: str) -> str:
    text = str(value or '').strip().rstrip('/')
    if not text:
        return 'https://api2.pushdeer.com'
    parsed = urlparse(text)
    if parsed.scheme not in {'http', 'https'} or not parsed.netloc:
        raise ValueError('PushDeer 服务地址必须是 HTTP/HTTPS URL')
    return text


def _load_json(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(value or '{}')
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}
