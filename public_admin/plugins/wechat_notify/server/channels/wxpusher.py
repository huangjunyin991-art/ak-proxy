from __future__ import annotations

from typing import Any

import httpx

from ..config import WechatNotifyConfig
from .base import ChannelQrCodeResult, ChannelSendResult


class WxPusherChannel:
    def __init__(self, config: WechatNotifyConfig):
        self._config = config

    async def send(self, *, target_id: str, title: str, content: str, summary: str, url: str = '') -> ChannelSendResult:
        if not self._config.is_channel_ready():
            return ChannelSendResult(success=False, error='WxPusher 通道未启用或未配置 appToken')
        uid = str(target_id or '').strip()
        if not uid:
            return ChannelSendResult(success=False, error='WxPusher UID 为空')
        payload = {
            'appToken': self._config.wxpusher_app_token,
            'content': content or title or summary,
            'summary': (summary or title or '有新消息')[:100],
            'contentType': 2,
            'uids': [uid],
            'verifyPayType': 0,
        }
        if url:
            payload['url'] = url
        try:
            async with httpx.AsyncClient(timeout=self._config.wxpusher_request_timeout_seconds, trust_env=False) as client:
                response = await client.post(f'{self._config.wxpusher_api_base}/api/send/message', json=payload)
            data = response.json()
        except Exception as exc:
            return ChannelSendResult(success=False, error=str(exc))
        if int(data.get('code') or 0) != 1000 or data.get('success') is False:
            return ChannelSendResult(success=False, error=str(data.get('msg') or 'WxPusher 发送失败'), raw=data if isinstance(data, dict) else {})
        records = data.get('data') if isinstance(data.get('data'), list) else []
        first = records[0] if records and isinstance(records[0], dict) else {}
        success = int(first.get('code') or 1000) == 1000
        return ChannelSendResult(
            success=success,
            provider_message_id=str(first.get('messageContentId') or first.get('messageId') or ''),
            provider_record_id=str(first.get('sendRecordId') or ''),
            error='' if success else str(first.get('status') or 'WxPusher 发送任务创建失败'),
            raw=data,
        )

    async def create_bind_qrcode(self, *, extra: str, valid_seconds: int) -> ChannelQrCodeResult:
        if not self._config.is_channel_ready():
            return ChannelQrCodeResult(success=False, error='WxPusher 通道未启用或未配置 appToken')
        payload = {
            'appToken': self._config.wxpusher_app_token,
            'extra': str(extra or '').strip(),
            'validTime': int(valid_seconds or self._config.wxpusher_qrcode_expire_seconds),
        }
        try:
            async with httpx.AsyncClient(timeout=self._config.wxpusher_request_timeout_seconds, trust_env=False) as client:
                response = await client.post(f'{self._config.wxpusher_api_base}/api/fun/create/qrcode', json=payload)
            data: dict[str, Any] = response.json()
        except Exception as exc:
            return ChannelQrCodeResult(success=False, error=str(exc))
        if int(data.get('code') or 0) != 1000:
            return ChannelQrCodeResult(success=False, error=str(data.get('msg') or 'WxPusher 二维码创建失败'), raw=data if isinstance(data, dict) else {})
        body = data.get('data') if isinstance(data.get('data'), dict) else {}
        return ChannelQrCodeResult(
            success=True,
            code=str(body.get('code') or ''),
            url=str(body.get('url') or body.get('qrcodeUrl') or body.get('qrCodeUrl') or ''),
            short_url=str(body.get('shortUrl') or body.get('short_url') or ''),
            expires_in=int(body.get('expiresIn') or body.get('validTime') or payload['validTime'] or 0),
            raw=data,
        )
