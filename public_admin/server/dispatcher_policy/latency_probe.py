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

    async def probe_exit(self, exit_obj) -> dict:
        started = time.perf_counter()
        try:
            client = await exit_obj.get_client()
            for url in self.probe_urls:
                try:
                    response = await client.get(url, timeout=httpx.Timeout(self.timeout_seconds, connect=min(2.0, self.timeout_seconds)))
                    if 200 <= response.status_code < 400:
                        latency_ms = int((time.perf_counter() - started) * 1000)
                        return {'success': True, 'latency_ms': latency_ms, 'url': url, 'error': ''}
                except Exception as e:
                    last_error = str(e)
            return {'success': False, 'latency_ms': None, 'url': '', 'error': last_error if 'last_error' in locals() else 'probe failed'}
        except Exception as e:
            return {'success': False, 'latency_ms': None, 'url': '', 'error': str(e)}

    async def probe_all(self, exits: list) -> list[dict]:
        sem = asyncio.Semaphore(self.concurrency)

        async def _probe(index: int, exit_obj):
            async with sem:
                result = await self.probe_exit(exit_obj)
                result['index'] = index
                result['name'] = getattr(exit_obj, 'name', '')
                return result

        return await asyncio.gather(*[_probe(i, ex) for i, ex in enumerate(exits)], return_exceptions=False)
