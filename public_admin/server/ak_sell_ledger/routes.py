from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse


def create_ak_sell_ledger_router(*, service, require_admin_identity: Callable[..., Any], super_admin_role: str) -> APIRouter:
    router = APIRouter(prefix="/admin/api/ak-sell-ledger")

    async def identity(request: Request, *, super_only: bool = False):
        _, role, _, error = await require_admin_identity(request, super_admin_only=super_only)
        return role, error

    @router.get("/dashboard")
    async def dashboard(request: Request):
        role, error = await identity(request)
        if error is not None:
            return error
        try:
            result = await service.dashboard(
                account=str(request.query_params.get("account") or ""),
                source=str(request.query_params.get("source") or ""),
                page=int(request.query_params.get("page") or 1),
                page_size=int(request.query_params.get("page_size") or 50),
            )
        except (TypeError, ValueError):
            return JSONResponse(status_code=400, content={"success": False, "message": "invalid query"})
        result["is_super_admin"] = role == super_admin_role
        return result

    @router.get("/config")
    async def config(request: Request):
        _, error = await identity(request)
        if error is not None:
            return error
        return await service.config()

    @router.post("/config")
    async def save_config(request: Request):
        _, error = await identity(request, super_only=True)
        if error is not None:
            return error
        try:
            payload = await request.json()
            return await service.save_config(payload if isinstance(payload, dict) else {})
        except (ValueError, TypeError) as exc:
            return JSONResponse(status_code=400, content={"success": False, "message": str(exc)})

    @router.post("/cleanup")
    async def cleanup(request: Request):
        _, error = await identity(request, super_only=True)
        if error is not None:
            return error
        return await service.cleanup()

    return router
