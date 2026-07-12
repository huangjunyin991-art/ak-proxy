from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse


def create_guided_sale_statistics_router(
    service,
    require_admin_identity: Callable[..., Any],
    super_admin_role: str,
) -> APIRouter:
    router = APIRouter(prefix="/admin/api/guided-sale-statistics")

    async def identity(request: Request):
        token, role, owner_scope, error_response = await require_admin_identity(
            request, permission="guidedSaleStatistics"
        )
        if error_response is not None:
            return "", False, error_response
        return owner_scope, role == super_admin_role, None

    @router.get("/accounts")
    async def accounts(request: Request):
        owner_scope, is_super_admin, error_response = await identity(request)
        if error_response is not None:
            return error_response
        return {"success": True, "accounts": await service.list_accounts(owner_scope, is_super_admin)}

    @router.get("/dashboard")
    async def dashboard(request: Request):
        owner_scope, is_super_admin, error_response = await identity(request)
        if error_response is not None:
            return error_response
        return await service.dashboard(owner_scope, is_super_admin)

    @router.post("/start")
    async def start(request: Request):
        owner_scope, is_super_admin, error_response = await identity(request)
        if error_response is not None:
            return error_response
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        try:
            return await service.request_scan(owner_scope, is_super_admin)
        except PermissionError as exc:
            return JSONResponse(status_code=403, content={"success": False, "message": str(exc)})
        except ValueError as exc:
            return JSONResponse(status_code=400, content={"success": False, "message": str(exc)})

    @router.post("/refresh")
    async def refresh_notice(request: Request):
        owner_scope, is_super_admin, error_response = await identity(request)
        if error_response is not None:
            return error_response
        return await service.refresh_notice(owner_scope, is_super_admin)

    @router.post("/source")
    async def save_source(request: Request):
        owner_scope, is_super_admin, error_response = await identity(request)
        if error_response is not None:
            return error_response
        if not is_super_admin:
            return JSONResponse(status_code=403, content={"success": False, "message": "super admin required"})
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        try:
            source = await service.configure_global_source(str((payload or {}).get("source_account") or ""))
            return {"success": True, "source": source}
        except ValueError as exc:
            return JSONResponse(status_code=400, content={"success": False, "message": str(exc)})

    @router.get("/policy")
    async def policy(request: Request):
        owner_scope, is_super_admin, error_response = await identity(request)
        if error_response is not None:
            return error_response
        return {"success": True, "policy": await service.get_policy(), "is_super_admin": is_super_admin}

    @router.post("/policy")
    async def save_policy(request: Request):
        owner_scope, is_super_admin, error_response = await identity(request)
        if error_response is not None:
            return error_response
        if not is_super_admin:
            return JSONResponse(status_code=403, content={"success": False, "message": "super admin required"})
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        try:
            return {"success": True, "policy": await service.save_policy(payload or {})}
        except (TypeError, ValueError):
            return JSONResponse(status_code=400, content={"success": False, "message": "invalid policy"})

    return router
