import hashlib
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class SecurityContext:
    client_ip: str
    method: str
    path: str
    user_agent_hash: str
    request_id: str


def _hash_text(value: str) -> str:
    if not value:
        return ''
    return hashlib.sha256(value.encode('utf-8')).hexdigest()[:16]


def build_security_context(request: Any, client_ip: str = '') -> SecurityContext:
    headers = getattr(request, 'headers', {}) or {}
    method = getattr(request, 'method', '') or ''
    url = getattr(request, 'url', None)
    path = getattr(url, 'path', '') if url is not None else ''
    user_agent = headers.get('user-agent', '') if hasattr(headers, 'get') else ''
    request_id = headers.get('x-request-id', '') if hasattr(headers, 'get') else ''
    return SecurityContext(
        client_ip=client_ip,
        method=method,
        path=path,
        user_agent_hash=_hash_text(user_agent),
        request_id=_hash_text(request_id),
    )
