"""Extract the small, durable subset needed from an EP order detail response."""

from __future__ import annotations

from typing import Any, Mapping


def extract_seller_account(payload: Mapping[str, Any] | None) -> str:
    """Return the seller FlowNumber without retaining payment detail data."""
    source = payload if isinstance(payload, Mapping) else {}
    detail = _mapping_value(source, "Detail")
    seller = _mapping_value(detail, "Seller")
    for field in ("FlowNumber", "MemberNo"):
        value = _string_value(seller, field)
        if value:
            return value
    return ""


def _mapping_value(source: Mapping[str, Any], field: str) -> Mapping[str, Any]:
    value = source.get(field)
    if isinstance(value, Mapping):
        return value
    normalized = {str(key).casefold(): item for key, item in source.items()}
    value = normalized.get(field.casefold())
    return value if isinstance(value, Mapping) else {}


def _string_value(source: Mapping[str, Any], field: str) -> str:
    value = source.get(field)
    if value is None:
        normalized = {str(key).casefold(): item for key, item in source.items()}
        value = normalized.get(field.casefold())
    return str(value or "").strip()
