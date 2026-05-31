"""
高性能限速封禁中间件。

工作流程（每个请求只走一次字典查找）：
  1. 从 proxy_server 全局获取 service 实例和回调
  2. 通过 path.startswith() + prefix 匹配找到对应规则（O(n_rules)，默认 2 条）
  3. 调用 service.check() 做计数 + 判定
  4. 若阻断/封禁，直接返回 HTTP 响应，不再往下执行
  5. 否则放行，继续后续路由
"""
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


class RateBanMiddleware(BaseHTTPMiddleware):
    # Paths excluded from rate limiting (middleware config + admin page itself)
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

        # Lazy reference to avoid import-time circular dependency
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
            logging.getLogger(__name__).warning(f"[RateBan] 检查异常，跳过: {exc}")
            return await call_next(request)

        code = decision.code
        if code in ("disabled", "anonymous", "loopback", "no_match", "ok"):
            return await call_next(request)

        if code == "already_banned":
            return JSONResponse(
                status_code=403,
                content={"Error": True, "Msg": decision.message or "您的IP已被封禁"},
            )

        if code == "banned":
            return JSONResponse(
                status_code=403,
                content={"Error": True, "Msg": decision.message or "请求过于频繁，您的IP已被封禁"},
            )

        return JSONResponse(
            status_code=429,
            content={"Error": True, "Msg": decision.message or "请求过于频繁，请稍后再试"},
        )
