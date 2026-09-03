"""Trusted reverse-proxy client origin resolution for active defense."""

from __future__ import annotations

import ipaddress
from collections.abc import Iterable, Mapping


DEFAULT_TRUSTED_PROXY_CIDRS = ("127.0.0.0/8", "::1/128")
_UNKNOWN_CLIENT_IP = "unknown"

# Cloudflare publishes these edge ranges at https://www.cloudflare.com/ips/.
# An edge address identifies a shared reverse proxy, never an individual user.
CLOUDFLARE_EDGE_CIDRS = (
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22",
    "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18",
    "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22",
    "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
    "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32",
    "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29",
    "2c0f:f248::/32",
)
_CLOUDFLARE_EDGE_NETWORKS = tuple(ipaddress.ip_network(value) for value in CLOUDFLARE_EDGE_CIDRS)


def is_cloudflare_edge_ip(value: str) -> bool:
    """Return whether an address belongs to Cloudflare's shared edge fleet."""
    try:
        address = ipaddress.ip_address(str(value or "").strip())
    except ValueError:
        return False
    return any(address in network for network in _CLOUDFLARE_EDGE_NETWORKS)


class RequestOriginResolver:
    """Accept forwarded client headers only from the local reverse proxy.

    Nginx overwrites ``X-Real-IP`` before it forwards to the loopback-bound
    application. A direct caller must therefore never be able to pick the IP
    bucket used by active-defense rules with a forged forwarding header.
    """

    def __init__(self, trusted_proxy_cidrs: Iterable[str] = DEFAULT_TRUSTED_PROXY_CIDRS) -> None:
        self._trusted_proxy_networks = tuple(
            network
            for value in trusted_proxy_cidrs
            if (network := self._parse_network(value)) is not None
        )

    def resolve(self, headers: Mapping[str, str], peer_host: str) -> str:
        peer_ip = self._normalize_ip(peer_host)
        if peer_ip is None:
            return "unknown"
        if not self._is_trusted_proxy(peer_ip):
            return str(peer_ip)

        real_ip = self._normalize_ip(headers.get("x-real-ip", ""))
        if real_ip is not None and not real_ip.is_loopback:
            if is_cloudflare_edge_ip(str(real_ip)):
                # A missing Nginx real-IP configuration must fail closed for
                # penalties. Otherwise unrelated users on one Cloudflare POP
                # are placed into the same login-ban bucket.
                return _UNKNOWN_CLIENT_IP
            return str(real_ip)

        # ``X-Real-IP`` is normally present because Nginx overwrites it. Keep
        # this fallback for older local proxy configurations that only set XFF.
        for candidate in reversed(str(headers.get("x-forwarded-for", "")).split(",")):
            forwarded_ip = self._normalize_ip(candidate)
            if forwarded_ip is not None and not forwarded_ip.is_loopback:
                if is_cloudflare_edge_ip(str(forwarded_ip)):
                    return _UNKNOWN_CLIENT_IP
                return str(forwarded_ip)
        return "unknown"

    def _is_trusted_proxy(self, peer_ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
        return any(peer_ip in network for network in self._trusted_proxy_networks)

    @staticmethod
    def _normalize_ip(value: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
        try:
            return ipaddress.ip_address(str(value or "").strip())
        except ValueError:
            return None

    @staticmethod
    def _parse_network(value: str) -> ipaddress.IPv4Network | ipaddress.IPv6Network | None:
        try:
            return ipaddress.ip_network(str(value or "").strip(), strict=False)
        except ValueError:
            return None


def resolve_defense_client_ip(
    resolver: RequestOriginResolver,
    headers: Mapping[str, str],
    peer_host: str,
    *,
    first_party_internal: bool,
) -> str:
    """Return the IP eligible for public active-defense penalties.

    First-party background jobs are authenticated separately and have no public
    client IP. Returning ``unknown`` preserves the existing skip behaviour in
    active-defense without weakening checks for any external request.
    """
    if first_party_internal:
        return _UNKNOWN_CLIENT_IP
    return resolver.resolve(headers, peer_host)
