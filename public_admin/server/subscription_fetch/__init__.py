"""Subscription retrieval strategies isolated from protocol parsing."""

from .routing import fetch_subscription_with_tunnel_fallback
from .service import fetch_best_subscription_response
from .transport import fetch_subscription_text_via_tunnel

__all__ = [
    "fetch_best_subscription_response",
    "fetch_subscription_text_via_tunnel",
    "fetch_subscription_with_tunnel_fallback",
]
