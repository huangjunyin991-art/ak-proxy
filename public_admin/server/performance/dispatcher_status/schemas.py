from typing import Any


LIGHT_EXIT_FIELDS = {
    "index",
    "name",
    "type",
    "core_type",
    "local_port",
    "proxy",
    "healthy",
    "dispatch_ready",
    "exit_ip",
    "ip_detecting",
    "ip_detect_checked_at",
    "ip_detect_failures",
    "ip_detect_last_error",
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
