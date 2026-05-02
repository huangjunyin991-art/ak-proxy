from typing import Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .service import MonitoringService


def _extract_bearer_token(request: Request) -> str:
    auth_header = str(request.headers.get("Authorization") or "").strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return ""


def _parse_force(value) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def create_monitoring_router(
    pool_supplier: Callable[[], object],
    verify_admin_token: Callable[[str], object],
    get_token_role: Callable[[str], str],
    super_admin_role: str,
    im_server_internal_url: str = "",
) -> APIRouter:
    router = APIRouter(prefix="/admin/api/monitoring")
    service = MonitoringService(pool_supplier=pool_supplier, im_server_internal_url=im_server_internal_url)

    async def require_super_admin(request: Request):
        token = _extract_bearer_token(request)
        if not token or not await verify_admin_token(token):
            return None, JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
        if get_token_role(token) != super_admin_role:
            return None, JSONResponse(status_code=403, content={"error": True, "message": "仅系统总管理员可查看监控中心"})
        return token, None

    @router.get("/overview")
    async def monitoring_overview(request: Request, range: str = "7d", force: str = ""):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.get_overview(range_name=range, force=_parse_force(force))
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.get("/system")
    async def monitoring_system(request: Request, force: str = ""):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return {"success": True, "item": await service.get_system(force=_parse_force(force))}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.get("/health")
    async def monitoring_health(request: Request, force: str = ""):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return {"success": True, "item": await service.get_health(force=_parse_force(force))}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.get("/database")
    async def monitoring_database(request: Request, force: str = ""):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return {"success": True, "item": await service.get_database(force=_parse_force(force))}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.get("/chat/summary")
    async def monitoring_chat_summary(request: Request, range: str = "7d", force: str = ""):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return {"success": True, "item": await service.get_chat_summary(range_name=range, force=_parse_force(force))}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.get("/chat/groups")
    async def monitoring_chat_groups(request: Request, range: str = "7d", limit: int = 100, force: str = ""):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return {"success": True, "item": await service.get_chat_groups(range_name=range, limit=limit, force=_parse_force(force))}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.get("/chat/file-assets")
    async def monitoring_file_assets(request: Request, status: str = "active", limit: int = 50, force: str = ""):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return {"success": True, "item": await service.get_file_assets(status=status, limit=limit, force=_parse_force(force))}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.post("/chat/file-assets/{storage_name}/expire")
    async def monitoring_expire_file_asset(request: Request, storage_name: str):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            result = await service.expire_file_asset(storage_name)
            if not result.get("success"):
                return JSONResponse(status_code=400, content={"error": True, "message": result.get("message") or "文件释放失败"})
            return result
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    return router
