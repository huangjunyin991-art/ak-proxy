# -*- coding: utf-8 -*-
"""High-level dual-core orchestration."""

from __future__ import annotations

import asyncio
import inspect
import logging
from collections import Counter
from copy import deepcopy
from typing import Any, Awaitable, Callable

from .classifier import MIHOMO_CORE, SINGBOX_CORE, UNSUPPORTED_CORE, prepare_nodes
from . import mihomo_core, singbox_core
from .rolling import DRAIN_SECONDS, candidate_base_port, clear_active_base_port, mark_active_base_port
from .runtime import ensure_binary_async


logger = logging.getLogger("TransparentProxy")
ActivationCallback = Callable[[list[dict[str, Any]]], Awaitable[None] | None]
_TRANSITION_LOCK = asyncio.Lock()


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
        try:
            saved_port = int(item.get("local_port") or 0)
        except (TypeError, ValueError):
            saved_port = 0
        item["local_port"] = saved_port if saved_port > 0 else int(base_port) + index
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
                      mihomo_base_port: int = mihomo_core.MIHOMO_BASE_PORT,
                      activation_callback: ActivationCallback | None = None,
                      allow_empty: bool = False) -> dict[str, Any]:
    """Stage both cores on alternate ports, then atomically activate callers' exits.

    ``allow_empty`` is reserved for an intentional removal of every runnable
    node, such as deleting the last subscription group.
    """
    async with _TRANSITION_LOCK:
        return await _apply_nodes_locked(
            nodes,
            singbox_base_port=singbox_base_port,
            mihomo_base_port=mihomo_base_port,
            activation_callback=activation_callback,
            allow_empty=allow_empty,
        )


async def _apply_nodes_locked(nodes: list[dict[str, Any]], *, singbox_base_port: int,
                              mihomo_base_port: int, activation_callback: ActivationCallback | None,
                              allow_empty: bool) -> dict[str, Any]:
    candidate_input = []
    for node in nodes:
        item = deepcopy(node)
        item.pop("local_port", None)
        candidate_input.append(item)

    candidate_buckets = split_nodes_by_core(candidate_input)
    singbox_count = len(candidate_buckets[SINGBOX_CORE])
    mihomo_count = len(candidate_buckets[MIHOMO_CORE])
    candidate_singbox_base = candidate_base_port(
        SINGBOX_CORE,
        singbox_base_port,
        singbox_count,
    )
    singbox_reservation = (
        ((candidate_singbox_base, singbox_count),)
        if singbox_count
        else ()
    )
    candidate_mihomo_base = candidate_base_port(
        MIHOMO_CORE,
        mihomo_base_port,
        mihomo_count,
        reserved_ranges=singbox_reservation,
    )
    runtime_nodes = build_runtime_nodes(
        candidate_input,
        singbox_base_port=candidate_singbox_base,
        mihomo_base_port=candidate_mihomo_base,
    )
    singbox_nodes = [node for node in runtime_nodes if node.get("core_type") == SINGBOX_CORE and node.get("core_supported")]
    mihomo_nodes = [node for node in runtime_nodes if node.get("core_type") == MIHOMO_CORE and node.get("core_supported")]
    unsupported_nodes = [node for node in runtime_nodes if node.get("core_type") == UNSUPPORTED_CORE or not node.get("core_supported")]

    results: dict[str, Any] = {
        SINGBOX_CORE: await singbox_core.stage_nodes(singbox_nodes, candidate_singbox_base),
        MIHOMO_CORE: await mihomo_core.stage_nodes(mihomo_nodes, candidate_mihomo_base),
    }
    stages = []
    for core_type in (SINGBOX_CORE, MIHOMO_CORE):
        result = results[core_type]
        stage = result.get("stage") if isinstance(result, dict) else None
        if result.get("success") and stage is not None:
            stages.append((core_type, stage))
    public_results = {
        key: {field: value for field, value in (result or {}).items() if field != "stage"}
        for key, result in results.items()
    }
    if len(stages) != 2:
        for staged_core_type, staged in reversed(stages):
            core = singbox_core if staged_core_type == SINGBOX_CORE else mihomo_core
            await asyncio.to_thread(core.discard_stage, staged)
        messages = "; ".join(
            f"{key}: {(value or {}).get('message', '')}" for key, value in results.items()
        )
        return {
            "success": False,
            "pending_download": any(bool((item or {}).get("pending_download")) for item in results.values()),
            "message": messages or "proxy core candidate stage failed",
            "nodes": runtime_nodes,
            "runtime_nodes": [node for node in runtime_nodes if node.get("core_supported") is True],
            "unsupported_nodes": unsupported_nodes,
            "nodes_count": len(singbox_nodes) + len(mihomo_nodes),
            "core_counts": dict(Counter(str(node.get("core_type") or UNSUPPORTED_CORE) for node in runtime_nodes)),
            "cores": public_results,
        }

    try:
        for core_type, stage in stages:
            core = singbox_core if core_type == SINGBOX_CORE else mihomo_core
            await asyncio.to_thread(core.promote_stage, stage)
        if activation_callback is not None:
            callback_result = activation_callback(runtime_nodes)
            if inspect.isawaitable(callback_result):
                await callback_result
    except Exception as exc:
        logger.exception("[ProxyCore] candidate activation failed: %s", exc)
        for core_type, stage in reversed(stages):
            core = singbox_core if core_type == SINGBOX_CORE else mihomo_core
            await asyncio.to_thread(core.discard_stage, stage)
        return {
            "success": False,
            "message": str(exc),
            "nodes": runtime_nodes,
            "runtime_nodes": [node for node in runtime_nodes if node.get("core_supported") is True],
            "unsupported_nodes": unsupported_nodes,
            "nodes_count": len(singbox_nodes) + len(mihomo_nodes),
            "core_counts": dict(Counter(str(node.get("core_type") or UNSUPPORTED_CORE) for node in runtime_nodes)),
            "cores": public_results,
        }

    for core_type, stage in stages:
        try:
            if stage.nodes_count:
                mark_active_base_port(core_type, stage.base_port, stage.nodes_count)
            else:
                clear_active_base_port(core_type)
        except Exception as exc:
            # The persisted nodes retain their assigned ports, so losing this
            # optimization must not turn a completed generation switch into a failure.
            logger.warning("[ProxyCore] %s active port state save failed: %s", core_type, exc)
        core = singbox_core if core_type == SINGBOX_CORE else mihomo_core
        asyncio.create_task(_retire_previous_after_drain(core_type, core, stage))

    runnable_count = len(singbox_nodes) + len(mihomo_nodes)
    active_results = [result for key, result in results.items() if result.get("nodes_count", 0)]
    stages_ready = all(bool(result.get("success")) for result in results.values())
    success = (bool(runnable_count) and all(bool(result.get("success")) for result in active_results)) or (
        allow_empty and stages_ready
    )
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
        "cores": public_results,
    }


async def _retire_previous_after_drain(core_type: str, core: Any, stage: Any) -> None:
    try:
        if DRAIN_SECONDS > 0:
            await asyncio.sleep(DRAIN_SECONDS)
        await asyncio.to_thread(core.retire_stage_previous, stage)
    except Exception as exc:
        logger.warning("[ProxyCore] %s previous generation retirement failed: %s", core_type, exc)


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
