"""Known subscription client profiles used for compatibility retrieval."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SubscriptionFetchProfile:
    identifier: str
    label: str
    user_agent: str
    priority: int


# Keep this list server-controlled. Subscription providers frequently use the
# client identifier to choose a syntax or protocol set, so free-form headers
# would make imports non-reproducible and needlessly expand the attack surface.
SUBSCRIPTION_FETCH_PROFILES: tuple[SubscriptionFetchProfile, ...] = (
    SubscriptionFetchProfile("v2rayn", "v2rayN", "v2rayN/7.2.3", 0),
    SubscriptionFetchProfile("clash_meta", "Clash Meta", "ClashMetaForAndroid/2.11.8.Meta", 1),
    SubscriptionFetchProfile("sing_box", "sing-box", "sing-box 1.10.0", 2),
    SubscriptionFetchProfile(
        "browser",
        "Browser",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        3,
    ),
)
