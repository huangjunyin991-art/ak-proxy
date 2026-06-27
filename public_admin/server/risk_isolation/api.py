from typing import Any, Awaitable, Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .service import RiskIsolationService


AdminTokenRequirement = Callable[[Request, str, bool], Awaitable[tuple[str, Any]]]
TokenValueResolver = Callable[[str], str]


def create_risk_isolation_router(service: RiskIsolationService,
                                 require_admin_token: AdminTokenRequirement,
                                 get_token_role: TokenValueResolver,
                                 get_token_sub_name: TokenValueResolver) -> APIRouter:
    router = APIRouter(prefix='/admin/api/risk-isolation')

    async def resolve_context(request: Request):
        token, error_response = await require_admin_token(request, '', False)
        if error_response is not None:
            return '', '', '', error_response
        role = get_token_role(token) or ''
        sub_name = get_token_sub_name(token) or ''
        return token, role, sub_name, None

    @router.get('/status')
    async def status(request: Request):
        _, role, sub_name, error_response = await resolve_context(request)
        if error_response is not None:
            return error_response
        return {
            'success': True,
            'available': True,
            'ready': service.initialized,
            'role': role,
            'sub_name': sub_name,
            'page_404_enabled': await service.get_404_page_enabled(),
        }

    @router.get('/sub_admin_scopes')
    async def sub_admin_scopes(request: Request):
        _, role, _, error_response = await resolve_context(request)
        if error_response is not None:
            return error_response
        if role != service.super_admin_role:
            return JSONResponse(status_code=403, content={'success': False, 'message': '无权访问'})
        return {
            'success': True,
            'rows': await service.list_sub_admin_scopes(role),
        }

    @router.post('/page_404')
    async def page_404(request: Request):
        _, role, _, error_response = await resolve_context(request)
        if error_response is not None:
            return error_response
        if role != service.super_admin_role:
            return JSONResponse(status_code=403, content={'success': False, 'message': '仅系统总管理员可修改404页面开关'})
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'success': False, 'message': '请求无效'})
        enabled = bool(data.get('enabled'))
        saved = await service.set_404_page_enabled(enabled)
        if not saved:
            return JSONResponse(status_code=500, content={'success': False, 'message': '保存失败'})
        return {'success': True, 'enabled': enabled}

    @router.get('/accounts')
    async def accounts(request: Request, sub_admin: str = '', search: str = '', limit: int = 200, offset: int = 0):
        _, role, sub_name, error_response = await resolve_context(request)
        if error_response is not None:
            return error_response
        scope = service.resolve_scope(role, sub_name=sub_name, requested_sub_admin=sub_admin)
        result = await service.list_accounts(scope, search=search, limit=limit, offset=offset)
        result['success'] = True
        return result

    @router.post('/isolate')
    async def isolate(request: Request):
        _, role, sub_name, error_response = await resolve_context(request)
        if error_response is not None:
            return error_response
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'success': False, 'message': '请求无效'})
        usernames = data.get('usernames') or []
        if isinstance(usernames, str):
            usernames = [usernames]
        scope = service.resolve_scope(role, sub_name=sub_name, requested_sub_admin=str(data.get('sub_admin') or ''))
        operator = sub_name if role == service.sub_admin_role and sub_name else 'super_admin'
        result = await service.isolate_usernames(
            scope,
            usernames,
            operator=operator,
            operator_role=role,
            reason=str(data.get('reason') or '').strip(),
        )
        return {'success': True, 'message': f"已隔离 {result.get('updated', 0)} 个玩家", **result}

    @router.post('/isolate_scope')
    async def isolate_scope(request: Request):
        _, role, sub_name, error_response = await resolve_context(request)
        if error_response is not None:
            return error_response
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'success': False, 'message': '请求无效'})
        scope = service.resolve_scope(role, sub_name=sub_name, requested_sub_admin=str(data.get('sub_admin') or ''))
        if scope.added_by == '__deny__':
            return JSONResponse(status_code=400, content={'success': False, 'message': '请选择要隔离的子管理员范围'})
        operator = sub_name if role == service.sub_admin_role and sub_name else 'super_admin'
        result = await service.isolate_scope(
            scope,
            operator=operator,
            operator_role=role,
            reason=str(data.get('reason') or '').strip(),
        )
        return {'success': True, 'message': f"已隔离当前范围 {result.get('updated', 0)} 个玩家", **result}

    @router.post('/isolate_umbrella')
    async def isolate_umbrella(request: Request):
        _, role, sub_name, error_response = await resolve_context(request)
        if error_response is not None:
            return error_response
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'success': False, 'message': '请求无效'})
        account = str(data.get('account') or data.get('username') or '').strip()
        scope = service.resolve_scope(role, sub_name=sub_name, requested_sub_admin=str(data.get('sub_admin') or ''))
        operator = sub_name if role == service.sub_admin_role and sub_name else 'super_admin'
        try:
            result = await service.isolate_umbrella(
                scope,
                account=account,
                operator=operator,
                operator_role=role,
                reason=str(data.get('reason') or '').strip(),
            )
        except Exception as exc:
            return JSONResponse(status_code=400, content={'success': False, 'message': str(exc), 'error': str(exc)})
        refreshed_text = '，已自动获取组织架构' if result.get('cache_refreshed') else ''
        skipped = int(result.get('skipped_total') or 0)
        skipped_text = f"，{skipped} 个不在当前范围已跳过" if skipped else ''
        return {
            'success': True,
            'message': f"已隔离 {result.get('updated', 0)} 个伞下玩家{refreshed_text}{skipped_text}",
            **result,
        }

    @router.post('/release')
    async def release(request: Request):
        _, role, sub_name, error_response = await resolve_context(request)
        if error_response is not None:
            return error_response
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'success': False, 'message': '请求无效'})
        usernames = data.get('usernames') or []
        if isinstance(usernames, str):
            usernames = [usernames]
        scope = service.resolve_scope(role, sub_name=sub_name, requested_sub_admin=str(data.get('sub_admin') or ''))
        result = await service.release_usernames(scope, usernames)
        return {'success': True, 'message': f"已解除 {result.get('updated', 0)} 个玩家", **result}

    @router.post('/release_scope')
    async def release_scope(request: Request):
        _, role, sub_name, error_response = await resolve_context(request)
        if error_response is not None:
            return error_response
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'success': False, 'message': '请求无效'})
        scope = service.resolve_scope(role, sub_name=sub_name, requested_sub_admin=str(data.get('sub_admin') or ''))
        result = await service.release_scope(scope)
        return {'success': True, 'message': f"已恢复当前范围 {result.get('updated', 0)} 个玩家", **result}

    return router
