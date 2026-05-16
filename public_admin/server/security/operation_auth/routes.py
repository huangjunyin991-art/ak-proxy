from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse


def create_operation_auth_router(*, service, resolve_admin_identity, super_admin_role: str, sub_admin_role: str,
                                 sub_admin_names_supplier=None, totp_lockout_store=None,
                                 totp_max_fails: int = 5, totp_lockout_seconds: int = 3600,
                                 logger=None):
    router = APIRouter(prefix='/admin/api/operation_auth')

    @router.get('/me')
    async def operation_auth_me(request: Request):
        token, role, identity = await resolve_admin_identity(request)
        if not token or not role:
            return JSONResponse(status_code=401, content={'error': True, 'message': '未授权'})
        sub_name = '' if identity == '__super__' else identity
        item = await service.ensure_secret(role, sub_name)
        if item:
            item = {
                'identity': item.get('identity'),
                'role': item.get('role'),
                'sub_name': item.get('sub_name'),
                'has_secret': bool(item.get('secret')),
                'created_at': item.get('created_at'),
                'updated_at': item.get('updated_at'),
            }
        return {'success': True, 'item': item}

    @router.post('/lease')
    async def operation_auth_issue_lease(request: Request):
        token, role, identity = await resolve_admin_identity(request)
        if not token or not role:
            return JSONResponse(status_code=401, content={'error': True, 'message': '未授权'})
        client_ip = _extract_client_ip(request)
        if totp_lockout_store is not None:
            locked, remaining = totp_lockout_store.check(client_ip)
            if locked:
                return JSONResponse(status_code=403, content={
                    'error': True,
                    'success': False,
                    'locked': True,
                    'remaining_seconds': remaining,
                    'message': f'Google 验证失败次数过多，请{remaining}秒后重试',
                })
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'error': True, 'message': '请求体无效'})
        scope = str(data.get('scope') or '').strip()
        code = str(data.get('code') or '').strip()
        sub_name = '' if identity == '__super__' else identity
        if not scope:
            return JSONResponse(status_code=400, content={'error': True, 'message': '缺少操作范围'})
        if not code:
            return JSONResponse(status_code=400, content={'error': True, 'message': '缺少 Google 验证码'})
        result = await service.issue_lease(
            admin_token=token,
            role=role,
            sub_name=sub_name,
            scope=scope,
            code=code,
            duration_seconds=data.get('duration_seconds'),
            client_ip=client_ip,
            user_agent=str(request.headers.get('User-Agent') or ''),
        )
        if not result.get('success'):
            if totp_lockout_store is not None:
                fail_count = totp_lockout_store.record_fail(client_ip)
                if logger is not None:
                    logger.warning(f"[OperationAuth] Google 验证失败 ip={client_ip} fails={fail_count}")
                if fail_count >= totp_max_fails:
                    locked, remaining = totp_lockout_store.check(client_ip)
                    if logger is not None:
                        logger.warning(f"[OperationAuth] Google 验证失败过多，临时封禁IP ip={client_ip} seconds={totp_lockout_seconds}")
                    return JSONResponse(status_code=403, content={
                        'error': True,
                        'success': False,
                        'locked': True,
                        'remaining_seconds': remaining or totp_lockout_seconds,
                        'message': f'Google 验证失败次数过多，请{remaining or totp_lockout_seconds}秒后重试',
                    })
                result = {**result, 'remaining_attempts': max(0, totp_max_fails - fail_count)}
            return JSONResponse(status_code=403, content={'error': True, **result})
        if totp_lockout_store is not None:
            totp_lockout_store.clear(client_ip)
        return result

    @router.get('/secrets')
    async def operation_auth_list_secrets(request: Request):
        token, role, _ = await resolve_admin_identity(request)
        if not token or not role:
            return JSONResponse(status_code=401, content={'error': True, 'message': '未授权'})
        if role != super_admin_role:
            return JSONResponse(status_code=403, content={'error': True, 'message': '仅系统总管理员可查看 Google 绑定状态'})
        sub_admin_names = sub_admin_names_supplier() if sub_admin_names_supplier else []
        return {
            'success': True,
            'super_admin': await service.ensure_secret(super_admin_role, ''),
            'items': await service.list_sub_admin_secrets(sub_admin_names),
        }

    @router.post('/secrets/reset')
    async def operation_auth_reset_secret(request: Request):
        token, role, _ = await resolve_admin_identity(request)
        if not token or not role:
            return JSONResponse(status_code=401, content={'error': True, 'message': '未授权'})
        if role != super_admin_role:
            return JSONResponse(status_code=403, content={'error': True, 'message': '仅系统总管理员可重置 Google 密钥'})
        try:
            data = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={'error': True, 'message': '请求体无效'})
        target_role = str(data.get('role') or '').strip()
        sub_name = str(data.get('sub_name') or '').strip()
        if not target_role:
            return JSONResponse(status_code=400, content={'error': True, 'message': '缺少目标角色'})
        if target_role == super_admin_role:
            item = await service.reset_secret(target_role, '')
            if not item:
                return JSONResponse(status_code=400, content={'error': True, 'message': '目标管理员身份无效'})
            return {'success': True, 'item': item}
        if target_role != sub_admin_role:
            return JSONResponse(status_code=400, content={'error': True, 'message': '仅支持管理子管理员 Google 密钥'})
        sub_admin_names = set(sub_admin_names_supplier() if sub_admin_names_supplier else [])
        if sub_name not in sub_admin_names:
            return JSONResponse(status_code=400, content={'error': True, 'message': '目标子管理员不存在'})
        item = await service.reset_secret(target_role, sub_name)
        if not item:
            return JSONResponse(status_code=400, content={'error': True, 'message': '目标管理员身份无效'})
        return {'success': True, 'item': item}

    return router


def _extract_client_ip(request: Request) -> str:
    forwarded = request.headers.get('x-forwarded-for')
    if forwarded:
        return forwarded.split(',')[0].strip()
    real_ip = request.headers.get('x-real-ip')
    if real_ip:
        return real_ip.strip()
    if request.client:
        return request.client.host
    return 'unknown'
