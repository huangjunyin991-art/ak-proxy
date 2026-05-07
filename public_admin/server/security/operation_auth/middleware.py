from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse


class OperationAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, *, service, resolver, resolve_admin_identity):
        super().__init__(app)
        self.service = service
        self.resolver = resolver
        self.resolve_admin_identity = resolve_admin_identity

    async def dispatch(self, request, call_next):
        body = None
        downstream_request = request
        if self.resolver.needs_body(request.method, request.url.path):
            body = await request.body()
            downstream_request = self._clone_request_with_body(request, body)
        scope = self.resolver.resolve(request.method, request.url.path, body=body)
        if not scope:
            return await call_next(downstream_request)
        admin_token, role, identity = await self.resolve_admin_identity(request)
        if not admin_token or not role:
            return JSONResponse(status_code=401, content={
                'error': True,
                'message': '未授权',
            })
        sub_name = '' if identity == '__super__' else identity
        lease_token = str(request.headers.get('X-Operation-Lease') or '').strip()
        if await self.service.verify_lease(admin_token, role, sub_name, scope, lease_token):
            return await call_next(downstream_request)
        return JSONResponse(status_code=403, content={
            'error': True,
            'code': 'NEED_OPERATION_AUTH',
            'message': '该操作需要 Google 验证码授权',
            'scope': scope,
            'max_lease_seconds': self.service.MAX_LEASE_SECONDS,
            'default_lease_seconds': self.service.DEFAULT_LEASE_SECONDS,
        })

    def _clone_request_with_body(self, request, body: bytes):
        async def receive():
            return {'type': 'http.request', 'body': body, 'more_body': False}
        return Request(request.scope, receive)
