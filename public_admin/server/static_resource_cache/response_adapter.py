from fastapi.responses import Response

from .config import StaticResourceCacheConfig
from .models import CachedStaticResource


class StaticResourceResponseAdapter:
    def __init__(self, config: StaticResourceCacheConfig, browser_policy=None):
        self.config = config
        self.browser_policy = browser_policy

    def from_cached(self, resource: CachedStaticResource) -> Response:
        response = Response(
            content=resource.body,
            status_code=resource.status_code,
            headers=dict(resource.headers or {}),
            media_type=resource.content_type or 'application/octet-stream',
        )
        self.mark(response, 'HIT', resource.path, resource.content_type)
        return response

    def mark(self, response: Response, state: str, path: str = '', content_type: str = '') -> Response:
        response.headers['X-AK-Static-Cache'] = state
        if state in {'HIT', 'MISS'}:
            if self.browser_policy is None:
                response.headers['Cache-Control'] = f'public, max-age={self.config.browser_max_age_seconds}'
            else:
                response.headers['Cache-Control'] = self.browser_policy.browser_cache_control(path, content_type)
            if 'Pragma' in response.headers:
                del response.headers['Pragma']
            if 'Expires' in response.headers:
                del response.headers['Expires']
        return response
