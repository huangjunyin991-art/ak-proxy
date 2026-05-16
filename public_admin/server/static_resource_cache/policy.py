import os
from urllib.parse import parse_qs, urlsplit

from .config import StaticResourceCacheConfig
from .models import StaticResourcePayload, StaticResourceRequest


class StaticResourceCachePolicy:
    def __init__(self, config: StaticResourceCacheConfig):
        self.config = config

    def can_read(self, request: StaticResourceRequest) -> bool:
        if str(request.method or '').upper() not in self.config.allowed_methods:
            return False
        url_parts = urlsplit(request.url)
        hostname = str(url_parts.hostname or '').lower()
        if hostname not in self.config.allowed_hosts:
            return False
        path = self._normalized_path(request.path or urlsplit(request.url).path)
        if not path or path.endswith('/') or path.startswith('/rpc/'):
            return False
        if path.startswith('/pages/') and path.endswith('.html'):
            return False
        if os.path.splitext(path)[1] not in self.config.allowed_extensions:
            return False
        query = parse_qs(urlsplit(request.url).query, keep_blank_values=True)
        return not any(str(key).lower() in self.config.denied_query_keys for key in query.keys())

    def can_store(self, request: StaticResourceRequest, payload: StaticResourcePayload) -> bool:
        if not self.can_read(request):
            return False
        if int(payload.status_code) not in self.config.allowed_status_codes:
            return False
        body = payload.body or b''
        if not body or len(body) > self.config.max_body_bytes:
            return False
        content_type = str(payload.content_type or '').lower()
        if 'text/html' in content_type or 'application/json' in content_type:
            return False
        headers = {str(k).lower(): str(v) for k, v in dict(payload.policy_headers or {}).items()}
        if 'set-cookie' in headers:
            return False
        cache_control = headers.get('cache-control', '').lower()
        if 'no-store' in cache_control or 'private' in cache_control:
            return False
        return True

    def _normalized_path(self, path: str) -> str:
        value = str(path or '').split('?', 1)[0].lower()
        return value if value.startswith('/') else '/' + value
