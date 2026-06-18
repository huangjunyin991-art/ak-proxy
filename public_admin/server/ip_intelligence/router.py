from typing import Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .service import IpIntelligenceService


def _extract_bearer_token(request: Request) -> str:
    auth_header = str(request.headers.get("Authorization") or "").strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return ""


def create_ip_intelligence_router(
    service: IpIntelligenceService,
    verify_admin_token: Callable[[str], object],
    get_token_role: Callable[[str], str],
    super_admin_role: str,
    check_token_permission: Callable[[str, str], bool] | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/admin/api/ip-intelligence")

    async def require_admin(request: Request):
        token = _extract_bearer_token(request)
        if not token or not await verify_admin_token(token):
            return None, JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
        return token, None

    async def require_super_admin(request: Request):
        token, error_response = await require_admin(request)
        if error_response is not None:
            return None, error_response
        if get_token_role(token) != super_admin_role:
            return None, JSONResponse(status_code=403, content={"error": True, "message": "仅系统总管理员可配置 IP 情报"})
        return token, None

    async def require_banlist_view(request: Request):
        token, error_response = await require_admin(request)
        if error_response is not None:
            return None, error_response
        if get_token_role(token) == super_admin_role:
            return token, None
        if check_token_permission is not None and check_token_permission(token, "banlist"):
            return token, None
        return None, JSONResponse(status_code=403, content={"error": True, "message": "无权查看 IP 情报"})

    @router.get("/policy")
    async def get_policy(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        return {"success": True, "item": await service.snapshot()}

    @router.post("/policy")
    async def update_policy(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        payload = await request.json()
        item = await service.set_policy(payload or {})
        return {"success": True, "item": item}

    @router.get("/lookup")
    async def lookup(request: Request, ip: str):
        _, error_response = await require_banlist_view(request)
        if error_response is not None:
            return error_response
        try:
            item = await service.get_ip_info(ip)
            return {"success": True, "item": item}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.get("/attack-map")
    async def attack_map(request: Request, range_hours: int | None = None):
        _, error_response = await require_banlist_view(request)
        if error_response is not None:
            return error_response
        try:
            item = await service.get_attack_map(range_hours)
            return {"success": True, "item": item}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    return router
