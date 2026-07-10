from __future__ import annotations

from typing import Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .service import NoticeGuidanceService


def create_notice_guidance_router(
    origin_validator: Callable[[Request], object] | None = None,
    logger=None,
) -> APIRouter:
    router = APIRouter(prefix="/api/notice-guidance")
    service = NoticeGuidanceService(logger=logger)

    @router.post("/guided-sale")
    async def analyze_guided_sale_notice(request: Request):
        if origin_validator is not None:
            error_response = origin_validator(request)
            if error_response is not None:
                return error_response
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            return JSONResponse(
                status_code=400,
                content={"success": False, "message": "invalid payload"},
            )
        try:
            return await service.analyze_notice_payload(payload)
        except ValueError as exc:
            return JSONResponse(
                status_code=400,
                content={"success": False, "message": str(exc)[:300]},
            )
        except Exception as exc:
            if logger is not None:
                try:
                    logger.warning("[NoticeGuidance] analyze failed: %s", str(exc)[:500])
                except Exception:
                    pass
            return JSONResponse(
                status_code=502,
                content={"success": False, "message": str(exc)[:500]},
            )

    return router
