from __future__ import annotations

from typing import Callable, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .repository import AkDataRepository
from .service import AkDataService
from .worker import AkDataWorker


def _extract_bearer_token(request: Request) -> str:
    auth_header = str(request.headers.get("Authorization") or "").strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return ""


def create_ak_data_router(
    pool_supplier: Callable[[], object],
    verify_admin_token: Callable[[str], object],
    check_token_permission: Optional[Callable[[str, str], bool]] = None,
) -> APIRouter:
    router = APIRouter(prefix="/admin/api/ak-data")
    repository = AkDataRepository(pool_supplier=pool_supplier)
    service = AkDataService(repository, AkDataWorker(repository))

    async def require_admin(request: Request):
        token = _extract_bearer_token(request)
        if not token or not await verify_admin_token(token):
            return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
        if check_token_permission is not None and not check_token_permission(token, "akData"):
            return JSONResponse(status_code=403, content={"error": True, "message": "权限不足"})
        return None

    @router.get("/status")
    async def ak_data_status(request: Request):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.get_status()
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    @router.get("/storage")
    async def ak_data_storage(request: Request):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.get_storage()
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    @router.get("/config")
    async def ak_data_config(request: Request):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.get_config()
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    @router.post("/config")
    async def ak_data_save_config(request: Request):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.save_config(await request.json())
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    @router.get("/dashboard")
    async def ak_data_dashboard(request: Request, days: int = 7):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.get_dashboard(days)
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    @router.get("/trades/recent")
    async def ak_data_recent_trades(request: Request, limit: int = 50):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.get_recent_trades(limit)
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    @router.get("/account-query")
    async def ak_data_account_query(request: Request, query_type: str = "seller", account_id: str = "", limit: int = 500):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.query_account_trades(query_type, account_id, limit)
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    @router.get("/trades/{trade_id}/buyers")
    async def ak_data_trade_buyers(request: Request, trade_id: int):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.get_trade_buyers(trade_id)
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    @router.get("/backfill/status")
    async def ak_data_backfill_status(request: Request):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.get_backfill_status()
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    @router.post("/backfill/start")
    async def ak_data_backfill_start(request: Request):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.start_backfill(await request.json())
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    @router.post("/backfill/pause")
    async def ak_data_backfill_pause(request: Request):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.pause_backfill()
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    @router.post("/probe/start")
    async def ak_data_probe_start(request: Request):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.start_probe(await request.json())
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    @router.post("/cleanup")
    async def ak_data_cleanup(request: Request):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            return await service.cleanup()
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:500]})

    return router
