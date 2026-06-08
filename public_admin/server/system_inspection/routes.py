from __future__ import annotations

from typing import Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .service import SystemInspectionService


def _extract_bearer_token(request: Request) -> str:
    auth_header = str(request.headers.get("Authorization") or "").strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return ""


def create_system_inspection_router(
    *,
    pool_supplier: Callable[[], object],
    verify_admin_token: Callable[[str], object],
    get_token_role: Callable[[str], str],
    super_admin_role: str,
    im_server_internal_url: str = "",
    ak_upstream_url: str = "",
    static_cache_supplier: Callable[[], object] | None = None,
    request_metrics_supplier: Callable[[], object] | None = None,
    ws_ticket_supplier: Callable[[], object] | None = None,
    notify_center_supplier: Callable[[], object] | None = None,
    notify_worker_supplier: Callable[[], object] | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/admin/api/system-inspection")
    service = SystemInspectionService(
        pool_supplier=pool_supplier,
        im_server_internal_url=im_server_internal_url,
        ak_upstream_url=ak_upstream_url or "https://k937.com/pages/home.html?first=true",
        static_cache_supplier=static_cache_supplier,
        request_metrics_supplier=request_metrics_supplier,
        ws_ticket_supplier=ws_ticket_supplier,
        notify_center_supplier=notify_center_supplier,
        notify_worker_supplier=notify_worker_supplier,
    )

    async def require_super_admin(request: Request):
        token = _extract_bearer_token(request)
        if not token or not await verify_admin_token(token):
            return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
        if get_token_role(token) != super_admin_role:
            return JSONResponse(status_code=403, content={"error": True, "message": "仅系统管理员可执行系统巡检"})
        return None

    @router.get("/run")
    async def run_system_inspection(request: Request):
        error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.run()
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    return router
