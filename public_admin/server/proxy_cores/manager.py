# -*- coding: utf-8 -*-
"""High-level dual-core orchestration."""

from __future__ import annotations

from collections import Counter
from copy import deepcopy
from typing import Any

from .classifier import MIHOMO_CORE, SINGBOX_CORE, UNSUPPORTED_CORE, prepare_nodes
from . import mihomo_core, singbox_core
from .runtime import ensure_binary_async


def split_nodes_by_core(nodes: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    prepared = prepare_nodes(nodes)
    buckets = {
        SINGBOX_CORE: [],
        MIHOMO_CORE: [],
        UNSUPPORTED_CORE: [],
    }
    for node in prepared:
        core_type = str(node.get("core_type") or UNSUPPORTED_CORE)
        if node.get("enabled", True) is False:
            continue
        if core_type not in buckets:
            core_type = UNSUPPORTED_CORE
        buckets[core_type].append(node)
    return buckets


def assign_ports(nodes: list[dict[str, Any]], base_port: int) -> list[dict[str, Any]]:
    assigned = []
    for index, node in enumerate(nodes):
        item = deepcopy(node)
        item["local_port"] = int(base_port) + index
        assigned.append(item)
    return assigned


def build_runtime_nodes(nodes: list[dict[str, Any]], singbox_base_port: int = singbox_core.SINGBOX_BASE_PORT,
                        mihomo_base_port: int = mihomo_core.MIHOMO_BASE_PORT) -> list[dict[str, Any]]:
    buckets = split_nodes_by_core(nodes)
    runtime_nodes: list[dict[str, Any]] = []
    runtime_nodes.extend(assign_ports(buckets[SINGBOX_CORE], singbox_base_port))
    runtime_nodes.extend(assign_ports(buckets[MIHOMO_CORE], mihomo_base_port))
    runtime_nodes.extend(buckets[UNSUPPORTED_CORE])
    return runtime_nodes


async def apply_nodes(nodes: list[dict[str, Any]], singbox_base_port: int = singbox_core.SINGBOX_BASE_PORT,
                      mihomo_base_port: int = mihomo_core.MIHOMO_BASE_PORT) -> dict[str, Any]:
    runtime_nodes = build_runtime_nodes(nodes, singbox_base_port=singbox_base_port, mihomo_base_port=mihomo_base_port)
    singbox_nodes = [node for node in runtime_nodes if node.get("core_type") == SINGBOX_CORE and node.get("core_supported")]
    mihomo_nodes = [node for node in runtime_nodes if node.get("core_type") == MIHOMO_CORE and node.get("core_supported")]
    unsupported_nodes = [node for node in runtime_nodes if node.get("core_type") == UNSUPPORTED_CORE or not node.get("core_supported")]

    results: dict[str, Any] = {
        SINGBOX_CORE: await singbox_core.apply_nodes(singbox_nodes, singbox_base_port),
        MIHOMO_CORE: await mihomo_core.apply_nodes(mihomo_nodes, mihomo_base_port),
    }

    runnable_count = len(singbox_nodes) + len(mihomo_nodes)
    active_results = [result for key, result in results.items() if result.get("nodes_count", 0)]
    success = bool(runnable_count) and any(bool(result.get("success")) for result in active_results)
    pending_download = any(bool(result.get("pending_download")) for result in results.values())
    counters = Counter(str(node.get("core_type") or UNSUPPORTED_CORE) for node in runtime_nodes)
    messages = []
    for key in (SINGBOX_CORE, MIHOMO_CORE):
        result = results.get(key) or {}
        if result.get("nodes_count"):
            messages.append(f"{key}: {result.get('message', '')}")
    if unsupported_nodes:
        messages.append(f"unsupported: {len(unsupported_nodes)}")
    if not messages:
        messages.append("no runnable nodes")

    return {
        "success": success,
        "pending_download": pending_download,
        "message": "; ".join(messages),
        "nodes": runtime_nodes,
        "runtime_nodes": [node for node in runtime_nodes if node.get("core_supported") is True],
        "unsupported_nodes": unsupported_nodes,
        "nodes_count": runnable_count,
        "core_counts": dict(counters),
        "cores": results,
    }


async def ensure_required_binaries() -> dict[str, Any]:
    results = {
        SINGBOX_CORE: await ensure_binary_async(SINGBOX_CORE, singbox_core.SINGBOX_BIN_NAME),
        MIHOMO_CORE: await ensure_binary_async(MIHOMO_CORE, mihomo_core.MIHOMO_BIN_NAME),
    }
    return {
        "success": True,
        "pending_download": any(bool(item.get("downloading")) for item in results.values()),
        "cores": results,
    }


async def restart_core(core_type: str, nodes: list[dict[str, Any]], singbox_base_port: int = singbox_core.SINGBOX_BASE_PORT,
                       mihomo_base_port: int = mihomo_core.MIHOMO_BASE_PORT) -> dict[str, Any]:
    core = str(core_type or "").strip().lower()
    runtime_nodes = build_runtime_nodes(nodes, singbox_base_port=singbox_base_port, mihomo_base_port=mihomo_base_port)
    if core == SINGBOX_CORE:
        singbox_nodes = [node for node in runtime_nodes if node.get("core_type") == SINGBOX_CORE and node.get("core_supported")]
        result = await singbox_core.apply_nodes(singbox_nodes, singbox_base_port)
        return {**result, "core_type": SINGBOX_CORE}
    if core == MIHOMO_CORE:
        mihomo_nodes = [node for node in runtime_nodes if node.get("core_type") == MIHOMO_CORE and node.get("core_supported")]
        result = await mihomo_core.apply_nodes(mihomo_nodes, mihomo_base_port)
        return {**result, "core_type": MIHOMO_CORE}
    if core in {"all", "both", ""}:
        return await apply_nodes(nodes, singbox_base_port=singbox_base_port, mihomo_base_port=mihomo_base_port)
    return {"success": False, "message": f"unknown proxy core: {core_type}", "core_type": core_type}


def get_cores_status() -> dict[str, Any]:
    return {
        SINGBOX_CORE: singbox_core.get_status(),
        MIHOMO_CORE: mihomo_core.get_status(),
    }
