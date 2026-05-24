import json
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


@dataclass(frozen=True)
class StaticResourceBrowserPolicySnapshot:
    js_browser_max_age_seconds: int
    css_browser_max_age_seconds: int
    media_browser_max_age_seconds: int
    js_disk_ttl_seconds: int
    css_disk_ttl_seconds: int
    media_disk_ttl_seconds: int
    stale_while_revalidate_seconds: int
    version: str
    updated_at: float


class StaticResourceBrowserPolicy:
    js_extensions = {'.js', '.mjs', '.wasm', '.map'}
    css_extensions = {'.css'}
    media_extensions = {
        '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
        '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.webm',
    }

    def __init__(self, root_dir: Path):
        self.root_dir = Path(root_dir)
        self.config_path = self.root_dir / 'browser_policy.json'
        self._snapshot = self._load()

    def snapshot(self) -> StaticResourceBrowserPolicySnapshot:
        return self._snapshot

    def to_dict(self) -> dict:
        item = self.snapshot()
        return {
            'js_browser_max_age_seconds': item.js_browser_max_age_seconds,
            'css_browser_max_age_seconds': item.css_browser_max_age_seconds,
            'media_browser_max_age_seconds': item.media_browser_max_age_seconds,
            'js_disk_ttl_seconds': item.js_disk_ttl_seconds,
            'css_disk_ttl_seconds': item.css_disk_ttl_seconds,
            'media_disk_ttl_seconds': item.media_disk_ttl_seconds,
            'stale_while_revalidate_seconds': item.stale_while_revalidate_seconds,
            'version': item.version,
            'updated_at': item.updated_at,
        }

    def update(self, values: dict) -> StaticResourceBrowserPolicySnapshot:
        current = self.to_dict()
        for key in (
            'js_browser_max_age_seconds', 'css_browser_max_age_seconds', 'media_browser_max_age_seconds',
            'js_disk_ttl_seconds', 'css_disk_ttl_seconds', 'media_disk_ttl_seconds',
            'stale_while_revalidate_seconds',
        ):
            if key in values:
                current[key] = self._clamp_seconds(values.get(key), key)
        current['updated_at'] = time.time()
        self._snapshot = StaticResourceBrowserPolicySnapshot(**current)
        self._save()
        return self._snapshot

    def refresh_version(self) -> StaticResourceBrowserPolicySnapshot:
        current = self.to_dict()
        next_version = str(int(time.time()))
        if next_version <= str(current.get('version') or ''):
            try:
                next_version = str(int(current.get('version') or 0) + 1)
            except Exception:
                next_version = str(int(time.time() * 1000))
        current['version'] = next_version
        current['updated_at'] = time.time()
        self._snapshot = StaticResourceBrowserPolicySnapshot(**current)
        self._save()
        return self._snapshot

    def browser_cache_control(self, path: str, content_type: str = '') -> str:
        ext = self._extension(path, content_type)
        max_age = self.browser_max_age_seconds(path, content_type)
        if ext in self.media_extensions:
            return f'public, max-age={max_age}, immutable'
        stale = max(0, int(self.snapshot().stale_while_revalidate_seconds))
        if stale > 0:
            return f'public, max-age={max_age}, stale-while-revalidate={stale}'
        return f'public, max-age={max_age}'

    def browser_max_age_seconds(self, path: str, content_type: str = '') -> int:
        ext = self._extension(path, content_type)
        item = self.snapshot()
        if ext in self.css_extensions:
            return item.css_browser_max_age_seconds
        if ext in self.media_extensions:
            return item.media_browser_max_age_seconds
        return item.js_browser_max_age_seconds

    def disk_ttl_seconds(self, path: str, content_type: str = '') -> int:
        ext = self._extension(path, content_type)
        item = self.snapshot()
        if ext in self.css_extensions:
            return item.css_disk_ttl_seconds
        if ext in self.media_extensions:
            return item.media_disk_ttl_seconds
        return item.js_disk_ttl_seconds

    def version_url(self, url: str) -> str:
        version = str(self.snapshot().version or '').strip()
        if not url or not version:
            return url
        try:
            parsed = urlsplit(url)
            if not parsed.path or parsed.path.endswith('/'):
                return url
            if self._extension(parsed.path, '') not in self.js_extensions | self.css_extensions | self.media_extensions:
                return url
            pairs = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True) if k != 'ak_static_v']
            pairs.append(('ak_static_v', version))
            return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(pairs, doseq=True), parsed.fragment))
        except Exception:
            return url

    def clear_storage(self) -> int:
        removed = 0
        root = self.root_dir
        if not root.exists():
            return 0
        for item in root.iterdir():
            if item == self.config_path:
                continue
            try:
                if item.is_dir():
                    shutil.rmtree(item)
                else:
                    item.unlink(missing_ok=True)
                removed += 1
            except Exception:
                continue
        return removed

    def _load(self) -> StaticResourceBrowserPolicySnapshot:
        default = self._default_dict()
        try:
            data = json.loads(self.config_path.read_text(encoding='utf-8'))
            if isinstance(data, dict):
                default.update({key: data[key] for key in default.keys() if key in data})
        except Exception:
            pass
        normalized = {
            'js_browser_max_age_seconds': self._clamp_seconds(default.get('js_browser_max_age_seconds'), 'js_browser_max_age_seconds'),
            'css_browser_max_age_seconds': self._clamp_seconds(default.get('css_browser_max_age_seconds'), 'css_browser_max_age_seconds'),
            'media_browser_max_age_seconds': self._clamp_seconds(default.get('media_browser_max_age_seconds'), 'media_browser_max_age_seconds'),
            'js_disk_ttl_seconds': self._clamp_seconds(default.get('js_disk_ttl_seconds'), 'js_disk_ttl_seconds'),
            'css_disk_ttl_seconds': self._clamp_seconds(default.get('css_disk_ttl_seconds'), 'css_disk_ttl_seconds'),
            'media_disk_ttl_seconds': self._clamp_seconds(default.get('media_disk_ttl_seconds'), 'media_disk_ttl_seconds'),
            'stale_while_revalidate_seconds': self._clamp_seconds(default.get('stale_while_revalidate_seconds'), 'stale_while_revalidate_seconds'),
            'version': str(default.get('version') or int(time.time())),
            'updated_at': float(default.get('updated_at') or time.time()),
        }
        return StaticResourceBrowserPolicySnapshot(**normalized)

    def _save(self) -> None:
        self.root_dir.mkdir(parents=True, exist_ok=True)
        temp_path = self.config_path.with_suffix('.json.tmp')
        temp_path.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding='utf-8')
        temp_path.replace(self.config_path)

    def _default_dict(self) -> dict:
        now = time.time()
        return {
            'js_browser_max_age_seconds': 24 * 60 * 60,
            'css_browser_max_age_seconds': 7 * 24 * 60 * 60,
            'media_browser_max_age_seconds': 30 * 24 * 60 * 60,
            'js_disk_ttl_seconds': 7 * 24 * 60 * 60,
            'css_disk_ttl_seconds': 7 * 24 * 60 * 60,
            'media_disk_ttl_seconds': 30 * 24 * 60 * 60,
            'stale_while_revalidate_seconds': 7 * 24 * 60 * 60,
            'version': str(int(now)),
            'updated_at': now,
        }

    def _clamp_seconds(self, value, key: str) -> int:
        defaults = self._default_dict()
        try:
            seconds = int(value)
        except Exception:
            seconds = int(defaults[key])
        if key == 'stale_while_revalidate_seconds':
            return max(0, min(seconds, 30 * 24 * 60 * 60))
        return max(60, min(seconds, 365 * 24 * 60 * 60))

    def _extension(self, path: str, content_type: str = '') -> str:
        value = str(path or '').split('?', 1)[0].lower()
        suffix = Path(value).suffix
        if suffix:
            return suffix
        content = str(content_type or '').lower()
        if 'css' in content:
            return '.css'
        if 'javascript' in content or 'ecmascript' in content:
            return '.js'
        return '.js'
