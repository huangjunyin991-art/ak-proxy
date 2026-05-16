import asyncio
from typing import Callable, TypeVar


T = TypeVar('T')


class BlockingRunner:
    async def run(self, func: Callable[..., T], *args, **kwargs) -> T:
        return await asyncio.to_thread(func, *args, **kwargs)


_default_runner = BlockingRunner()


async def run_blocking(func: Callable[..., T], *args, **kwargs) -> T:
    return await _default_runner.run(func, *args, **kwargs)
