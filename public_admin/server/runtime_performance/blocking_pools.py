import os
import time
from threading import Lock
from typing import Any
from typing import Callable, TypeVar

from .blocking_runner import BlockingRunner, get_default_blocking_runner


T = TypeVar('T')


def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, str(default))))
    except Exception:
        return max(1, int(default))


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except Exception:
        return float(default)


_DEFAULT_SLOW_MS = _env_float('AK_BLOCKING_IO_SLOW_MS', 250.0)
_slow_ms = _DEFAULT_SLOW_MS
_policy_lock = Lock()

_POOL_SPECS = {
    'default': {
        'label': '默认阻塞 IO',
        'env': 'AK_BLOCKING_IO_CONCURRENCY',
        'default': 8,
        'min': 1,
        'max': 64,
        'description': '兼容旧 run_blocking 调用和未归类阻塞任务',
    },
    'asset_file': {
        'label': '资源文件读取',
        'env': 'AK_BLOCKING_ASSET_FILE_CONCURRENCY',
        'default': 16,
        'min': 1,
        'max': 64,
        'description': 'HTML/JS/CSS/插件资源等本地文件读取',
    },
    'static_cache': {
        'label': '静态缓存读写',
        'env': 'AK_BLOCKING_STATIC_CACHE_CONCURRENCY',
        'default': 8,
        'min': 1,
        'max': 32,
        'description': 'K937 静态资源磁盘缓存 body/meta 读写',
    },
    'diagnostics': {
        'label': '诊断扫描',
        'env': 'AK_BLOCKING_DIAGNOSTICS_CONCURRENCY',
        'default': 2,
        'min': 1,
        'max': 8,
        'description': '监控面板列表、缓存条目和轻量诊断扫描',
    },
    'maintenance': {
        'label': '后台维护',
        'env': 'AK_BLOCKING_MAINTENANCE_CONCURRENCY',
        'default': 1,
        'min': 1,
        'max': 4,
        'description': '过期清理和低优先级后台维护任务',
    },
}


_RUNNERS: dict[str, BlockingRunner] = {
    'default': get_default_blocking_runner(),
}


def _pool_default_concurrency(name: str) -> int:
    spec = _POOL_SPECS.get(name) or _POOL_SPECS['default']
    return _env_int(str(spec.get('env') or ''), int(spec.get('default') or 1))


