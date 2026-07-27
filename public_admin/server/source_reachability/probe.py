from __future__ import annotations

import os
import time
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx


DEFAULT_SOURCE_PROBE_URL = "https://www.akapi1.com/RPC/"
SOURCE_PROBE_URL_ENV = "DISPATCHER_SOURCE_PROBE_URL"
SOURCE_PROBE_USER_AGENT = "AK-Proxy-Source-Probe/1.0"


@dataclass(frozen=True)
class SourceProbeResult:
    reachable: bool
    status_code: int | None
    error: str
    elapsed_ms: int


class SourceReachabilityProbe:
    """Performs a credential-free request to the business source through one exit."""

    def __init__(
        self,
        probe_url: str | None = None,
        timeout_seconds: float = 10.0,
        connect_timeout_seconds: float = 5.0,
    ) -> None:
        self.probe_url = self._resolve_probe_url(probe_url)
        self.timeout_seconds = max(3.0, min(float(timeout_seconds or 10.0), 30.0))
        self.connect_timeout_seconds = max(
            1.0,
            min(self.timeout_seconds, float(connect_timeout_seconds or 5.0)),
        )

    async def probe(
        self,
        client: httpx.AsyncClient,
        *,
        timeout_seconds: float | None = None,
        connect_timeout_seconds: float | None = None,
    ) -> SourceProbeResult:
        started_at = time.perf_counter()
        request_timeout = self._bounded_timeout(timeout_seconds, self.timeout_seconds)
        connect_timeout = self._bounded_connect_timeout(
            connect_timeout_seconds,
            request_timeout,
            self.connect_timeout_seconds,
        )
        try:
            response = await client.get(
                self.probe_url,
                headers={
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "User-Agent": SOURCE_PROBE_USER_AGENT,
                    "Cache-Control": "no-cache",
                },
                follow_redirects=True,
                timeout=httpx.Timeout(
                    request_timeout,
                    connect=connect_timeout,
                ),
            )
        except Exception as exc:
            return SourceProbeResult(
                reachable=False,
                status_code=None,
                error=self._error_text(exc),
                elapsed_ms=self._elapsed_ms(started_at),
            )

        status_code = int(response.status_code or 0)
        return SourceProbeResult(
            reachable=self._is_reachable_status(status_code),
            status_code=status_code,
            error="" if self._is_reachable_status(status_code) else f"HTTP {status_code}",
            elapsed_ms=self._elapsed_ms(started_at),
        )

    @staticmethod
    def _resolve_probe_url(probe_url: str | None) -> str:
        candidate = str(probe_url or os.environ.get(SOURCE_PROBE_URL_ENV) or DEFAULT_SOURCE_PROBE_URL).strip()
        parsed = urlparse(candidate)
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            return candidate
        return DEFAULT_SOURCE_PROBE_URL

    @staticmethod
    def _is_reachable_status(status_code: int) -> bool:
        # /RPC/ deliberately returns 403 without credentials.  It still proves
        # that this exact exit can reach the business source.  429 and 5xx are
        # kept unavailable because they are unsafe for real upstream traffic.
        return 200 <= int(status_code or 0) < 500 and int(status_code or 0) != 429

    @staticmethod
    def _elapsed_ms(started_at: float) -> int:
        return max(0, int((time.perf_counter() - started_at) * 1000))

    @staticmethod
    def _bounded_timeout(value: float | None, fallback: float) -> float:
        return max(3.0, min(float(value or fallback), 30.0))

    @staticmethod
    def _bounded_connect_timeout(value: float | None, request_timeout: float, fallback: float) -> float:
        return max(1.0, min(request_timeout, float(value or fallback)))

    @staticmethod
    def _error_text(exc: Exception) -> str:
        message = str(exc).strip() or exc.__class__.__name__
        return message[:240]
