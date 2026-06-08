from __future__ import annotations

import asyncio
from typing import Awaitable, Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .identity_resolver import NotifyIdentityResolver
from .security import normalize_username, verify_signature
from .service import NotifyCenterService


VerifyAdminTokenCallable = Callable[[str], Awaitable[bool]]
AdminRequestGuardCallable = Callable[[Request], Awaitable[JSONResponse | None]]
AdminUserGuardCallable = Callable[[Request, str], Awaitable[JSONResponse | None]]


def create_notify_center_router(
    *,
    service: NotifyCenterService,
    verify_admin_token: VerifyAdminTokenCallable | None = None,
    require_admin_request: AdminRequestGuardCallable | None = None,
    require_admin_user_scope: AdminUserGuardCallable | None = None,
) -> APIRouter:
    router = APIRouter()
    identity_resolver = NotifyIdentityResolver(service.config)

    async def _require_admin_request(request: Request) -> JSONResponse | None:
        if require_admin_request is not None:
            return await require_admin_request(request)
        if verify_admin_token is None:
            return JSONResponse(status_code=401, content={'success': False, 'message': '鏈巿鏉?'})
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        if not token or not await verify_admin_token(token):
            return JSONResponse(status_code=401, content={'success': False, 'message': '鏈巿鏉?'})
        return None

    async def _require_admin_user_scope(request: Request, username: str) -> JSONResponse | None:
        if require_admin_user_scope is not None:
            return await require_admin_user_scope(request, username)
        return await _require_admin_request(request)

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
        username = _resolve_current_username(request, identity_resolver)
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
        username = _resolve_current_username(request, identity_resolver)
        if not username:
            return JSONResponse(status_code=401, content={'success': False, 'message': '未识别当前用户'})
        try:
            data = await service.get_user_web_push_diagnostics(username)
        except ValueError as exc:
            return JSONResponse(status_code=400, content={'success': False, 'message': str(exc)})
        return {'success': True, 'data': data}

    @router.get('/api/notify-center/ntfy/binding')
    async def get_ntfy_binding(request: Request):
        username = _resolve_current_username(request, identity_resolver)
        if not username:
            return JSONResponse(status_code=401, content={'success': False, 'message': '未识别当前用户'})
        try:
            data = await service.get_ntfy_binding(username)
        except ValueError as exc:
            return JSONResponse(status_code=400, content={'success': False, 'message': str(exc)})
        return {'success': True, 'data': data}

    @router.post('/api/notify-center/ntfy/binding')
    async def upsert_ntfy_binding(request: Request):
        try:
            payload = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'success': False, 'message': '请求体无效'})
        username = _resolve_current_username(request, identity_resolver)
        if not username:
            return JSONResponse(status_code=401, content={'success': False, 'message': '未识别当前用户'})
        try:
            data = await service.upsert_ntfy_binding(
                username=username,
                server_url=str(payload.get('server_url') or '') if isinstance(payload, dict) else '',
                enabled=bool(payload.get('enabled', True)) if isinstance(payload, dict) else True,
            )
        except ValueError as exc:
            return JSONResponse(status_code=400, content={'success': False, 'message': str(exc)})
        except Exception as exc:
            return JSONResponse(status_code=500, content={'success': False, 'message': f'保存 ntfy 绑定失败: {exc}'})
        return {'success': True, 'data': data}

    @router.delete('/api/notify-center/ntfy/binding')
    async def delete_ntfy_binding(request: Request):
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        username = _resolve_current_username(request, identity_resolver)
        if not username:
            return JSONResponse(status_code=401, content={'success': False, 'message': '未识别当前用户'})
        try:
            data = await service.delete_ntfy_binding(username=username)
        except ValueError as exc:
            return JSONResponse(status_code=400, content={'success': False, 'message': str(exc)})
        return {'success': True, 'data': data}

    @router.post('/api/notify-center/ntfy/test')
    async def test_ntfy_binding(request: Request):
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        username = _resolve_current_username(request, identity_resolver)
        if not username:
            return JSONResponse(status_code=401, content={'success': False, 'message': '未识别当前用户'})
        try:
            data = await service.test_ntfy_binding(username=username)
        except ValueError as exc:
            return JSONResponse(status_code=400, content={'success': False, 'message': str(exc)})
        except Exception as exc:
            return JSONResponse(status_code=500, content={'success': False, 'message': f'测试 ntfy 失败: {exc}'})
        return {'success': True, 'data': data}

    @router.get('/admin/api/notify-center/ntfy/binding')
    async def admin_get_ntfy_binding(request: Request):
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        if verify_admin_token is None or not token or not await verify_admin_token(token):
            return JSONResponse(status_code=401, content={'success': False, 'message': '未授权'})
        username = normalize_username(request.query_params.get('im_username'))
        if not username:
            return JSONResponse(status_code=400, content={'success': False, 'message': '缺少 im_username'})
        auth_error = await _require_admin_user_scope(request, username)
        if auth_error is not None:
            return auth_error
        try:
            data = await service.get_ntfy_binding(username)
        except ValueError as exc:
            return JSONResponse(status_code=400, content={'success': False, 'message': str(exc)})
        return {'success': True, 'data': data}

    @router.post('/admin/api/notify-center/ntfy/binding')
    async def admin_upsert_ntfy_binding(request: Request):
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        if verify_admin_token is None or not token or not await verify_admin_token(token):
            return JSONResponse(status_code=401, content={'success': False, 'message': '未授权'})
        try:
            payload = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'success': False, 'message': '请求体无效'})
        username = normalize_username(payload.get('im_username') if isinstance(payload, dict) else '')
        if not username:
            return JSONResponse(status_code=400, content={'success': False, 'message': '缺少 im_username'})
        auth_error = await _require_admin_user_scope(request, username)
        if auth_error is not None:
            return auth_error
        try:
            data = await service.upsert_ntfy_binding(
                username=username,
                server_url=str(payload.get('server_url') or '') if isinstance(payload, dict) else '',
                enabled=bool(payload.get('enabled', True)) if isinstance(payload, dict) else True,
            )
        except ValueError as exc:
            return JSONResponse(status_code=400, content={'success': False, 'message': str(exc)})
        except Exception as exc:
            return JSONResponse(status_code=500, content={'success': False, 'message': f'保存 ntfy 绑定失败: {exc}'})
        return {'success': True, 'data': data}

    @router.delete('/admin/api/notify-center/ntfy/binding')
    async def admin_delete_ntfy_binding(request: Request):
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        if verify_admin_token is None or not token or not await verify_admin_token(token):
            return JSONResponse(status_code=401, content={'success': False, 'message': '未授权'})
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        username = normalize_username(payload.get('im_username') if isinstance(payload, dict) else '')
        if not username:
            return JSONResponse(status_code=400, content={'success': False, 'message': '缺少 im_username'})
        auth_error = await _require_admin_user_scope(request, username)
        if auth_error is not None:
            return auth_error
        try:
            data = await service.delete_ntfy_binding(username=username)
        except ValueError as exc:
            return JSONResponse(status_code=400, content={'success': False, 'message': str(exc)})
        return {'success': True, 'data': data}

    @router.post('/admin/api/notify-center/ntfy/test')
    async def admin_test_ntfy_binding(request: Request):
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        if verify_admin_token is None or not token or not await verify_admin_token(token):
            return JSONResponse(status_code=401, content={'success': False, 'message': '未授权'})
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        username = normalize_username(payload.get('im_username') if isinstance(payload, dict) else '')
        if not username:
            return JSONResponse(status_code=400, content={'success': False, 'message': '缺少 im_username'})
        auth_error = await _require_admin_user_scope(request, username)
        if auth_error is not None:
            return auth_error
        try:
            data = await service.test_ntfy_binding(username=username)
        except ValueError as exc:
            return JSONResponse(status_code=400, content={'success': False, 'message': str(exc)})
        except Exception as exc:
            return JSONResponse(status_code=500, content={'success': False, 'message': f'测试 ntfy 失败: {exc}'})
        return {'success': True, 'data': data}

    @router.delete('/api/notify-center/web-push/subscriptions')
    async def delete_web_push_subscription(request: Request):
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        username = _resolve_current_username(request, identity_resolver)
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
        if int(result.get('queued') or 0) > 0:
            _schedule_outbox_flush(service)
        return {'success': True, 'data': result}

    @router.post('/admin/api/notify-center/outbox/flush')
    async def flush_outbox(request: Request):
        auth_error = await _require_admin_request(request)
        if auth_error is not None:
            return auth_error
        if verify_admin_token is not None:
            token = request.headers.get('Authorization', '').replace('Bearer ', '')
            if not token or not await verify_admin_token(token):
                return JSONResponse(status_code=401, content={'success': False, 'message': '未授权'})
        result = await service.flush_outbox_once()
        return {'success': True, 'data': result}

    return router


def _schedule_outbox_flush(service: NotifyCenterService) -> None:
    task = asyncio.create_task(service.flush_outbox_once())
    task.add_done_callback(_consume_task_exception)


def _consume_task_exception(task: asyncio.Task) -> None:
    try:
        task.result()
    except Exception:
        pass


def _resolve_current_username(request: Request, identity_resolver: NotifyIdentityResolver) -> str:
    return identity_resolver.resolve(request).username
