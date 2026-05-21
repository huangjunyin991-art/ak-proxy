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

    async def read_json(request: Request):
        try:
            return await request.json()
        except Exception:
            return None

    async def read_json_or_error(request: Request):
        data = await read_json(request)
        if data is None:
            return None, JSONResponse(status_code=400, content={'error': True, 'success': False, 'message': '请求体无效'})
        return data, None

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

    @router.get('/admin/api/license/releases')
    async def license_releases(request: Request, product_id: str = '', channel: str = '', limit: int = 50, offset: int = 0):
        _, error = await require_license_admin(request)
        if error is not None:
            return error
        return await service.list_releases(product_id=product_id, channel=channel, limit=limit, offset=offset)

    @router.post('/admin/api/license/releases/publish')
    async def license_publish_release(request: Request):
        token, error = await require_license_admin(request)
        if error is not None:
            return error
        data = await read_json(request)
        if data is None:
            return JSONResponse(status_code=400, content={'error': True, 'success': False, 'message': '请求体无效'})
        return await service.publish_release(data, operator=operator_from_token(token))

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
        data = await read_json(request)
        if data is None:
            return JSONResponse(status_code=400, content={'error': True, 'success': False, 'message': '请求体无效'})
        return await service.activate(data, ip_address=client_ip(request))

    @router.post('/api/v1/verify')
    async def client_verify(request: Request):
        data = await read_json(request)
        if data is None:
            return JSONResponse(status_code=400, content={'error': True, 'success': False, 'message': '请求体无效'})
        return await service.verify(data, ip_address=client_ip(request))

    @router.post('/api/v1/consume')
    async def client_consume(request: Request):
        data = await read_json(request)
        if data is None:
            return JSONResponse(status_code=400, content={'error': True, 'success': False, 'message': '请求体无效'})
        return await service.consume(data, ip_address=client_ip(request))

    @router.get('/api/v1/license/check-initialized')
    async def client_license_check_initialized(license_key: str = '', machine_id: str = ''):
        return await service.check_credentials_initialized({'license_key': license_key, 'machine_id': machine_id})

    @router.get('/api/v1/license/credentials')
    async def client_license_credentials(license_key: str = '', machine_id: str = ''):
        return await service.check_credentials_initialized({'license_key': license_key, 'machine_id': machine_id})

    @router.post('/api/v1/license/setup-credentials')
    async def client_license_setup_credentials(request: Request):
        data, error = await read_json_or_error(request)
        if error is not None:
            return error
        return await service.setup_credentials(data)

    @router.post('/api/v1/license/login')
    async def client_license_login(request: Request):
        data, error = await read_json_or_error(request)
        if error is not None:
            return error
        return await service.login_credentials(data)

    @router.post('/api/v1/license/verify-password')
    async def client_license_verify_password(request: Request):
        data, error = await read_json_or_error(request)
        if error is not None:
            return error
        return await service.verify_secondary_password(data)

    @router.post('/api/v1/license/reset-password')
    async def client_license_reset_password(request: Request):
        data, error = await read_json_or_error(request)
        if error is not None:
            return error
        return await service.reset_passwords_with_google(data)

    @router.post('/api/v1/license/google/begin')
    async def client_license_google_begin(request: Request):
        data, error = await read_json_or_error(request)
        if error is not None:
            return error
        return await service.begin_google_binding(data)

    @router.post('/api/v1/license/google/confirm')
    async def client_license_google_confirm(request: Request):
        data, error = await read_json_or_error(request)
        if error is not None:
            return error
        return await service.confirm_google_binding(data)

    @router.get('/api/v1/check-update')
    async def client_check_update(product_id: str = 'ak_admin_panel', current_version: str = '0.0.0', channel: str = 'stable'):
        return await service.check_update(product_id=product_id, current_version=current_version, channel=channel)

    @router.post('/api/v1/check-update')
    async def client_check_update_post(request: Request):
        data = await read_json(request)
        if data is None:
            return JSONResponse(status_code=400, content={'error': True, 'success': False, 'message': '请求体无效'})
        return await service.check_update(
            product_id=str(data.get('product_id') or 'ak_admin_panel'),
            current_version=str(data.get('current_version') or '0.0.0'),
            channel=str(data.get('channel') or 'stable'),
        )

    @router.get('/api/check-update')
    async def legacy_check_update_get(product_id: str = 'ak_admin_panel', current_version: str = '0.0.0', channel: str = 'stable'):
        return await service.check_update(product_id=product_id, current_version=current_version, channel=channel)

    @router.post('/api/check-update')
    async def legacy_check_update_post(request: Request):
        data = await read_json(request)
        if data is None:
            return JSONResponse(status_code=400, content={'error': True, 'success': False, 'message': '请求体无效'})
        return await service.check_update(
            product_id=str(data.get('product_id') or 'ak_admin_panel'),
            current_version=str(data.get('current_version') or '0.0.0'),
            channel=str(data.get('channel') or 'stable'),
        )

    @router.get('/api/license/status')
    async def legacy_license_status():
        result = await service.health()
        return {
            'success': True,
            'error': False,
            'message': result.get('message') or '授权中心正常',
            'product_id': result.get('data', {}).get('product_id') or 'ak_admin_panel',
            'server_url': result.get('data', {}).get('server_url') or 'https://ak2025.vip',
        }

    @router.post('/api/license/activate')
    async def legacy_license_activate(request: Request):
        data = await read_json(request)
        if data is None:
            return JSONResponse(status_code=400, content={'error': True, 'success': False, 'message': '请求体无效'})
        if data.get('activation_code') and not data.get('license_key'):
            data['license_key'] = data.get('activation_code')
        return await service.activate(data, ip_address=client_ip(request))

    @router.post('/api/license/verify')
    async def legacy_license_verify(request: Request):
        data = await read_json(request)
        if data is None:
            data = {}
        return await service.verify(data, ip_address=client_ip(request))

    @router.get('/api/license/credentials')
    async def legacy_license_credentials(license_key: str = '', machine_id: str = ''):
        return await service.check_credentials_initialized({'license_key': license_key, 'machine_id': machine_id})

    @router.post('/api/license/setup-credentials')
    async def legacy_license_setup_credentials(request: Request):
        data, error = await read_json_or_error(request)
        if error is not None:
            return error
        return await service.setup_credentials(data)

    @router.post('/api/license/login')
    async def legacy_license_login(request: Request):
        data, error = await read_json_or_error(request)
        if error is not None:
            return error
        return await service.login_credentials(data)

    @router.post('/api/license/verify-operation')
    async def legacy_license_verify_operation(request: Request):
        data, error = await read_json_or_error(request)
        if error is not None:
            return error
        return await service.verify_secondary_password(data)

    @router.post('/api/license/verify-password')
    async def legacy_license_verify_password(request: Request):
        data, error = await read_json_or_error(request)
        if error is not None:
            return error
        return await service.verify_secondary_password(data)

    @router.post('/api/license/reset-password')
    async def legacy_license_reset_password(request: Request):
        data, error = await read_json_or_error(request)
        if error is not None:
            return error
        return await service.reset_passwords_with_google(data)

    @router.post('/api/license/google/begin')
    async def legacy_license_google_begin(request: Request):
        data, error = await read_json_or_error(request)
        if error is not None:
            return error
        return await service.begin_google_binding(data)

    @router.post('/api/license/google/confirm')
    async def legacy_license_google_confirm(request: Request):
        data, error = await read_json_or_error(request)
        if error is not None:
            return error
        return await service.confirm_google_binding(data)

    @router.get('/api/v1/health')
    async def client_health():
        return await service.health()

    return router
