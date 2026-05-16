import os
from dataclasses import dataclass


@dataclass(frozen=True)
class WorkerPolicy:
    count: int
    multi_worker_enabled: bool


def resolve_worker_policy(env_var: str = 'AK_PROXY_WORKERS') -> WorkerPolicy:
    try:
        count = max(1, int(os.environ.get(env_var, '1')))
    except Exception:
        count = 1
    return WorkerPolicy(count=count, multi_worker_enabled=count > 1)
