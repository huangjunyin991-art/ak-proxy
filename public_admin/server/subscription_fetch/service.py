"""Concurrent, bounded selection of the richest compatible subscription feed."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any, Callable

from .profiles import SUBSCRIPTION_FETCH_PROFILES, SubscriptionFetchProfile


FetchText = Callable[[str, int, str], str]
ParseSubscription = Callable[[str], dict[str, Any]]


@dataclass(frozen=True)
class SubscriptionFetchSelection:
    profile: SubscriptionFetchProfile
    raw_text: str
    parsed: dict[str, Any]
    attempts: list[dict[str, Any]]


class SubscriptionFetchError(RuntimeError):
    """Raised only when every configured profile fails before returning data."""


def _node_count(parsed: dict[str, Any]) -> int:
    try:
        return max(0, int(parsed.get("total_nodes") or 0))
    except (TypeError, ValueError):
        return 0


def fetch_best_subscription_response(
    url: str,
    timeout: int,
    fetch_text: FetchText,
    parse_subscription: ParseSubscription,
) -> SubscriptionFetchSelection:
    """Fetch every supported client variant concurrently and keep the largest parse.

    A provider can tailor a subscription response to its client identifier. The
    responses are deliberately not merged: providers may attach different
    credentials, protocol variants, or quota policies to each representation.
    """
    parsed_by_profile: dict[str, tuple[str, dict[str, Any]]] = {}
    errors_by_profile: dict[str, str] = {}

    with ThreadPoolExecutor(max_workers=len(SUBSCRIPTION_FETCH_PROFILES)) as executor:
        futures = {
            executor.submit(fetch_text, url, timeout, profile.user_agent): profile
            for profile in SUBSCRIPTION_FETCH_PROFILES
        }
        for future in as_completed(futures):
            profile = futures[future]
            try:
                raw_text = future.result()
                parsed_by_profile[profile.identifier] = (raw_text, parse_subscription(raw_text))
            except Exception as exc:
                errors_by_profile[profile.identifier] = str(exc)

    attempts: list[dict[str, Any]] = []
    candidates: list[tuple[SubscriptionFetchProfile, str, dict[str, Any]]] = []
    for profile in SUBSCRIPTION_FETCH_PROFILES:
        fetched = parsed_by_profile.get(profile.identifier)
        if fetched is None:
            attempts.append({
                "profile": profile.identifier,
                "label": profile.label,
                "success": False,
                "node_count": 0,
                "error": errors_by_profile.get(profile.identifier, "request failed"),
            })
            continue

        raw_text, parsed = fetched
        count = _node_count(parsed)
        attempts.append({
            "profile": profile.identifier,
            "label": profile.label,
            "success": True,
            "node_count": count,
        })
        candidates.append((profile, raw_text, parsed))

    if not candidates:
        raise SubscriptionFetchError("all subscription client profiles failed")

    # Prefer the response with the most parsed nodes. Stable profile priority
    # makes equal-size results deterministic and easy to troubleshoot.
    selected_profile, selected_raw, selected_parsed = max(
        candidates,
        key=lambda item: (_node_count(item[2]), -item[0].priority),
    )
    return SubscriptionFetchSelection(
        profile=selected_profile,
        raw_text=selected_raw,
        parsed=selected_parsed,
        attempts=attempts,
    )
