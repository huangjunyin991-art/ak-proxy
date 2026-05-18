from typing import Awaitable, Callable, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .service import LicenseCenterService


VerifyAdminTokenCallable = Callable[[str], Awaitable[bool]]
GetTokenValueCallable = Callable[[str], Optional[str]]
CheckPermissionCallable = Callable[[str, str], bool]


def create_license_center_router(
    *,
    service: LicenseCenterService,
    verify_admin_token: VerifyAdminTokenCallable,
    get_token_role: GetTokenValueCallable,
    get_token_sub_name: GetTokenValueCallable,
    check_token_permission: Optional[CheckPermissionCallable] = None,
) -> APIRouter:
    router = APIRouter()

    def extract_token(request: Request) -> str:
        auth = str(request.headers.get('Authorization') or '')
        if auth.lower().startswith('bearer '):
            return auth[7:].strip()
        return auth.strip()

    async def require_license_admin(request: Request):
        token = extract_token(request)
        if not token or not await verify_admin_token(token):
            return '', JSONResponse(status_code=401, content={'error': True, 'message': '未授权'})
        if check_token_permission is not None and not check_token_permission(token, 'license'):
            return '', JSONResponse(status_code=403, content={'error': True, 'message': '无激活码管理权限'})
        return token, None

    def operator_from_token(token: str) -> str:
        role = str(get_token_role(token) or '').strip()
        sub_name = str(get_token_sub_name(token) or '').strip()
        if role == 'sub_admin' and sub_name:
            return sub_name
        return role or 'admin'

    def client_ip(request: Request) -> str:
        forwarded = str(request.headers.get('X-Forwarded-For') or '').split(',')[0].strip()
        if forwarded:
            return forwarded
        real_ip = str(request.headers.get('X-Real-IP') or '').strip()
        if real_ip:
            return real_ip
        return request.client.host if request.client else ''

    @router.get('/admin/api/license/statistics')
    async def license_statistics(request: Request):
        _, error = await require_license_admin(request)
        if error is not None:
            return error
        return await service.statistics()

    @router.get('/admin/api/license/list')
    async def license_list(request: Request, limit: int = 50, offset: int = 0):
        _, error = await require_license_admin(request)
        if error is not None:
            return error
        return await service.list_licenses(limit=limit, offset=offset)

    @router.get('/admin/api/license/info/{license_key}')
    async def license_info(license_key: str, request: Request):
        _, error = await require_license_admin(request)
        if error is not None:
            return error
        return await service.get_license_info(license_key)

    @router.post('/admin/api/license/create')
    async def license_create(request: Request):
        token, error = await require_license_admin(request)
        if error is not None:
            return error
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'error': True, 'message': '请求体无效'})
        return await service.create_license(data, operator=operator_from_token(token))

    @router.post('/admin/api/license/revoke')
    async def license_revoke(request: Request):
        token, error = await require_license_admin(request)
        if error is not None:
            return error
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'error': True, 'message': '请求体无效'})
        return await service.revoke_license(data.get('license_key'), reason=str(data.get('reason') or ''), operator=operator_from_token(token))

    @router.post('/admin/api/license/edit')
    async def license_edit(request: Request):
        token, error = await require_license_admin(request)
        if error is not None:
            return error
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'error': True, 'message': '请求体无效'})
        return await service.edit_license(data, operator=operator_from_token(token))

    @router.get('/admin/api/license/products')
    async def license_products(request: Request):
        _, error = await require_license_admin(request)
        if error is not None:
            return error
        return await service.products()

    @router.get('/admin/api/license/health')
    async def license_health(request: Request):
        _, error = await require_license_admin(request)
        if error is not None:
            return error
        return await service.health()

    @router.get('/admin/api/license/logs')
    async def license_logs(request: Request, limit: int = 100, offset: int = 0):
        _, error = await require_license_admin(request)
        if error is not None:
            return error
        return await service.admin_logs(limit=limit, offset=offset)

    @router.post('/admin/api/license/blacklist/add')
    async def license_blacklist_add(request: Request):
        token, error = await require_license_admin(request)
        if error is not None:
            return error
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'error': True, 'message': '请求体无效'})
        return await service.blacklist_add(data, operator=operator_from_token(token))

    @router.post('/admin/api/license/blacklist/remove')
    async def license_blacklist_remove(request: Request):
        token, error = await require_license_admin(request)
        if error is not None:
            return error
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'error': True, 'message': '请求体无效'})
        return await service.blacklist_remove(data, operator=operator_from_token(token))

    @router.get('/admin/api/license/blacklist')
    async def license_blacklist_list(request: Request):
        _, error = await require_license_admin(request)
        if error is not None:
            return error
        return await service.blacklist_list()

    @router.get('/admin/api/license/clients')
    async def license_clients(request: Request, limit: int = 100, offset: int = 0):
        _, error = await require_license_admin(request)
        if error is not None:
            return error
        return await service.list_clients(limit=limit, offset=offset)

    @router.get('/admin/api/license/clients/{client_id}')
    async def license_client_detail(client_id: str, request: Request):
        _, error = await require_license_admin(request)
        if error is not None:
            return error
        return await service.client_detail(client_id)

    @router.get('/admin/api/license/online-clients')
    async def license_online_clients(request: Request):
        _, error = await require_license_admin(request)
        if error is not None:
            return error
        return await service.list_clients(limit=100, offset=0)

    @router.post('/admin/api/license/disable-client')
    async def license_disable_client(request: Request):
        token, error = await require_license_admin(request)
        if error is not None:
            return error
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'error': True, 'message': '请求体无效'})
        return await service.set_client_status(data, 'disabled', operator=operator_from_token(token))

    @router.post('/admin/api/license/enable-client')
    async def license_enable_client(request: Request):
        token, error = await require_license_admin(request)
        if error is not None:
            return error
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'error': True, 'message': '请求体无效'})
        return await service.set_client_status(data, 'active', operator=operator_from_token(token))

    @router.post('/api/v1/activate')
    async def client_activate(request: Request):
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'error': True, 'message': '请求体无效'})
        return await service.activate(data, ip_address=client_ip(request))

    @router.post('/api/v1/verify')
    async def client_verify(request: Request):
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'error': True, 'message': '请求体无效'})
        return await service.verify(data, ip_address=client_ip(request))

    @router.post('/api/v1/consume')
    async def client_consume(request: Request):
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'error': True, 'message': '请求体无效'})
        return await service.consume(data, ip_address=client_ip(request))

    @router.get('/api/v1/check-update')
    async def client_check_update(product_id: str = 'ak_admin_panel', current_version: str = '0.0.0', channel: str = 'stable'):
        return await service.check_update(product_id=product_id, current_version=current_version, channel=channel)

    @router.post('/api/v1/check-update')
    async def client_check_update_post(request: Request):
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'error': True, 'message': '请求体无效'})
        return await service.check_update(
            product_id=str(data.get('product_id') or 'ak_admin_panel'),
            current_version=str(data.get('current_version') or '0.0.0'),
            channel=str(data.get('channel') or 'stable'),
        )

    @router.get('/api/v1/health')
    async def client_health():
        return await service.health()

    return router
