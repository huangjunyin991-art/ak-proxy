"""Route subscription retrieval through direct and existing tunnel paths."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable

from .service import (
    FetchText,
    ParseSubscription,
    SubscriptionFetchError,
    SubscriptionFetchSelection,
    fetch_best_subscription_response,
)


TunnelFetchText = Callable[[str, int, str, str], str]


@dataclass(frozen=True)
class SubscriptionTunnelRoute:
    """A server-selected local tunnel that may fetch a blocked subscription."""

    name: str
    proxy_url: str

    @classmethod
    def from_mapping(cls, value: Any) -> "SubscriptionTunnelRoute | None":
        if not isinstance(value, dict):
            return None
        name = str(value.get("name") or "").strip()
        proxy_url = str(value.get("proxy_url") or "").strip()
        if not name or not proxy_url.startswith("socks5://"):
            return None
        return cls(name=name, proxy_url=proxy_url)


@dataclass(frozen=True)
class RoutedSubscriptionFetchSelection:
    selection: SubscriptionFetchSelection
    route: str
    tunnel_fallback_attempted: bool
    tunnel_attempt_count: int


def _node_count(selection: SubscriptionFetchSelection) -> int:
    try:
        return max(0, int(selection.parsed.get("total_nodes") or 0))
    except (TypeError, ValueError):
        return 0


def _normalized_tunnels(routes: Iterable[Any] | None) -> list[SubscriptionTunnelRoute]:
    result: list[SubscriptionTunnelRoute] = []
    seen_proxy_urls: set[str] = set()
    for raw_route in routes or ():
        route = (
            raw_route
            if isinstance(raw_route, SubscriptionTunnelRoute)
            else SubscriptionTunnelRoute.from_mapping(raw_route)
        )
        if route is None or route.proxy_url in seen_proxy_urls:
            continue
        seen_proxy_urls.add(route.proxy_url)
        result.append(route)
    return result


def fetch_subscription_with_tunnel_fallback(
    url: str,
    timeout: int,
    *,
    parse_subscription: ParseSubscription,
    direct_fetch_text: FetchText,
    tunnel_fetch_text: TunnelFetchText,
    tunnel_routes: Iterable[Any] | None = None,
) -> RoutedSubscriptionFetchSelection:
    """Keep direct retrieval fast, then retry empty results through tunnels.

    A successful HTTP request is not sufficient: anti-bot pages and provider
    error pages are parsed as zero nodes, so only a valid non-empty parse stops
    the fallback. The direct result remains the final diagnostic when every
    tunnel also returns no usable subscription.
    """
    direct_selection: SubscriptionFetchSelection | None = None
    direct_error: Exception | None = None
    try:
        direct_selection = fetch_best_subscription_response(
            url,
            timeout,
            direct_fetch_text,
            parse_subscription,
        )
        if _node_count(direct_selection) > 0:
            return RoutedSubscriptionFetchSelection(
                selection=direct_selection,
                route="direct",
                tunnel_fallback_attempted=False,
                tunnel_attempt_count=0,
            )
    except SubscriptionFetchError as exc:
        direct_error = exc

    tunnel_attempt_count = 0
    last_tunnel_error: Exception | None = None
    for tunnel in _normalized_tunnels(tunnel_routes):
        tunnel_attempt_count += 1
        try:
            selection = fetch_best_subscription_response(
                url,
                timeout,
                lambda request_url, request_timeout, user_agent: tunnel_fetch_text(
                    request_url,
                    request_timeout,
                    user_agent,
                    tunnel.proxy_url,
                ),
                parse_subscription,
            )
        except SubscriptionFetchError as exc:
            last_tunnel_error = exc
            continue
        if _node_count(selection) > 0:
            return RoutedSubscriptionFetchSelection(
                selection=selection,
                route="node_tunnel",
                tunnel_fallback_attempted=True,
                tunnel_attempt_count=tunnel_attempt_count,
            )

    if direct_selection is not None:
        return RoutedSubscriptionFetchSelection(
            selection=direct_selection,
            route="direct",
            tunnel_fallback_attempted=tunnel_attempt_count > 0,
            tunnel_attempt_count=tunnel_attempt_count,
        )
    if last_tunnel_error is not None:
        raise last_tunnel_error
    if direct_error is not None:
        raise direct_error
    raise SubscriptionFetchError("subscription fetch did not produce a response")
