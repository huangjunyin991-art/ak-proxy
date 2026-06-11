from typing import Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..runtime_performance import BlockingPoolConfigService
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
    system_config=None,
    static_cache_service_supplier: Callable[[], object] = None,
    static_cache_warmup_supplier: Callable[[], object] = None,
    request_metrics_supplier: Callable[[], object] = None,
    request_metrics_config_supplier: Callable[[], object] = None,
    logger=None,
) -> APIRouter:
    router = APIRouter(prefix="/admin/api/monitoring")
    service = MonitoringService(
        pool_supplier=pool_supplier,
        im_server_internal_url=im_server_internal_url,
        system_config=system_config,
        logger=logger,
    )
    blocking_pool_config = BlockingPoolConfigService(system_config, logger=logger)

    async def require_super_admin(request: Request):
        token = _extract_bearer_token(request)
        if not token or not await verify_admin_token(token):
            return None, JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
        if get_token_role(token) != super_admin_role:
            return None, JSONResponse(status_code=403, content={"error": True, "message": "仅系统总管理员可查看性能监控"})
        return token, None

    def static_cache_service():
        return static_cache_service_supplier() if static_cache_service_supplier else None

    def static_cache_warmup():
        return static_cache_warmup_supplier() if static_cache_warmup_supplier else None

    def request_metrics():
        return request_metrics_supplier() if request_metrics_supplier else None

    def request_metrics_config():
        return request_metrics_config_supplier() if request_metrics_config_supplier else None

    @router.get("/snapshot-policy")
    async def monitoring_snapshot_policy(request: Request, force: str = ""):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return {"success": True, "item": await service.get_snapshot_policy(force=_parse_force(force))}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.post("/snapshot-policy")
    async def monitoring_update_snapshot_policy(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            payload = await request.json()
            return {"success": True, "item": await service.update_snapshot_policy(payload or {})}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

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

    @router.get("/ws-tickets")
    async def monitoring_ws_tickets(request: Request, force: str = ""):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return {"success": True, "item": await service.get_ws_tickets(force=_parse_force(force))}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.get("/ws-tickets/policy")
    async def monitoring_ws_ticket_policy(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return {"success": True, "item": await service.get_ws_ticket_policy()}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.post("/ws-tickets/policy")
    async def monitoring_update_ws_ticket_policy(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            payload = await request.json()
            return {"success": True, "item": await service.update_ws_ticket_policy(payload or {})}
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

    @router.get("/static-cache/policy")
    async def monitoring_static_cache_policy(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        cache_service = static_cache_service()
        if cache_service is None:
            return JSONResponse(status_code=503, content={"error": True, "message": "K937 静态资源缓存服务不可用"})
        try:
            return {"success": True, "item": cache_service.get_browser_policy()}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.post("/static-cache/policy")
    async def monitoring_update_static_cache_policy(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        cache_service = static_cache_service()
        if cache_service is None:
            return JSONResponse(status_code=503, content={"error": True, "message": "K937 静态资源缓存服务不可用"})
        try:
            payload = await request.json()
            cache_service.update_browser_policy(payload or {})
            if hasattr(cache_service, "hydrate_memory_from_disk"):
                await cache_service.hydrate_memory_from_disk(reason="policy_update")
            return {"success": True, "item": cache_service.get_browser_policy()}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.post("/static-cache/refresh-upstream")
    async def monitoring_refresh_static_cache_upstream(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        cache_service = static_cache_service()
        if cache_service is None:
            return JSONResponse(status_code=503, content={"error": True, "message": "K937 静态资源缓存服务不可用"})
        try:
            return {"success": True, "item": cache_service.refresh_upstream_version()}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.get("/static-cache/entries")
    async def monitoring_static_cache_entries(request: Request, limit: int = 80):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        cache_service = static_cache_service()
        if cache_service is None:
            return JSONResponse(status_code=503, content={"error": True, "message": "K937 静态资源缓存服务不可用"})
        try:
            return {"success": True, "item": await cache_service.describe_entries(limit=limit)}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.post("/static-cache/prewarm")
    async def monitoring_static_cache_prewarm(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        warmup = static_cache_warmup()
        if warmup is None:
            return JSONResponse(status_code=503, content={"error": True, "message": "K937 静态资源预热服务不可用"})
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        try:
            pages = payload.get("pages") if isinstance(payload, dict) else None
            max_assets = payload.get("max_assets") if isinstance(payload, dict) else 180
            if pages is not None and not isinstance(pages, (list, tuple)):
                pages = None
            return {"success": True, "item": await warmup.prewarm_default(pages=pages, max_assets=max_assets)}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.get("/request-metrics")
    async def monitoring_request_metrics(request: Request, limit: int = 80, force: str = ""):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        config = request_metrics_config()
        if config is not None:
            try:
                return {"success": True, "item": await config.snapshot(limit=limit, force_refresh=force == "1")}
            except Exception as exc:
                return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})
        metrics = request_metrics()
        if metrics is None:
            return JSONResponse(status_code=503, content={"error": True, "message": "慢请求采集服务不可用"})
        try:
            return {"success": True, "item": metrics.snapshot(limit=limit)}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.get("/blocking-pools")
    async def monitoring_blocking_pools(request: Request, force: str = ""):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            return {"success": True, "item": await blocking_pool_config.snapshot(force=_parse_force(force))}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.post("/blocking-pools/policy")
    async def monitoring_update_blocking_pools_policy(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        try:
            payload = await request.json()
            await blocking_pool_config.set_policy_payload(payload or {})
            return {"success": True, "item": await blocking_pool_config.snapshot(force=True)}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.post("/request-metrics/policy")
    async def monitoring_update_request_metrics_policy(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        config = request_metrics_config()
        metrics = request_metrics()
        if config is None and metrics is None:
            return JSONResponse(status_code=503, content={"error": True, "message": "慢请求采集服务不可用"})
        try:
            payload = await request.json()
            if config is not None:
                await config.set_policy_payload(payload or {})
                return {"success": True, "item": await config.snapshot(limit=80, force_refresh=False)}
            return {"success": True, "item": metrics.update_policy(payload or {})}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    @router.post("/request-metrics/clear")
    async def monitoring_clear_request_metrics(request: Request):
        _, error_response = await require_super_admin(request)
        if error_response is not None:
            return error_response
        metrics = request_metrics()
        if metrics is None:
            return JSONResponse(status_code=503, content={"error": True, "message": "慢请求采集服务不可用"})
        try:
            return {"success": True, "item": metrics.clear()}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": True, "message": str(exc)[:300]})

    return router
