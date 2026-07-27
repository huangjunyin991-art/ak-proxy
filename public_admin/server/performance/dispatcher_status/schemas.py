from typing import Any


LIGHT_EXIT_FIELDS = {
    "index",
    "name",
    "type",
    "core_type",
    "node_type",
    "local_port",
    "proxy",
    "healthy",
    "dispatch_ready",
    "source_probe_ready",
    "source_probing",
    "source_probe_checked_at",
    "source_probe_failures",
    "source_probe_last_error",
    "source_probe_status_code",
    "source_probe_url",
    "active",
    "total_requests",
    "login_requests",
    "login_cooldown",
    "errors",
    "warn_403",
    "warn_429",
    "frozen",
    "frozen_remaining",
    "frozen_reason",
    "connect_failures",
    "recent_errors",
    "rpm",
    "rate_limit",
    "latency_ms",
    "latency_checked_at",
    "latency_probe_failures",
    "latency_probe_error",
    "latency_probing",
}

NODE_META_FIELDS = {
    "group_id",
    "group_name",
    "node_type",
    "node_server",
    "core_type",
    "local_port",
    "core_supported",
    "core_unsupported_reason",
    "enabled",
}


def pick_fields(source: dict[str, Any], fields: set[str]) -> dict[str, Any]:
    return {key: source.get(key) for key in fields if key in source}
