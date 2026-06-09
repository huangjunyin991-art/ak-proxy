import os
import time
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


_SLOW_MS = _env_float('AK_BLOCKING_IO_SLOW_MS', 250.0)

_POOL_SPECS = {
    'default': {
        'label': '默认阻塞 IO',
        'env': 'AK_BLOCKING_IO_CONCURRENCY',
        'default': 8,
        'description': '兼容旧 run_blocking 调用和未归类阻塞任务',
    },
    'asset_file': {
        'label': '资源文件读取',
        'env': 'AK_BLOCKING_ASSET_FILE_CONCURRENCY',
        'default': 16,
        'description': 'HTML/JS/CSS/插件资源等本地文件读取',
    },
    'static_cache': {
        'label': '静态缓存读写',
        'env': 'AK_BLOCKING_STATIC_CACHE_CONCURRENCY',
        'default': 8,
        'description': 'K937 静态资源磁盘缓存 body/meta 读写',
    },
    'diagnostics': {
        'label': '诊断扫描',
        'env': 'AK_BLOCKING_DIAGNOSTICS_CONCURRENCY',
        'default': 2,
        'description': '监控面板列表、缓存条目和轻量诊断扫描',
    },
    'maintenance': {
        'label': '后台维护',
        'env': 'AK_BLOCKING_MAINTENANCE_CONCURRENCY',
        'default': 1,
        'description': '过期清理和低优先级后台维护任务',
    },
}


_RUNNERS: dict[str, BlockingRunner] = {
    'default': get_default_blocking_runner(),
}


def _runner_for(pool_name: str) -> BlockingRunner:
    name = str(pool_name or 'default')
    if name == 'default':
        return _RUNNERS['default']
    spec = _POOL_SPECS.get(name) or _POOL_SPECS['default']
    if name not in _RUNNERS:
        _RUNNERS[name] = BlockingRunner(
            max_concurrency=_env_int(str(spec.get('env') or ''), int(spec.get('default') or 1)),
            slow_ms=_SLOW_MS,
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
        'slow_ms': round(_SLOW_MS, 2),
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
