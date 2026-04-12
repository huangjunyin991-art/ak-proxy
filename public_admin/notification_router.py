from __future__ import annotations

from typing import Any, Awaitable, Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from notification_providers import NotificationProviderError, get_notification_types
from notification_service import NotificationService


VerifyAdminTokenCallable = Callable[[str], Awaitable[bool]]
GetAdminRoleCallable = Callable[[str], str | None]
GetAdminSubNameCallable = Callable[[str], str | None]


def create_notification_router(
    *,
    service: NotificationService,
    verify_admin_token: VerifyAdminTokenCallable,
    get_token_role: GetAdminRoleCallable,
    get_token_sub_name: GetAdminSubNameCallable,
) -> APIRouter:
    router = APIRouter()

    @router.get('/admin/api/notifications/types')
    async def notification_types(request: Request):
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        if not token or not await verify_admin_token(token):
            return JSONResponse(status_code=401, content={'error': True, 'message': '未授权'})
        return {'rows': get_notification_types()}

    @router.get('/admin/api/notifications/history')
    async def notification_history(request: Request, limit: int = 20, offset: int = 0):
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        if not token or not await verify_admin_token(token):
            return JSONResponse(status_code=401, content={'error': True, 'message': '未授权'})
        role = str(get_token_role(token) or '').strip()
        sub_name = str(get_token_sub_name(token) or '').strip()
        data = await service.list_campaigns(limit=max(1, min(limit, 100)), offset=max(0, offset), role=role, sub_name=sub_name)
        return data

    @router.post('/admin/api/notifications/send')
    async def notification_send(request: Request):
        token = request.headers.get('Authorization', '').replace('Bearer ', '')
        if not token or not await verify_admin_token(token):
            return JSONResponse(status_code=401, content={'error': True, 'message': '未授权'})
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'success': False, 'message': '请求体无效'})
        role = str(get_token_role(token) or '').strip()
        sub_name = str(get_token_sub_name(token) or '').strip()
        audience = data.get('audience') if isinstance(data.get('audience'), dict) else {}
        created_by = sub_name if role == 'sub_admin' and sub_name else 'super_admin'
        try:
            result = await service.publish_notification(
                notification_type=str(data.get('type') or data.get('notification_type') or '').strip().lower(),
                title=str(data.get('title') or '').strip(),
                content=str(data.get('content') or '').strip(),
                raw_payload=data,
                audience_mode=str(audience.get('mode') or data.get('audience_mode') or 'manual').strip().lower() or 'manual',
                audience_options=audience,
                created_by=created_by,
                role=role,
                sub_name=sub_name,
            )
        except NotificationProviderError as exc:
            return JSONResponse(status_code=400, content={'success': False, 'message': str(exc)})
        except Exception as exc:
            return JSONResponse(status_code=500, content={'success': False, 'message': f'通知发送失败: {exc}'})
        return {
            'success': True,
            'message': f"已发送给 {result.get('target_count', 0)} 个用户",
            'data': result,
        }

    return router
