from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .service import AKSellInputError


def create_ak_sell_router(
    service,
    require_admin_identity: Callable[..., Any],
) -> APIRouter:
    router = APIRouter(prefix="/admin/api/ak-sell")

    async def authorize(request: Request):
        _, _, _, error_response = await require_admin_identity(request, super_admin_only=True)
        return error_response

    async def invoke(request: Request, operation: str):
        error_response = await authorize(request)
        if error_response is not None:
            return error_response
        try:
            payload = await request.json()
        except Exception:
            return JSONResponse(status_code=400, content={"success": False, "message": "请求体必须是 JSON 对象"})
        if not isinstance(payload, dict):
            return JSONResponse(status_code=400, content={"success": False, "message": "请求体必须是 JSON 对象"})
        try:
            result = await service.invoke(operation, payload)
        except AKSellInputError as exc:
            return JSONResponse(status_code=400, content={"success": False, "message": str(exc)})
        status_code = 504 if result.get("state") == "unknown" else 200
        return JSONResponse(status_code=status_code, content=result)

    @router.post("/login")
    async def login(request: Request):
        return await invoke(request, "login")

    @router.post("/mnemonic")
    async def mnemonic(request: Request):
        return await invoke(request, "mnemonic")

    @router.post("/balance")
    async def balance(request: Request):
        return await invoke(request, "balance")

    @router.post("/subaccounts")
    async def subaccounts(request: Request):
        return await invoke(request, "subaccounts")

    @router.post("/submit")
    async def submit(request: Request):
        return await invoke(request, "submit")

    return router
