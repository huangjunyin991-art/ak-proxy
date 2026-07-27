"""Stable identities for subscription nodes without exposing credentials."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from typing import Any, Iterable


def _normalized_port(value: Any) -> int | str:
    try:
        return int(value)
    except (TypeError, ValueError):
        return str(value or "").strip()


def _root_outbound_config(node: dict[str, Any]) -> dict[str, Any]:
    outbound = node.get("outbound_config")
    if not isinstance(outbound, dict):
        return {}
    # Tags are display/routing metadata. They do not change the upstream route.
    return {key: value for key, value in outbound.items() if key not in {"tag", "name"}}


def subscription_node_identity(node: dict[str, Any]) -> str:
    """Return an irreversible identity for one complete upstream route."""
    raw = node.get("raw") if isinstance(node.get("raw"), dict) else {}
    payload = {
        "core_type": str(node.get("core_type") or "").strip().lower(),
        "type": str(node.get("type") or raw.get("type") or "").strip().lower(),
        "server": str(node.get("server") or "").strip().lower(),
        "port": _normalized_port(node.get("port")),
        "raw": raw,
        "outbound_config": _root_outbound_config(node),
    }
    serialized = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def group_nodes_by_identity(
    nodes: Iterable[dict[str, Any]],
    group_id: str | None = None,
) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    expected_group = str(group_id or "").strip()
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if expected_group and str(node.get("group_id") or "").strip() != expected_group:
            continue
        grouped[subscription_node_identity(node)].append(node)
    return dict(grouped)


def summarize_subscription_nodes(nodes: Iterable[dict[str, Any]]) -> dict[str, int]:
    grouped = group_nodes_by_identity(nodes)
    active = sum(
        1
        for duplicates in grouped.values()
        if any(node.get("enabled", True) is not False for node in duplicates)
    )
    return {"total": len(grouped), "active": active}
