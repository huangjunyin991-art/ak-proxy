from __future__ import annotations

from typing import Awaitable, Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .security import normalize_username, verify_signature
from .service import NotifyCenterService


VerifyAdminTokenCallable = Callable[[str], Awaitable[bool]]


def create_notify_center_router(
    *,
    service: NotifyCenterService,
    verify_admin_token: VerifyAdminTokenCallable | None = None,
) -> APIRouter:
    router = APIRouter()

    @router.get('/api/notify-center/status')
    async def status():
        return {'success': True, 'data': await service.build_status()}

    @router.get('/api/notify-center/web-push/vapid-public-key')
    async def vapid_public_key():
        return {'success': True, 'data': await service.get_vapid_public_key()}

    @router.post('/api/notify-center/web-push/subscriptions')
    async def upsert_web_push_subscription(request: Request):
        try:
            payload = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'success': False, 'message': '请求体无效'})
        username = _resolve_username(request, service.config.cookie_name, payload)
        if not username:
            return JSONResponse(status_code=401, content={'success': False, 'message': '未识别当前用户'})
        subscription = payload.get('subscription') if isinstance(payload, dict) and isinstance(payload.get('subscription'), dict) else {}
        platform = str(payload.get('platform') or '') if isinstance(payload, dict) else ''
        try:
            data = await service.upsert_web_push_subscription(
                username=username,
                subscription=subscription,
                user_agent=request.headers.get('User-Agent', ''),
                platform=platform,
            )
        except ValueError as exc:
            return JSONResponse(status_code=400, content={'success': False, 'message': str(exc)})
        except Exception as exc:
            return JSONResponse(status_code=500, content={'success': False, 'message': f'保存 Push 订阅失败: {exc}'})
        return {'success': True, 'data': data}

    @router.get('/api/notify-center/web-push/diagnostics')
    async def web_push_diagnostics(request: Request):
        username = _resolve_username(request, service.config.cookie_name)
        if not username:
            return JSONResponse(status_code=401, content={'success': False, 'message': '未识别当前用户'})
        try:
            data = await service.get_user_web_push_diagnostics(username)
        except ValueError as exc:
            return JSONResponse(status_code=400, content={'success': False, 'message': str(exc)})
        return {'success': True, 'data': data}

    @router.delete('/api/notify-center/web-push/subscriptions')
    async def delete_web_push_subscription(request: Request):
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        username = _resolve_username(request, service.config.cookie_name, payload)
        if not username:
            return JSONResponse(status_code=401, content={'success': False, 'message': '未识别当前用户'})
        endpoint = str(payload.get('endpoint') or '').strip() if isinstance(payload, dict) else ''
        if not endpoint:
            return JSONResponse(status_code=400, content={'success': False, 'message': '缺少 endpoint'})
        try:
            data = await service.disable_web_push_subscription(username=username, endpoint=endpoint)
        except ValueError as exc:
            return JSONResponse(status_code=400, content={'success': False, 'message': str(exc)})
        return {'success': True, 'data': data}

    @router.post('/internal/notify-center/im-message')
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

    @router.post('/admin/api/notify-center/outbox/flush')
    async def flush_outbox(request: Request):
        if verify_admin_token is not None:
            token = request.headers.get('Authorization', '').replace('Bearer ', '')
            if not token or not await verify_admin_token(token):
                return JSONResponse(status_code=401, content={'success': False, 'message': '未授权'})
        result = await service.flush_outbox_once()
        return {'success': True, 'data': result}

    return router


def _resolve_username(request: Request, cookie_name: str, payload: dict | None = None) -> str:
    payload_username = payload.get('im_username') if isinstance(payload, dict) else ''
    return (
        normalize_username(payload_username)
        or normalize_username(request.query_params.get('im_username'))
        or normalize_username(request.headers.get('X-AK-IM-Username'))
        or normalize_username(request.cookies.get('ak_im_username'))
        or normalize_username(request.cookies.get(cookie_name or 'ak_username'))
    )
