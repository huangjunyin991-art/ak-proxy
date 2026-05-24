from .config import DEFAULT_PREFETCH_CONFIG, ProxiedSitePrefetchConfig
from .policy import ProxiedSitePrefetchPolicy
from .script_builder import ProxiedSitePrefetchScriptBuilder


class ProxiedSitePrefetchHtmlTransformer:
    def __init__(self, config: ProxiedSitePrefetchConfig = DEFAULT_PREFETCH_CONFIG):
        self.config = config
        self.policy = ProxiedSitePrefetchPolicy(config)
        self.script_builder = ProxiedSitePrefetchScriptBuilder(config)

    def transform(self, text: str, normalized_path: str, site_prefix: str, content_type: str) -> tuple[str, bool]:
        if not text:
            return text, False
        if self.config.marker in text:
            return text, False
        if not self.policy.should_inject(normalized_path, site_prefix, content_type):
            return text, False
        script = self.script_builder.build(site_prefix)
        return self._inject_script(text, script), True

    def _inject_script(self, text: str, script: str) -> str:
        if '</body>' in text:
            return text.replace('</body>', script + '</body>', 1)
        if '</html>' in text:
            return text.replace('</html>', script + '</html>', 1)
        return text + script


_default_transformer = ProxiedSitePrefetchHtmlTransformer()


def transform_html(text: str, normalized_path: str, site_prefix: str, content_type: str) -> tuple[str, bool]:
    return _default_transformer.transform(text, normalized_path, site_prefix, content_type)
