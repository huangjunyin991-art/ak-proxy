import json
import time
from dataclasses import dataclass
from pathlib import Path

from .config import StaticResourceCacheConfig


@dataclass(frozen=True)
class StaticResourceMemoryPolicySnapshot:
    enabled: bool
    stats_enabled: bool
    max_entries: int
    max_bytes: int
    max_body_bytes: int
    updated_at: float


class StaticResourceMemoryPolicy:
    def __init__(self, root_dir: Path, defaults: StaticResourceCacheConfig):
        self.root_dir = Path(root_dir)
        self.config_path = self.root_dir / 'memory_policy.json'
        self.defaults = defaults
        self._snapshot = self._load()

    def snapshot(self) -> StaticResourceMemoryPolicySnapshot:
        return self._snapshot

    def to_dict(self) -> dict:
        item = self.snapshot()
        return {
            'enabled': bool(item.enabled),
            'stats_enabled': bool(item.stats_enabled),
            'max_entries': int(item.max_entries),
            'max_bytes': int(item.max_bytes),
            'max_body_bytes': int(item.max_body_bytes),
            'updated_at': float(item.updated_at),
        }

    def update(self, values: dict) -> StaticResourceMemoryPolicySnapshot:
        current = self.to_dict()
        if 'memory_enabled' in values:
            current['enabled'] = self._bool_value(values.get('memory_enabled'), current['enabled'])
        if 'memory_stats_enabled' in values:
            current['stats_enabled'] = self._bool_value(values.get('memory_stats_enabled'), current['stats_enabled'])
        if 'memory_max_entries' in values:
            current['max_entries'] = self._clamp_int(values.get('memory_max_entries'), 1, 20000, current['max_entries'])
        if 'memory_max_bytes' in values:
            current['max_bytes'] = self._clamp_int(values.get('memory_max_bytes'), 1024 * 1024, 1024 * 1024 * 1024, current['max_bytes'])
        if 'memory_max_body_bytes' in values:
            current['max_body_bytes'] = self._clamp_int(values.get('memory_max_body_bytes'), 16 * 1024, 128 * 1024 * 1024, current['max_body_bytes'])
        current['updated_at'] = time.time()
        self._snapshot = StaticResourceMemoryPolicySnapshot(**current)
        self._save()
        return self._snapshot

    def _load(self) -> StaticResourceMemoryPolicySnapshot:
        defaults = self._default_dict()
        try:
            data = json.loads(self.config_path.read_text(encoding='utf-8'))
            if isinstance(data, dict):
                defaults.update({key: data[key] for key in defaults.keys() if key in data})
        except Exception:
            pass
        return StaticResourceMemoryPolicySnapshot(
            enabled=self._bool_value(defaults.get('enabled'), True),
            stats_enabled=self._bool_value(defaults.get('stats_enabled'), True),
            max_entries=self._clamp_int(defaults.get('max_entries'), 1, 20000, self.defaults.memory_max_entries),
            max_bytes=self._clamp_int(defaults.get('max_bytes'), 1024 * 1024, 1024 * 1024 * 1024, self.defaults.memory_max_bytes),
            max_body_bytes=self._clamp_int(defaults.get('max_body_bytes'), 16 * 1024, 128 * 1024 * 1024, self.defaults.memory_max_body_bytes),
            updated_at=float(defaults.get('updated_at') or time.time()),
        )

    def _save(self) -> None:
        self.root_dir.mkdir(parents=True, exist_ok=True)
        temp_path = self.config_path.with_suffix('.json.tmp')
        temp_path.write_text(json.dumps(self.to_dict(), ensure_ascii=False, indent=2), encoding='utf-8')
        temp_path.replace(self.config_path)

    def _default_dict(self) -> dict:
        return {
            'enabled': bool(self.defaults.memory_enabled),
            'stats_enabled': bool(self.defaults.memory_stats_enabled),
            'max_entries': int(self.defaults.memory_max_entries),
            'max_bytes': int(self.defaults.memory_max_bytes),
            'max_body_bytes': int(self.defaults.memory_max_body_bytes),
            'updated_at': time.time(),
        }

    def _bool_value(self, value, default: bool) -> bool:
        if isinstance(value, bool):
            return value
        text = str(value).strip().lower()
        if text in {'1', 'true', 'yes', 'on'}:
            return True
        if text in {'0', 'false', 'no', 'off'}:
            return False
        return bool(default)

    def _clamp_int(self, value, minimum: int, maximum: int, default: int) -> int:
        try:
            result = int(value)
        except Exception:
            result = int(default)
        return max(int(minimum), min(int(maximum), result))