def _clamp_int(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        normalized = int(value)
    except Exception:
        normalized = int(fallback)
    return max(int(minimum), min(int(maximum), normalized))


def _clamp_float(value: Any, fallback: float, minimum: float, maximum: float) -> float:
    try:
        normalized = float(value)
    except Exception:
        normalized = float(fallback)
    return max(float(minimum), min(float(maximum), normalized))


def normalize_blocking_pool_policy(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    source = payload or {}
    source_pools = source.get('pools') if isinstance(source.get('pools'), dict) else {}
    slow_ms = _clamp_float(source.get('slow_ms'), _DEFAULT_SLOW_MS, 20.0, 10000.0)
    pools: dict[str, dict[str, Any]] = {}
    for name, spec in _POOL_SPECS.items():
        item = source_pools.get(name) if isinstance(source_pools, dict) else None
        item = item if isinstance(item, dict) else {}
        minimum = int(spec.get('min') or 1)
        maximum = int(spec.get('max') or 64)
        default_value = _pool_default_concurrency(name)
        pools[name] = {
            'max_concurrency': _clamp_int(item.get('max_concurrency'), default_value, minimum, maximum),
        }
    return {
        'slow_ms': round(slow_ms, 2),
        'pools': pools,
    }


def get_blocking_pool_policy() -> dict[str, Any]:
    with _policy_lock:
        return normalize_blocking_pool_policy({
            'slow_ms': _slow_ms,
            'pools': {
                name: {'max_concurrency': _runner_for(name).snapshot().get('max_concurrency')}
                for name in _POOL_SPECS.keys()
            },
        })


def apply_blocking_pool_policy(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    global _slow_ms
    policy = normalize_blocking_pool_policy(payload)
    with _policy_lock:
        _slow_ms = float(policy.get('slow_ms') or _DEFAULT_SLOW_MS)
        pools = policy.get('pools') or {}
        for name in _POOL_SPECS.keys():
            item = pools.get(name) or {}
            _runner_for(name).configure(
                max_concurrency=int(item.get('max_concurrency') or _pool_default_concurrency(name)),
                slow_ms=_slow_ms,
            )
    return policy


def _runner_for(pool_name: str) -> BlockingRunner:
    name = str(pool_name or 'default')
    if name == 'default':
        return _RUNNERS['default']
    spec = _POOL_SPECS.get(name) or _POOL_SPECS['default']
    if name not in _RUNNERS:
        _RUNNERS[name] = BlockingRunner(
            max_concurrency=_pool_default_concurrency(name),
            slow_ms=_slow_ms,
            name=name,
            label=str(spec.get('label') or name),
        )
    return _RUNNERS[name]


async def run_blocking_pool(pool_name: str, func: Callable[..., T], *args, **kwargs) -> T:
    return await _runner_for(pool_name).run(func, *args, **kwargs)


async def run_blocking_asset_file(func: Callable[..., T], *args, **kwargs) -> T:
    return await run_blocking_pool('asset_file', func, *args, **kwargs)


async def run_blocking_static_cache(func: Callable[..., T], *args, **kwargs) -> T:
    return await run_blocking_pool('static_cache', func, *args, **kwargs)


async def run_blocking_diagnostics(func: Callable[..., T], *args, **kwargs) -> T:
    return await run_blocking_pool('diagnostics', func, *args, **kwargs)


async def run_blocking_maintenance(func: Callable[..., T], *args, **kwargs) -> T:
    return await run_blocking_pool('maintenance', func, *args, **kwargs)


def get_blocking_pools_snapshot() -> dict:
    pools = []
    for name, spec in _POOL_SPECS.items():
        snapshot = _runner_for(name).snapshot()
        snapshot['description'] = str(spec.get('description') or '')
        snapshot['env'] = str(spec.get('env') or '')
        snapshot['limits'] = {
            'min': int(spec.get('min') or 1),
            'max': int(spec.get('max') or 64),
            'default': _pool_default_concurrency(name),
        }
        snapshot['recommendation'] = _build_pool_recommendation(snapshot)
        pools.append(snapshot)

    total_max = sum(int(pool.get('max_concurrency') or 0) for pool in pools)
    total_in_flight = sum(int(pool.get('in_flight') or 0) for pool in pools)
    total_waiting = sum(int(pool.get('waiting') or 0) for pool in pools)
    total_completed = sum(int(pool.get('completed') or 0) for pool in pools)
    total_failed = sum(int(pool.get('failed') or 0) for pool in pools)
    total_slow = sum(int(pool.get('slow_count') or 0) for pool in pools)
    saturated = [pool for pool in pools if pool.get('status') == 'saturated']

    return {
        'generated_at': time.time(),
        'slow_ms': round(_slow_ms, 2),
        'policy': get_blocking_pool_policy(),
        'limits': {
            'slow_ms': {'min': 20, 'max': 10000, 'default': round(_DEFAULT_SLOW_MS, 2)},
            'pools': {
                name: {
                    'min': int(spec.get('min') or 1),
                    'max': int(spec.get('max') or 64),
                    'default': _pool_default_concurrency(name),
                }
                for name, spec in _POOL_SPECS.items()
            },
        },
        'summary': {
            'pool_count': len(pools),
            'max_concurrency': total_max,
            'in_flight': total_in_flight,
            'waiting': total_waiting,
            'completed': total_completed,
            'failed': total_failed,
            'slow_count': total_slow,
            'saturated_pools': len(saturated),
        },
        'pools': pools,
    }


def _build_pool_recommendation(pool: dict[str, Any]) -> dict[str, Any]:
    status = str(pool.get('status') or '')
    waiting = int(pool.get('waiting') or 0)
    max_concurrency = int(pool.get('max_concurrency') or 1)
    max_limit = int((pool.get('limits') or {}).get('max') or max_concurrency)
    max_queue_ms = float(pool.get('max_queue_ms') or 0)
    avg_queue_ms = float(pool.get('avg_queue_ms') or 0)
    if status == 'saturated' or waiting > 0:
        if max_concurrency < max_limit:
            suggested = min(max_limit, max_concurrency + max(1, int(max_concurrency * 0.25)))
            return {
                'level': 'warning',
                'message': '该池存在等待任务，可考虑小幅提高并发上限。',
                'suggested_max_concurrency': suggested,
            }
        return {
            'level': 'danger',
            'message': '该池已经达到安全上限且仍有等待任务，需要排查调用点或降低后台任务频率。',
        }
    if max_queue_ms >= _slow_ms or avg_queue_ms >= max(20.0, _slow_ms * 0.5):
        return {
            'level': 'info',
            'message': '排队耗时偏高但暂无实时等待，建议继续观察峰值时段。',
        }
    return {
        'level': 'ok',
        'message': '当前池没有明显排队压力。',
    }
