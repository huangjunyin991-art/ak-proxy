from typing import Any, Awaitable, Callable

from ..cache.ttl_cache import AsyncTTLCache
from .schemas import LIGHT_EXIT_FIELDS, NODE_META_FIELDS, pick_fields


class DispatcherStatusService:
    def __init__(
        self,
        dispatcher: Any,
        singbox_status_loader: Callable[[], Awaitable[dict[str, Any]]],
        subscription_groups_loader: Callable[[], Awaitable[list[dict[str, Any]]]],
        saved_nodes_loader: Callable[[], list[dict[str, Any]]],
        active_group_filter: Callable[[list[dict[str, Any]], set[str]], list[dict[str, Any]]],
        enabled_nodes_filter: Callable[[list[dict[str, Any]]], list[dict[str, Any]]],
        runtime_nodes_builder: Callable[[list[dict[str, Any]]], list[dict[str, Any]]] | None = None,
        meta_ttl_seconds: float = 30.0,
    ):
        self._dispatcher = dispatcher
        self._singbox_status_loader = singbox_status_loader
        self._subscription_groups_loader = subscription_groups_loader
        self._saved_nodes_loader = saved_nodes_loader
        self._active_group_filter = active_group_filter
        self._enabled_nodes_filter = enabled_nodes_filter
        self._runtime_nodes_builder = runtime_nodes_builder
        self._meta_cache = AsyncTTLCache(self._load_meta_status, meta_ttl_seconds, meta_ttl_seconds * 4)

    def get_light_status(self) -> dict[str, Any]:
        status = self._dispatcher.get_status()
        if not isinstance(status, dict):
            status = {}
        exits = status.get("exits") if isinstance(status, dict) else []
        light_exits = [pick_fields(item, LIGHT_EXIT_FIELDS) for item in exits if isinstance(item, dict)]
        total_exits = self._to_int(status.get("total_exits"), len(light_exits))
        available_exits = self._to_optional_int(status.get("available_exits"))
        if available_exits is None:
            available_exits = sum(1 for item in light_exits if item.get("dispatch_ready") and not item.get("frozen"))
        disabled_exits = self._to_optional_int(status.get("disabled_exits"))
        if disabled_exits is None:
            disabled_exits = max(0, total_exits - available_exits)
        available_ratio = self._to_optional_float(status.get("available_ratio"))
        if available_ratio is None:
            available_ratio = round((available_exits / total_exits) * 100, 1) if total_exits else 0
        return {
            "total_exits": total_exits,
            "healthy_exits": status.get("healthy_exits", 0),
            "available_exits": available_exits,
            "disabled_exits": disabled_exits,
            "available_ratio": available_ratio,
            "total_active": status.get("total_active", 0),
            "max_login_per_min": status.get("max_login_per_min", 0),
            "policy": status.get("policy", {}),
            "exits": light_exits,
        }

    @staticmethod
    def _to_int(value: Any, default: int = 0) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _to_optional_int(value: Any) -> int | None:
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _to_optional_float(value: Any) -> float | None:
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    async def get_meta_status(self, force_refresh: bool = False) -> dict[str, Any]:
        return await self._meta_cache.get(force_refresh=force_refresh)

    def invalidate_meta(self) -> None:
        self._meta_cache.invalidate()

    async def _load_meta_status(self) -> dict[str, Any]:
        singbox_status = await self._singbox_status_loader()
        groups = await self._subscription_groups_loader()
        active_group_ids = {str(group.get("id") or "").strip() for group in groups if isinstance(group, dict)}
        saved_nodes = self._saved_nodes_loader()
        node_items = [item for item in saved_nodes if isinstance(item, dict)] if isinstance(saved_nodes, list) else []
        active_nodes = self._active_group_filter(node_items, active_group_ids)
        if self._runtime_nodes_builder is not None:
            active_nodes = self._runtime_nodes_builder(active_nodes)
        enabled_nodes = self._enabled_nodes_filter(active_nodes)
        node_meta = []
        for idx, node in enumerate(enabled_nodes, start=1):
            item = {
                "index": idx,
                "group_id": node.get("group_id", ""),
                "group_name": node.get("group_name", ""),
                "node_type": node.get("type", ""),
                "node_server": node.get("server", ""),
                "core_type": node.get("core_type", ""),
                "local_port": node.get("local_port", 0),
                "core_supported": node.get("core_supported", True),
                "core_unsupported_reason": node.get("core_unsupported_reason", ""),
                "enabled": node.get("enabled", True),
            }
            node_meta.append(pick_fields(item, NODE_META_FIELDS | {"index"}))
        return {
            "singbox": singbox_status,
            "subscription_groups": groups,
            "node_meta": node_meta,
        }
