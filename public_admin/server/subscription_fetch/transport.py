"""Safe subscription retrieval through an already-running SOCKS5 tunnel."""

from __future__ import annotations

from urllib.parse import urljoin

import httpx

from ..security.url_fetch_gateway import UrlFetchError, UrlFetchGateway, UrlFetchPolicy


MAX_SUBSCRIPTION_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_SUBSCRIPTION_REDIRECTS = 3


def fetch_subscription_text_via_tunnel(
    url: str,
    timeout: int,
    user_agent: str,
    proxy_url: str,
) -> str:
    """Fetch one subscription representation through a local SOCKS5 exit.

    The proxy target is selected server-side from the dispatcher. User supplied
    URLs still receive the same public-address and redirect validation used by
    direct subscription retrieval.
    """
    normalized_proxy_url = str(proxy_url or "").strip()
    if not normalized_proxy_url.startswith("socks5://"):
        raise UrlFetchError("subscription tunnel is unavailable")

    gateway = UrlFetchGateway(
        UrlFetchPolicy(
            timeout_seconds=max(1, int(timeout or 15)),
            max_response_bytes=MAX_SUBSCRIPTION_RESPONSE_BYTES,
            max_redirects=MAX_SUBSCRIPTION_REDIRECTS,
        )
    )
    current_url = gateway.validate_url(url)
    redirects = 0
    request_timeout = httpx.Timeout(max(1, int(timeout or 15)))
    headers = {
        "User-Agent": str(user_agent or ""),
        "Accept": "*/*",
    }

    try:
        with httpx.Client(
            proxy=normalized_proxy_url,
            verify=True,
            timeout=request_timeout,
            trust_env=False,
            follow_redirects=False,
            http2=False,
        ) as client:
            while True:
                with client.stream("GET", current_url, headers=headers) as response:
                    status_code = int(response.status_code or 0)
                    if 300 <= status_code < 400:
                        location = str(response.headers.get("location") or "").strip()
                        if not location:
                            raise UrlFetchError("subscription redirect is missing a location")
                        redirects += 1
                        if redirects > MAX_SUBSCRIPTION_REDIRECTS:
                            raise UrlFetchError("subscription redirect limit exceeded")
                        current_url = gateway.validate_url(urljoin(current_url, location))
                        continue

                    chunks: list[bytes] = []
                    total_size = 0
                    for chunk in response.iter_bytes():
                        total_size += len(chunk)
                        if total_size > MAX_SUBSCRIPTION_RESPONSE_BYTES:
                            raise UrlFetchError("subscription response is too large")
                        chunks.append(chunk)
                    return b"".join(chunks).decode("utf-8", errors="replace").strip()
    except UrlFetchError:
        raise
    except httpx.HTTPError as exc:
        # Do not expose the subscription URL or token through errors or logs.
        raise UrlFetchError(f"subscription tunnel request failed ({type(exc).__name__})") from exc
