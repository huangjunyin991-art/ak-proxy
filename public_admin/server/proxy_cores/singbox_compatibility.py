"""Runtime compatibility rules for provider-supplied sing-box outbounds."""

from __future__ import annotations

from copy import deepcopy
from typing import Any


def _alpn_values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [item.strip().lower() for item in value.split(",") if item.strip()]
    if isinstance(value, (list, tuple)):
        return [str(item).strip().lower() for item in value if str(item).strip()]
    return []


def normalize_singbox_outbound(outbound: dict[str, Any]) -> dict[str, Any]:
    """Return a runtime-safe copy without changing the stored subscription."""
    normalized = deepcopy(outbound)
    if str(normalized.get("type") or "").strip().lower() != "anytls":
        return normalized

    tls = normalized.get("tls")
    if not isinstance(tls, dict):
        return normalized

    # Some providers publish AnyTLS-over-TCP with only the HTTP/3 ALPN. Their
    # endpoint rejects that TLS handshake; omitting ALPN lets AnyTLS negotiate.
    if _alpn_values(tls.get("alpn")) == ["h3"]:
        tls.pop("alpn", None)
    return normalized
