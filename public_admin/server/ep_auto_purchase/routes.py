from __future__ import annotations

from typing import Any, Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse


def create_ep_auto_purchase_router(
    service,
    require_admin_identity: Callable[..., Any],
) -> APIRouter:
    router = APIRouter(prefix="/admin/api/ep-auto-purchase")

    async def authorize(request: Request):
        _, _, _, error_response = await require_admin_identity(request, super_admin_only=True)
        return error_response

    @router.get("/dashboard")
    async def dashboard(request: Request):
        error_response = await authorize(request)
        if error_response is not None:
            return error_response
        return await service.dashboard()

    @router.post("/config")
    async def save_config(request: Request):
        error_response = await authorize(request)
        if error_response is not None:
            return error_response
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        try:
            config = await service.configure(payload or {})
            return {"success": True, "config": config}
        except ValueError as exc:
            return JSONResponse(status_code=400, content={"success": False, "message": str(exc)})

    return router
