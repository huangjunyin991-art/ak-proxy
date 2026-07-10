from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse


def _extract_bearer_token(request: Request) -> str:
    auth_header = str(request.headers.get("Authorization") or "").strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return ""


def create_account_identity_admin_router(
    service,
    verify_admin_token,
    get_token_role,
    super_admin_role: str,
) -> APIRouter:
    router = APIRouter(prefix="/admin/api/account-identity")

    async def require_super_admin(request: Request):
        token = _extract_bearer_token(request)
        if not token or not await verify_admin_token(token):
            return "", JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
        if get_token_role is None or get_token_role(token) != super_admin_role:
            return token, JSONResponse(
                status_code=403,
                content={"error": True, "message": "仅总管理员可使用账号迁移模块"},
            )
        return token, None

    @router.get("/dashboard")
    async def account_identity_dashboard(
        request: Request,
        search: str = "",
        limit: int = 50,
        offset: int = 0,
        runs_limit: int = 20,
        force_stats: bool = False,
    ):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.get_dashboard(
                search=search,
                limit=limit,
                offset=offset,
                runs_limit=runs_limit,
                force_stats=force_stats,
            )
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    @router.get("/policy")
    async def account_identity_policy(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return {"success": True, "policy": await service.get_policy()}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    @router.post("/policy")
    async def update_account_identity_policy(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        try:
            return {
                "success": True,
                "policy": await service.set_policy(payload if isinstance(payload, dict) else {}),
            }
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    @router.post("/sync")
    async def start_account_identity_sync(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        try:
            result = await service.start_sync(
                triggered_by="super_admin",
                trigger_mode="manual",
                phase_key=str((payload or {}).get("phase_key") or ""),
                dry_run=bool((payload or {}).get("dry_run", False)),
                limit_per_spec=(payload or {}).get("limit_per_spec"),
            )
            if not result.get("started"):
                return JSONResponse(status_code=409, content=result)
            return result
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    return router
