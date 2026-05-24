from .config import ProxiedSitePrefetchConfig


class ProxiedSitePrefetchPolicy:
    def __init__(self, config: ProxiedSitePrefetchConfig):
        self.config = config

    def should_inject(self, normalized_path: str, site_prefix: str, content_type: str) -> bool:
        if not self.config.enabled:
            return False
        if str(normalized_path or '').strip().lower() != self.config.home_path:
            return False
        if site_prefix not in self.config.allowed_site_prefixes:
            return False
        return 'text/html' in str(content_type or '').lower()
