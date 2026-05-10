from typing import Callable, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .repository import RecommendTreeRepository
from .service import RecommendTreeService


def _extract_bearer_token(request: Request) -> str:
    auth_header = str(request.headers.get("Authorization") or "").strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return ""


def create_recommend_tree_router(
    pool_supplier: Callable[[], object],
    verify_admin_token: Callable[[str], object],
    check_token_permission: Optional[Callable[[str, str], bool]] = None,
) -> APIRouter:
    router = APIRouter(prefix="/admin/api/recommend-tree")
    repository = RecommendTreeRepository(pool_supplier=pool_supplier)
    service = RecommendTreeService(repository=repository)

    async def require_admin(request: Request):
        token = _extract_bearer_token(request)
        if not token or not await verify_admin_token(token):
            return JSONResponse(status_code=401, content={"error": True, "message": "未授权"})
        if check_token_permission is not None and not check_token_permission(token, 'recommendTree'):
            return JSONResponse(status_code=403, content={"error": True, "message": "无组织架构权限"})
        return None

    @router.get("/cache")
    async def recommend_tree_cache(request: Request, account: str = ""):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            result = await service.get_cache(account)
            if not result.get("success"):
                return JSONResponse(status_code=400, content=result)
            return result
        except Exception as exc:
            return JSONResponse(status_code=500, content={"success": False, "message": str(exc)[:500]})

    @router.get("/accounts")
    async def recommend_tree_accounts(request: Request, search: str = "", q: str = "", limit: int = 12):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            rows = await repository.search_accounts(search or q, limit)
            return {"success": True, "rows": rows}
        except Exception as exc:
            return JSONResponse(status_code=500, content={"success": False, "message": str(exc)[:500]})

    @router.post("/refresh")
    async def recommend_tree_refresh(request: Request):
        error_response = await require_admin(request)
        if error_response is not None:
            return error_response
        try:
            data = await request.json()
        except Exception:
            data = {}
        try:
            result = await service.refresh(
                account=str(data.get("account") or ""),
                root_rid=str(data.get("rootRid") or ""),
                page_size=data.get("pageSize", 15),
                max_pages=data.get("maxPages", 0),
                max_depth=data.get("maxDepth", 0),
                max_nodes=data.get("maxNodes", 0),
            )
            if not result.get("success"):
                return JSONResponse(status_code=400, content=result)
            return result
        except Exception as exc:
            return JSONResponse(status_code=500, content={"success": False, "message": str(exc)[:500]})

    return router
