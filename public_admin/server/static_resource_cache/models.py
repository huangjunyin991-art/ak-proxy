from dataclasses import dataclass
from typing import Mapping


@dataclass(frozen=True)
class StaticResourceRequest:
    method: str
    namespace: str
    url: str
    path: str


@dataclass(frozen=True)
class StaticResourcePayload:
    status_code: int
    headers: Mapping[str, str]
    policy_headers: Mapping[str, str]
    content_type: str
    body: bytes


@dataclass(frozen=True)
class CachedStaticResource:
    cache_key: str
    path: str
    status_code: int
    headers: dict[str, str]
    content_type: str
    body: bytes
    created_at: float
    expires_at: float
