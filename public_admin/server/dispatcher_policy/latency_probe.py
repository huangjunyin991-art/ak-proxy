import asyncio
import time

import httpx


class LatencyProbeService:
    def __init__(self, probe_urls=None, timeout_seconds: float = 5.0, concurrency: int = 20):
        self.probe_urls = tuple(probe_urls or (
            'https://api4.ipify.org',
            'https://api.ip.sb/ip',
            'https://ipv4.icanhazip.com',
        ))
        self.timeout_seconds = timeout_seconds
        self.concurrency = concurrency

    async def probe_exit(self, exit_obj, request_semaphore: asyncio.Semaphore | None = None) -> dict:
        started = time.perf_counter()
        try:
            client = await exit_obj.get_client()
            last_error = 'probe failed'

            async def request(url: str):
                if request_semaphore is None:
                    return await client.get(
                        url,
                        timeout=httpx.Timeout(self.timeout_seconds, connect=min(2.0, self.timeout_seconds)),
                    )
                async with request_semaphore:
                    return await client.get(
                        url,
                        timeout=httpx.Timeout(self.timeout_seconds, connect=min(2.0, self.timeout_seconds)),
                    )

            tasks = [asyncio.create_task(request(url)) for url in self.probe_urls]
            try:
                for task in asyncio.as_completed(tasks):
                    try:
                        response = await task
                    except Exception as e:
                        last_error = str(e)
                        continue
                    if 200 <= response.status_code < 400:
                        latency_ms = int((time.perf_counter() - started) * 1000)
                        return {'success': True, 'latency_ms': latency_ms, 'url': str(response.url), 'error': ''}
                    last_error = f'HTTP {response.status_code}'
                return {'success': False, 'latency_ms': None, 'url': '', 'error': last_error}
            finally:
                for task in tasks:
                    if not task.done():
                        task.cancel()
                if tasks:
                    await asyncio.gather(*tasks, return_exceptions=True)
        except Exception as e:
            return {'success': False, 'latency_ms': None, 'url': '', 'error': str(e)}

    async def probe_all(self, exits: list) -> list[dict]:
        exit_semaphore = asyncio.Semaphore(self.concurrency)
        request_semaphore = asyncio.Semaphore(self.concurrency)

        async def _probe(index: int, exit_obj):
            async with exit_semaphore:
                result = await self.probe_exit(exit_obj, request_semaphore)
                result['index'] = index
                result['name'] = getattr(exit_obj, 'name', '')
                return result

        return await asyncio.gather(*[_probe(i, ex) for i, ex in enumerate(exits)], return_exceptions=False)
