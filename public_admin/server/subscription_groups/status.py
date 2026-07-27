"""Project dispatcher health onto subscription groups and logical nodes."""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable

from .identity import group_nodes_by_identity


def _exits_by_identity(exits: Iterable[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for exit_item in exits:
        if not isinstance(exit_item, dict):
            continue
        identity = str(exit_item.get("node_identity") or "").strip()
        if identity:
            grouped[identity].append(exit_item)
    return dict(grouped)


def _runtime_locator(item: dict[str, Any]) -> tuple[str, int] | None:
    group_id = str(item.get("group_id") or "").strip()
    try:
        local_port = int(item.get("local_port") or 0)
    except (TypeError, ValueError):
        return None
    if not group_id or local_port <= 0:
        return None
    return group_id, local_port


def _exits_by_locator(
    exits: Iterable[dict[str, Any]],
) -> dict[tuple[str, int], list[dict[str, Any]]]:
    grouped: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for exit_item in exits:
        if not isinstance(exit_item, dict):
            continue
        locator = _runtime_locator(exit_item)
        if locator is not None:
            grouped[locator].append(exit_item)
    return dict(grouped)


def _fallback_runtime_exits(
    duplicates: list[dict[str, Any]],
    runtime_by_locator: dict[tuple[str, int], list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    seen: set[int] = set()
    for node in duplicates:
        if node.get("enabled", True) is False:
            continue
        locator = _runtime_locator(node)
        if locator is None:
            continue
        for exit_item in runtime_by_locator.get(locator, []):
            marker = id(exit_item)
            if marker in seen:
                continue
            seen.add(marker)
            matches.append(exit_item)
    return matches


def _availability_state(
    duplicates: list[dict[str, Any]],
    runtime_exits: list[dict[str, Any]],
) -> str:
    enabled_nodes = [node for node in duplicates if node.get("enabled", True) is not False]
    if not enabled_nodes:
        return "disabled"
    if not any(node.get("core_supported", True) is not False for node in enabled_nodes):
        return "unsupported"
    if any(item.get("dispatch_ready") and not item.get("frozen") for item in runtime_exits):
        return "available"
    if not runtime_exits:
        return "pending"
    if any(
        item.get("healthy", True)
        and (
            item.get("source_probing")
            or (
                not item.get("source_probe_checked_at")
                and not item.get("source_probe_failures")
            )
        )
        for item in runtime_exits
    ):
        return "pending"
    return "unavailable"


def build_group_node_views(
    nodes: Iterable[dict[str, Any]],
    exits: Iterable[dict[str, Any]],
    group_id: str,
) -> list[dict[str, Any]]:
    runtime_items = [item for item in exits if isinstance(item, dict)]
    runtime_by_identity = _exits_by_identity(runtime_items)
    runtime_by_locator = _exits_by_locator(runtime_items)
    views = []
    for identity, duplicates in group_nodes_by_identity(nodes, group_id).items():
        representative = duplicates[0]
        runtime_exits = runtime_by_identity.get(identity, [])
        if not runtime_exits:
            runtime_exits = _fallback_runtime_exits(duplicates, runtime_by_locator)
        enabled = any(node.get("enabled", True) is not False for node in duplicates)
        supported = any(
            node.get("core_supported", True) is not False
            for node in duplicates
            if node.get("enabled", True) is not False
        ) if enabled else any(node.get("core_supported", True) is not False for node in duplicates)
        views.append({
            "node_identity": identity,
            "name": str(representative.get("display_name") or representative.get("name") or "").strip(),
            "type": str(representative.get("type") or "").strip(),
            "server": str(representative.get("server") or "").strip(),
            "port": representative.get("port"),
            "enabled": enabled,
            "core_supported": supported,
            "core_unsupported_reason": str(representative.get("core_unsupported_reason") or "").strip(),
            "duplicate_count": len(duplicates),
            "availability_state": _availability_state(duplicates, runtime_exits),
        })
    return views


def _availability_summary(views: list[dict[str, Any]]) -> dict[str, Any]:
    enabled = [item for item in views if item.get("enabled")]
    available = sum(1 for item in enabled if item.get("availability_state") == "available")
    pending = sum(1 for item in enabled if item.get("availability_state") == "pending")
    unavailable = len(enabled) - available - pending
    ratio = round((available / len(enabled)) * 100, 1) if enabled else 0.0
    return {
        "available_nodes": available,
        "unavailable_nodes": unavailable,
        "pending_nodes": pending,
        "availability_total": len(enabled),
        "availability_ratio": ratio,
    }


def decorate_subscription_groups(
    groups: Iterable[dict[str, Any]],
    nodes: Iterable[dict[str, Any]],
    exits: Iterable[dict[str, Any]],
) -> list[dict[str, Any]]:
    node_items = [item for item in nodes if isinstance(item, dict)]
    exit_items = [item for item in exits if isinstance(item, dict)]
    decorated = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        group_id = str(group.get("id") or "").strip()
        views = build_group_node_views(node_items, exit_items, group_id)
        enabled_count = sum(1 for item in views if item.get("enabled"))
        decorated.append({
            **group,
            "total_servers": len(views),
            "active_servers": enabled_count,
            **_availability_summary(views),
        })
    return decorated
