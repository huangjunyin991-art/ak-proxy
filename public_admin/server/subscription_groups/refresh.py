"""Automatic refresh for subscription groups with degraded runtime health."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Iterable

from .identity import group_nodes_by_identity, subscription_node_identity, summarize_subscription_nodes
from .status import build_group_node_views, decorate_subscription_groups


@dataclass(frozen=True)
class SubscriptionRefreshResult:
    group_id: str
    triggered: bool
    success: bool
    reason: str
    available_ratio: float = 0.0
    available_nodes: int = 0
    total_nodes: int = 0


class SubscriptionRefreshService:
    """Poll group health and atomically refresh degraded URL-backed groups.

    The service owns scheduling and per-group serialization. Runtime publishing is
    delegated to the existing atomic apply callback, so a failed candidate never
    replaces the currently serving generation.
    """

    def __init__(
        self,
        *,
        groups_loader: Callable[[], Awaitable[list[dict[str, Any]]]],
        nodes_loader: Callable[[], list[dict[str, Any]]],
        exits_loader: Callable[[], Iterable[dict[str, Any]]],
        fetcher: Callable[[str], Awaitable[dict[str, Any]]],
        applier: Callable[[list[dict[str, Any]]], Awaitable[dict[str, Any]]],
        group_counter_updater: Callable[[str, int, int], Awaitable[bool]],
        logger: Any,
        interval_seconds: float = 60.0,
        cooldown_seconds: float = 300.0,
        availability_threshold: float = 10.0,
    ) -> None:
        self._groups_loader = groups_loader
        self._nodes_loader = nodes_loader
        self._exits_loader = exits_loader
        self._fetcher = fetcher
        self._applier = applier
        self._group_counter_updater = group_counter_updater
        self._logger = logger
        self._interval_seconds = max(10.0, float(interval_seconds))
        self._cooldown_seconds = max(self._interval_seconds, float(cooldown_seconds))
        self._availability_threshold = float(availability_threshold)
        self._locks: dict[str, asyncio.Lock] = {}
        self._last_attempt: dict[str, float] = {}
        self._task: asyncio.Task | None = None
        self._stopping = False

    def _lock_for(self, group_id: str) -> asyncio.Lock:
        lock = self._locks.get(group_id)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[group_id] = lock
        return lock

    def _health(self, group: dict[str, Any], nodes: list[dict[str, Any]], exits: list[dict[str, Any]]) -> dict[str, Any]:
        group_id = str(group.get("id") or "").strip()
        views = build_group_node_views(nodes, exits, group_id)
        decorated = decorate_subscription_groups([group], nodes, exits)
        summary = decorated[0] if decorated else {}
        return {
            "available_ratio": float(summary.get("availability_ratio") or 0.0),
            "available_nodes": int(summary.get("available_nodes") or 0),
            "total_nodes": int(summary.get("availability_total") or 0),
            "pending_nodes": int(summary.get("pending_nodes") or 0),
            "views": views,
        }

    def should_refresh(self, group: dict[str, Any], health: dict[str, Any]) -> bool:
        """Return whether a URL-backed group is below the configured threshold."""
        if not str(group.get("source_url") or "").strip():
            return False
        total = int(health.get("total_nodes") or 0)
        return total > 0 and float(health.get("available_ratio") or 0.0) < self._availability_threshold

    @staticmethod
    def _merge_group_nodes(
        saved_nodes: list[dict[str, Any]],
        group: dict[str, Any],
        fetched_nodes: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        group_id = str(group.get("id") or "").strip()
        old_group_nodes = [node for node in saved_nodes if str(node.get("group_id") or "").strip() == group_id]
        old_by_identity: dict[str, dict[str, Any]] = {}
        for duplicates in group_nodes_by_identity(old_group_nodes).values():
            if duplicates:
                old_by_identity[subscription_node_identity(duplicates[0])] = duplicates[0]

        replacement: list[dict[str, Any]] = []
        for index, raw_node in enumerate(fetched_nodes):
            if not isinstance(raw_node, dict):
                continue
            node = dict(raw_node)
            node["group_id"] = group_id
            node["group_name"] = str(group.get("name") or node.get("group_name") or "")
            node["source_type"] = str(group.get("source_type") or "url")
            node["source_url"] = str(group.get("source_url") or "")
            node["display_name"] = node.get("display_name") or node.get("name") or f"订阅节点{index + 1}"
            previous = old_by_identity.get(subscription_node_identity(node))
            node["enabled"] = previous.get("enabled", True) if previous else True
            replacement.append(node)

        return [
            node for node in saved_nodes
            if str(node.get("group_id") or "").strip() != group_id
        ] + replacement

    async def refresh_group(
        self,
        group: dict[str, Any],
        *,
        saved_nodes: list[dict[str, Any]] | None = None,
        exits: list[dict[str, Any]] | None = None,
        force: bool = False,
    ) -> SubscriptionRefreshResult:
        group_id = str(group.get("id") or "").strip()
        if not group_id:
            return SubscriptionRefreshResult("", False, False, "missing_group_id")
        nodes = saved_nodes if saved_nodes is not None else self._nodes_loader()
        runtime_exits = exits if exits is not None else list(self._exits_loader())
        health = self._health(group, nodes, runtime_exits)
        if not force and not self.should_refresh(group, health):
            return SubscriptionRefreshResult(group_id, False, True, "health_above_threshold", **{
                key: health[key] for key in ("available_ratio", "available_nodes", "total_nodes")
            })
        now = time.monotonic()
        if not force and now - self._last_attempt.get(group_id, 0.0) < self._cooldown_seconds:
            return SubscriptionRefreshResult(group_id, False, True, "cooldown", **{
                key: health[key] for key in ("available_ratio", "available_nodes", "total_nodes")
            })

        async with self._lock_for(group_id):
            now = time.monotonic()
            if not force and now - self._last_attempt.get(group_id, 0.0) < self._cooldown_seconds:
                return SubscriptionRefreshResult(group_id, False, True, "cooldown", **{
                    key: health[key] for key in ("available_ratio", "available_nodes", "total_nodes")
                })
            self._last_attempt[group_id] = now
            try:
                parsed = await self._fetcher(str(group.get("source_url") or "").strip())
                fetched_nodes = parsed.get("nodes") if isinstance(parsed, dict) else None
                if not isinstance(fetched_nodes, list) or not fetched_nodes:
                    reason = str((parsed or {}).get("error") or "empty_subscription") if isinstance(parsed, dict) else "invalid_subscription"
                    self._logger.warning("[SubRefresh] group=%s refresh skipped: %s", group_id, reason)
                    return SubscriptionRefreshResult(group_id, True, False, reason, **{
                        key: health[key] for key in ("available_ratio", "available_nodes", "total_nodes")
                    })
                candidate = self._merge_group_nodes(nodes, group, fetched_nodes)
                applied = await self._applier(candidate)
                if not isinstance(applied, dict) or not applied.get("success"):
                    reason = str((applied or {}).get("message") or "candidate_apply_failed") if isinstance(applied, dict) else "candidate_apply_failed"
                    self._logger.warning("[SubRefresh] group=%s candidate preserved old generation: %s", group_id, reason)
                    return SubscriptionRefreshResult(group_id, True, False, reason, **{
                        key: health[key] for key in ("available_ratio", "available_nodes", "total_nodes")
                    })
                summary = summarize_subscription_nodes([node for node in candidate if str(node.get("group_id") or "").strip() == group_id])
                await self._group_counter_updater(group_id, summary["total"], summary["active"])
                self._logger.info("[SubRefresh] group=%s refreshed nodes=%s available_ratio=%.1f", group_id, summary["total"], health["available_ratio"])
                return SubscriptionRefreshResult(group_id, True, True, "refreshed", **{
                    key: health[key] for key in ("available_ratio", "available_nodes", "total_nodes")
                })
            except Exception as exc:
                self._logger.warning("[SubRefresh] group=%s refresh failed; old generation retained: %s", group_id, exc)
                return SubscriptionRefreshResult(group_id, True, False, f"refresh_failed:{type(exc).__name__}", **{
                    key: health[key] for key in ("available_ratio", "available_nodes", "total_nodes")
                })

    async def run_once(self) -> list[SubscriptionRefreshResult]:
        groups = await self._groups_loader()
        results = []
        for group in groups or []:
            if isinstance(group, dict):
                # Reload after every successful cutover so a later group cannot
                # publish a candidate built from an older global generation.
                nodes = [item for item in (self._nodes_loader() or []) if isinstance(item, dict)]
                exits = [item for item in (self._exits_loader() or []) if isinstance(item, dict)]
                results.append(await self.refresh_group(group, saved_nodes=nodes, exits=exits))
        return results

    async def _run(self) -> None:
        try:
            # Let the startup core warmup publish its first generation before
            # health-driven refresh evaluates the still-empty dispatcher.
            await asyncio.sleep(min(10.0, self._interval_seconds))
            while not self._stopping:
                try:
                    await self.run_once()
                except Exception as exc:
                    self._logger.warning("[SubRefresh] scheduler iteration failed: %s", exc)
                await asyncio.sleep(self._interval_seconds)
        except asyncio.CancelledError:
            return

    async def start(self) -> None:
        if self._task is None or self._task.done():
            self._stopping = False
            self._task = asyncio.create_task(self._run(), name="subscription-refresh-scheduler")

    async def stop(self) -> None:
        self._stopping = True
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
