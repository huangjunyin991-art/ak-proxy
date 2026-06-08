from __future__ import annotations

import asyncio
import ipaddress
import socket
from dataclasses import dataclass
from typing import Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse, urlunparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class UrlFetchError(ValueError):
    """Raised when an outbound URL violates the safe-fetch policy."""


@dataclass(frozen=True)
class UrlFetchPolicy:
    allowed_schemes: tuple[str, ...] = ("https", "http")
    max_redirects: int = 3
    timeout_seconds: int = 8
    max_response_bytes: int = 128 * 1024
    require_global_ip: bool = True


@dataclass(frozen=True)
class UrlFetchResponse:
    url: str
    status_code: int
    headers: Mapping[str, str]
    body: bytes

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class UrlFetchGateway:
    """Small SSRF-aware gateway for user-configurable outbound HTTP calls."""

    _BLOCKED_HOSTNAMES = {
        "localhost",
        "localhost.localdomain",
        "metadata.google.internal",
    }

    def __init__(self, policy: UrlFetchPolicy | None = None):
        self.policy = policy or UrlFetchPolicy()

    def normalize_url(self, url: str) -> str:
        text = str(url or "").strip()
        if not text:
            raise UrlFetchError("URL 为空")
        parsed = urlparse(text)
        scheme = parsed.scheme.lower()
        if scheme not in self.policy.allowed_schemes:
            raise UrlFetchError("URL 协议不允许")
        if not parsed.hostname:
            raise UrlFetchError("URL 缺少主机名")
        if parsed.username or parsed.password:
            raise UrlFetchError("URL 不允许包含用户名或密码")
        hostname = parsed.hostname.strip().lower().rstrip(".")
        if hostname in self._BLOCKED_HOSTNAMES:
            raise UrlFetchError("URL 主机不允许访问")
        port = self._port_for(parsed)
        normalized_netloc = hostname
        if ":" in hostname and not hostname.startswith("["):
            normalized_netloc = f"[{hostname}]"
        default_port = 443 if scheme == "https" else 80
        if port != default_port:
            normalized_netloc = f"{normalized_netloc}:{port}"
        path = parsed.path or "/"
        return urlunparse((scheme, normalized_netloc, path, "", parsed.query, ""))

    def validate_url(self, url: str) -> str:
        normalized = self.normalize_url(url)
        parsed = urlparse(normalized)
        self._validate_resolved_addresses(parsed.hostname or "", self._port_for(parsed))
        return normalized.rstrip("/")

    async def request(
        self,
        url: str,
        *,
        method: str = "GET",
        headers: Mapping[str, str] | None = None,
        body: bytes | str | None = None,
    ) -> UrlFetchResponse:
        payload: bytes | None
        if isinstance(body, str):
            payload = body.encode("utf-8")
        else:
            payload = body
        return await asyncio.to_thread(
            self._request_sync,
            url,
            method=str(method or "GET").upper(),
            headers=dict(headers or {}),
            body=payload,
        )

    def request_sync(
        self,
        url: str,
        *,
        method: str = "GET",
        headers: Mapping[str, str] | None = None,
        body: bytes | str | None = None,
    ) -> UrlFetchResponse:
        payload: bytes | None
        if isinstance(body, str):
            payload = body.encode("utf-8")
        else:
            payload = body
        return self._request_sync(
            url,
            method=str(method or "GET").upper(),
            headers=dict(headers or {}),
            body=payload,
        )

    def _request_sync(self, url: str, *, method: str, headers: dict[str, str], body: bytes | None) -> UrlFetchResponse:
        current_url = self.validate_url(url)
        opener = build_opener(ProxyHandler({}), _NoRedirectHandler())
        redirects = 0
        while True:
            request = Request(current_url, data=body, headers=headers, method=method)
            try:
                response = opener.open(request, timeout=max(1, int(self.policy.timeout_seconds or 8)))
            except HTTPError as exc:
                if 300 <= int(exc.code or 0) < 400:
                    location = exc.headers.get("Location") or ""
                    if not location:
                        raise UrlFetchError("重定向缺少 Location")
                    redirects += 1
                    if redirects > max(0, int(self.policy.max_redirects or 0)):
                        raise UrlFetchError("重定向次数过多")
                    current_url = self.validate_url(urljoin(current_url, location))
                    method = "GET"
                    body = None
                    continue
                response = exc
            except URLError as exc:
                raise UrlFetchError(f"URL 请求失败: {exc.reason}") from exc
            except TimeoutError as exc:
                raise UrlFetchError("URL 请求超时") from exc

            with response:
                status_code = int(getattr(response, "status", 0) or response.getcode() or 0)
                raw_headers = {str(k): str(v) for k, v in response.headers.items()}
                body_bytes = response.read(max(1, int(self.policy.max_response_bytes or 0)) + 1)
            if len(body_bytes) > max(1, int(self.policy.max_response_bytes or 0)):
                raise UrlFetchError("URL 响应体过大")
            return UrlFetchResponse(
                url=current_url,
                status_code=status_code,
                headers=raw_headers,
                body=body_bytes,
            )

    def _validate_resolved_addresses(self, hostname: str, port: int) -> None:
        host = str(hostname or "").strip().lower().rstrip(".")
        if not host:
            raise UrlFetchError("URL 缺少主机名")
        literal = self._parse_ip_literal(host)
        addresses = [literal] if literal is not None else self._resolve_host(host, port)
        if not addresses:
            raise UrlFetchError("URL 主机无法解析")
        for address in addresses:
            if self.policy.require_global_ip and not address.is_global:
                raise UrlFetchError("URL 解析到非公网地址，已拒绝")

    def _resolve_host(self, hostname: str, port: int) -> list[ipaddress._BaseAddress]:
        try:
            records = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
        except OSError as exc:
            raise UrlFetchError("URL 主机解析失败") from exc
        result: list[ipaddress._BaseAddress] = []
        seen = set()
        for record in records:
            sockaddr = record[4]
            raw_ip = str(sockaddr[0] if sockaddr else "").strip()
            if not raw_ip or raw_ip in seen:
                continue
            seen.add(raw_ip)
            parsed = self._parse_ip_literal(raw_ip)
            if parsed is not None:
                result.append(parsed)
        return result

    def _port_for(self, parsed) -> int:
        try:
            port = int(parsed.port or (443 if parsed.scheme.lower() == "https" else 80))
        except ValueError as exc:
            raise UrlFetchError("URL 端口无效") from exc
        if port <= 0 or port > 65535:
            raise UrlFetchError("URL 端口无效")
        return port

    @staticmethod
    def _parse_ip_literal(value: str):
        text = str(value or "").strip().strip("[]")
        try:
            return ipaddress.ip_address(text)
        except ValueError:
            return None
