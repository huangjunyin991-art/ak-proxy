from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class StaticResourceCacheConfig:
    root_dir: Path
    ttl_seconds: int = 2 * 60 * 60
    browser_max_age_seconds: int = 2 * 60 * 60
    max_body_bytes: int = 30 * 1024 * 1024
    cleanup_interval_seconds: int = 30 * 60
    allowed_status_codes: set[int] = field(default_factory=lambda: {200})
    allowed_methods: set[str] = field(default_factory=lambda: {'GET'})
    allowed_hosts: set[str] = field(default_factory=lambda: {'k937.com'})
    allowed_extensions: set[str] = field(default_factory=lambda: {
        '.js', '.mjs', '.css',
        '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
        '.woff', '.woff2', '.ttf', '.otf', '.eot',
        '.mp3', '.mp4', '.webm', '.wasm', '.map',
    })
    denied_query_keys: set[str] = field(default_factory=lambda: {
        'token', 'auth', 'session', 'sid', 'key', 'userkey', 'userid', 'user_id', 'bs',
    })
