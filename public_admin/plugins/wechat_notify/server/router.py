from __future__ import annotations

from typing import Awaitable, Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .security import normalize_username, verify_signature
from .service import WechatNotifyService


VerifyAdminTokenCallable = Callable[[str], Awaitable[bool]]


def create_wechat_notify_router(
    *,
    service: WechatNotifyService,
    verify_admin_token: VerifyAdminTokenCallable | None = None,
) -> APIRouter:
    router = APIRouter()

    @router.get('/api/wechat-notify/status')
    async def status():
        return {'success': True, 'data': await service.build_status()}

    @router.post('/api/wechat-notify/wxpusher/bind/qrcode')
    async def create_wxpusher_bind_qrcode(request: Request):
        username = _resolve_username(request, service.config.cookie_name)
        if not username:
            return JSONResponse(status_code=401, content={'success': False, 'message': '未识别当前用户'})
        try:
            data = await service.create_bind_qrcode(username)
        except ValueError as exc:
            return JSONResponse(status_code=400, content={'success': False, 'message': str(exc)})
        except Exception as exc:
            return JSONResponse(status_code=500, content={'success': False, 'message': f'创建绑定二维码失败: {exc}'})
        return {'success': True, 'data': data}

    @router.post('/api/wechat-notify/wxpusher/callback')
    async def wxpusher_callback(request: Request):
        try:
            payload = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'success': False, 'message': '请求体无效'})
        result = await service.handle_wxpusher_callback(payload if isinstance(payload, dict) else {})
        status_code = 200 if result.get('accepted') else 400
        return JSONResponse(status_code=status_code, content={'success': bool(result.get('accepted')), 'data': result})

    @router.post('/internal/wechat-notify/im-message')
    async def im_message_event(request: Request):
        body = await request.body()
        if not verify_signature(
            service.config.internal_secret,
            request.headers.get('X-Notify-Timestamp', ''),
            request.headers.get('X-Notify-Nonce', ''),
            request.headers.get('X-Notify-Signature', ''),
            body,
        ):
            return JSONResponse(status_code=401, content={'success': False, 'message': '签名无效'})
        try:
            payload = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'success': False, 'message': '请求体无效'})
        result = await service.handle_im_message_event(payload if isinstance(payload, dict) else {})
        return {'success': True, 'data': result}

    @router.post('/admin/api/wechat-notify/outbox/flush')
    async def flush_outbox(request: Request):
        if verify_admin_token is not None:
            token = request.headers.get('Authorization', '').replace('Bearer ', '')
            if not token or not await verify_admin_token(token):
                return JSONResponse(status_code=401, content={'success': False, 'message': '未授权'})
        result = await service.flush_outbox_once()
        return {'success': True, 'data': result}

    return router


def _resolve_username(request: Request, cookie_name: str) -> str:
    return normalize_username(request.cookies.get(cookie_name or 'ak_username'))
