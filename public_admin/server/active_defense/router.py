from typing import Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .config_service import ActiveDefenseConfigService


def _extract_bearer_token(request: Request) -> str:
    auth_header = str(request.headers.get("Authorization") or "").strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return ""


def create_active_defense_router(
    config_service: ActiveDefenseConfigService,
    verify_admin_token: Callable[[str], object],
    get_token_role: Callable[[str], str],
    super_admin_role: str,
) -> APIRouter:
    router = APIRouter(prefix="/admin/api/active-defense")

    async def require_super_admin(request: Request):
        token = _extract_bearer_token(request)
        if not token or not await verify_admin_token(token):
            return None, JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
        if get_token_role(token) != super_admin_role:
            return None, JSONResponse(status_code=403, content={"error": True, "message": "仅系统总管理员可配置主动防御"})
        return token, None

    @router.get("/policy")
    async def get_policy(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return {"success": True, "item": await config_service.snapshot()}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.post("/policy")
    async def update_policy(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            payload = await request.json()
            item = await config_service.set_policy_payload(payload or {})
            return {"success": True, "item": item}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.get("/status")
    async def get_status(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return {"success": True, "item": await config_service.snapshot()}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.post("/runtime/clear")
    async def clear_runtime(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            result = config_service.clear_runtime()
            if not result.get("success"):
                return JSONResponse(status_code=503, content={"error": True, "message": result.get("message") or "主动防御模块不可用"})
            return result
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    return router
