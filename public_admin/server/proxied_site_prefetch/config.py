from dataclasses import dataclass


@dataclass(frozen=True)
class ProxiedSitePrefetchConfig:
    enabled: bool = True
    home_path: str = 'pages/home.html'
    target_pages: tuple[str, ...] = (
        'pages/ace.list.html',
        'pages/ep.list.html',
        'pages/center.html',
    )
    allowed_site_prefixes: tuple[str, ...] = (
        '/admin/ak-web',
        '/admin/ak-site',
        '/ak-web',
    )
    start_delay_ms: int = 200
    concurrency_limit: int = 5
    max_resources: int = 180
    page_fetch_cache_mode: str = 'no-store'
    asset_fetch_cache_mode: str = 'force-cache'
    marker: str = 'window.__akProxiedSiteResourcePrefetchInstalled'
    started_marker: str = 'window.__akProxiedSiteResourcePrefetchStarted'


DEFAULT_PREFETCH_CONFIG = ProxiedSitePrefetchConfig()
