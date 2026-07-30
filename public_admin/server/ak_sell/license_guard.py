from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse


MACHINE_AUTHORIZATION_HEADER = "X-AK-Authorization"
MachineAuthorizationValidator = Callable[[str, str], Awaitable[dict[str, Any]]]


class AKSellLicenseGuard:
    """Requires an active, server-verified AK auto-sell machine authorization."""

    def __init__(self, validator: MachineAuthorizationValidator | None) -> None:
        self._validator = validator

    async def authorize(self, request: Request) -> JSONResponse | None:
        authorization_code = str(request.headers.get(MACHINE_AUTHORIZATION_HEADER) or "").strip()
        if not authorization_code:
            return self._rejected("缺少机器授权", "AUTHORIZATION_REQUIRED")
        if self._validator is None:
            return JSONResponse(
                status_code=503,
                content={
                    "success": False,
                    "message": "授权验证服务不可用",
                    "error_code": "AUTHORIZATION_UNAVAILABLE",
                },
                headers={"Cache-Control": "no-store, private"},
            )
        try:
            result = await self._validator(authorization_code, self._client_ip(request))
        except Exception:
            return JSONResponse(
                status_code=503,
                content={
                    "success": False,
                    "message": "授权验证服务不可用",
                    "error_code": "AUTHORIZATION_UNAVAILABLE",
                },
                headers={"Cache-Control": "no-store, private"},
            )
        if not bool(result.get("success")):
            return self._rejected(
                str(result.get("message") or "机器授权无效"),
                str(result.get("error_code") or "AUTHORIZATION_INVALID"),
            )
        return None

    @staticmethod
    def _client_ip(request: Request) -> str:
        forwarded = str(request.headers.get("X-Forwarded-For") or "").split(",", 1)[0].strip()
        if forwarded:
            return forwarded
        real_ip = str(request.headers.get("X-Real-IP") or "").strip()
        if real_ip:
            return real_ip
        return str(request.client.host) if request.client else ""

    @staticmethod
    def _rejected(message: str, error_code: str) -> JSONResponse:
        return JSONResponse(
            status_code=403,
            content={"success": False, "message": message, "error_code": error_code},
            headers={"Cache-Control": "no-store, private"},
        )
