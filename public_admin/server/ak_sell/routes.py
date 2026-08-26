from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .license_guard import AKSellLicenseGuard, MachineAuthorizationValidator
from .service import AKSellInputError


def create_ak_sell_router(
    service,
    machine_authorization_validator: MachineAuthorizationValidator | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/admin/api/ak-sell")
    license_guard = AKSellLicenseGuard(machine_authorization_validator)

    async def authorize(request: Request):
        return await license_guard.authorize(request)

    async def invoke(request: Request, operation: str):
        error_response = await authorize(request)
        if error_response is not None:
            return error_response
        try:
            payload = await request.json()
        except Exception:
            return JSONResponse(
                status_code=400,
                content={
                    "success": False,
                    "message": "请求体必须是 JSON 对象",
                    "server_time": service.server_time(),
                },
                headers={"Cache-Control": "no-store, private"},
            )
        if not isinstance(payload, dict):
            return JSONResponse(
                status_code=400,
                content={
                    "success": False,
                    "message": "请求体必须是 JSON 对象",
                    "server_time": service.server_time(),
                },
                headers={"Cache-Control": "no-store, private"},
            )
        try:
            result = await service.invoke(operation, payload)
        except AKSellInputError as exc:
            return JSONResponse(
                status_code=400,
                content={
                    "success": False,
                    "message": str(exc),
                    "server_time": service.server_time(),
                },
                headers={"Cache-Control": "no-store, private"},
            )
        status_code = 504 if result.get("state") == "unknown" else 200
        return JSONResponse(
            status_code=status_code,
            content=result,
            headers={"Cache-Control": "no-store, private"},
        )

    @router.get("/time")
    async def time(request: Request):
        error_response = await authorize(request)
        if error_response is not None:
            return error_response
        return JSONResponse(
            content={"success": True, "server_time": service.server_time()},
            headers={"Cache-Control": "no-store, private"},
        )

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

    @router.post("/submit-status")
    async def submit_status(request: Request):
        error_response = await authorize(request)
        if error_response is not None:
            return error_response
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        try:
            result = await service.submit_status(payload.get("request_id") or payload.get("requestId") or "")
        except AKSellInputError as exc:
            return JSONResponse(
                status_code=400,
                content={"success": False, "message": str(exc), "server_time": service.server_time()},
                headers={"Cache-Control": "no-store, private"},
            )
        return JSONResponse(content=result, headers={"Cache-Control": "no-store, private"})

    @router.post("/google-bind")
    async def google_bind(request: Request):
        return await invoke(request, "google-bind")

    @router.post("/google-unbind")
    async def google_unbind(request: Request):
        return await invoke(request, "google-unbind")

    return router
