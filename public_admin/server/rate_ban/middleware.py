"""High-performance rate-ban middleware."""

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


class RateBanMiddleware(BaseHTTPMiddleware):
    _EXCLUDED_PREFIXES = (
        "/admin/api/rate-ban",
        "/admin/pages",
        "/static",
        "/favicon",
        "/__dashboard",
    )

    async def dispatch(self, request: Request, call_next):
        path = str(request.url.path)
        if any(path.startswith(p) for p in self._EXCLUDED_PREFIXES):
            return await call_next(request)

        import public_admin.server.proxy_server as ps

        service = getattr(ps, "rate_ban_service", None)
        if service is None:
            return await call_next(request)

        client_ip = ps._extract_client_ip(request)
        method = request.method

        try:
            decision = await service.check(
                client_ip=client_ip,
                request_path=path,
                method=method,
                is_loopback=ps._is_loopback_ip,
                is_banned=ps._is_ip_banned_for_penalty,
                ban_ip=ps._ban_active_defense_ip,
            )
        except Exception as exc:
            import logging

            logging.getLogger(__name__).warning(f"[RateBan] check skipped after error: {exc}")
            return await call_next(request)

        code = decision.code
        if code in ("disabled", "anonymous", "loopback", "no_match", "ok"):
            return await call_next(request)

        if code == "already_banned":
            return await ps._public_ip_ban_response(client_ip, status_code=403)

        if code == "banned":
            return await ps._public_ip_ban_response(
                client_ip,
                status_code=403,
                fallback_seconds=int(decision.duration_seconds or 0),
            )

        return JSONResponse(
            status_code=429,
            content={"Error": True, "Msg": decision.message or "请求过于频繁，请稍后再试"},
        )
