from copy import deepcopy

import pytest

from public_admin.server import proxy_server, singbox_manager
from public_admin.server.subscription_groups import (
    build_group_node_views,
    decorate_subscription_groups,
    subscription_node_identity,
    summarize_subscription_nodes,
)


def _node(*, group_id="group-a", port=443, password="secret", enabled=True, **extra):
    node = {
        "group_id": group_id,
        "name": f"node-{port}",
        "type": "vless",
        "core_type": "singbox",
        "server": "edge.example.com",
        "port": port,
        "enabled": enabled,
        "core_supported": True,
        "raw": {"uuid": password, "network": "ws", "path": "/rpc"},
    }
    node.update(extra)
    return node


def test_subscription_node_identity_tracks_complete_upstream_configuration():
    original = _node()

    assert subscription_node_identity(original) == subscription_node_identity({
        **original,
        "group_id": "another-group",
        "name": "renamed",
        "local_port": 30001,
        "enabled": False,
    })
    assert subscription_node_identity(original) != subscription_node_identity(_node(port=8443))
    assert subscription_node_identity(original) != subscription_node_identity(_node(password="changed"))

    json_node = _node(outbound_config={
        "tag": "display-only",
        "type": "vless",
        "server": "edge.example.com",
        "server_port": 443,
        "tls": {"enabled": True, "server_name": "one.example.com"},
    })
    renamed_tag = deepcopy(json_node)
    renamed_tag["outbound_config"]["tag"] = "new-display-name"
    changed_tls = deepcopy(json_node)
    changed_tls["outbound_config"]["tls"]["server_name"] = "two.example.com"

    assert subscription_node_identity(json_node) == subscription_node_identity(renamed_tag)
    assert subscription_node_identity(json_node) != subscription_node_identity(changed_tls)


def test_subscription_node_summary_deduplicates_only_identical_routes():
    duplicate = _node(name="duplicate")
    nodes = [_node(), duplicate, _node(port=8443), _node(port=9443, enabled=False)]

    assert summarize_subscription_nodes(nodes) == {"total": 3, "active": 2}


def test_group_availability_uses_logical_node_identity():
    available = _node(port=443)
    unavailable = _node(port=8443)
    pending = _node(port=9443)
    locally_unhealthy = _node(port=12443)
    disabled = _node(port=10443, enabled=False)
    unsupported = _node(port=11443, core_supported=False, core_unsupported_reason="unsupported protocol")
    exits = [
        {
            "node_identity": subscription_node_identity(available),
            "dispatch_ready": True,
            "frozen": False,
            "source_probe_checked_at": "2026-07-28T10:00:00Z",
        },
        {
            "node_identity": subscription_node_identity(unavailable),
            "dispatch_ready": False,
            "frozen": False,
            "source_probe_checked_at": "2026-07-28T10:00:00Z",
            "source_probe_failures": 1,
        },
        {
            "node_identity": subscription_node_identity(pending),
            "dispatch_ready": False,
            "frozen": False,
            "healthy": True,
            "source_probing": True,
        },
        {
            "node_identity": subscription_node_identity(locally_unhealthy),
            "dispatch_ready": False,
            "frozen": False,
            "healthy": False,
            "source_probing": False,
        },
    ]

    views = build_group_node_views(
        [available, unavailable, pending, locally_unhealthy, disabled, unsupported],
        exits,
        "group-a",
    )
    states = {item["port"]: item["availability_state"] for item in views}

    assert states == {
        443: "available",
        8443: "unavailable",
        9443: "pending",
        12443: "unavailable",
        10443: "disabled",
        11443: "unsupported",
    }

    groups = decorate_subscription_groups(
        [{"id": "group-a", "total_servers": 99, "active_servers": 99}],
        [available, unavailable, pending, locally_unhealthy, disabled, unsupported],
        exits,
    )
    assert groups[0]["total_servers"] == 6
    assert groups[0]["active_servers"] == 5
    assert groups[0]["available_nodes"] == 1
    assert groups[0]["unavailable_nodes"] == 3
    assert groups[0]["pending_nodes"] == 1
    assert groups[0]["availability_total"] == 5
    assert groups[0]["availability_ratio"] == 20.0


class _JsonRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


@pytest.mark.asyncio
async def test_toggle_node_only_changes_matching_identity_in_requested_group(monkeypatch):
    target = _node(port=443)
    duplicate = deepcopy(target)
    duplicate["name"] = "same-route"
    other_route = _node(port=8443)
    other_group = _node(group_id="group-b", port=443)
    saved_nodes = [target, duplicate, other_route, other_group]
    published = []
    db_updates = []

    async def require_admin(*args, **kwargs):
        return {"username": "admin"}, None

    async def apply_nodes(nodes, base_port, **kwargs):
        published.append(deepcopy(nodes))
        return {"success": True, "message": "ready"}

    async def update_counts(group_id, total, active):
        db_updates.append((group_id, total, active))
        return True

    monkeypatch.setattr(proxy_server, "_require_admin_token", require_admin)
    monkeypatch.setattr(singbox_manager, "load_saved_nodes", lambda: deepcopy(saved_nodes))
    monkeypatch.setattr(proxy_server, "_apply_subscription_runtime_nodes", apply_nodes)
    monkeypatch.setattr(proxy_server.db, "update_subscription_group_servers", update_counts)
    monkeypatch.setattr(proxy_server._SINGBOX_STATUS_CACHE, "invalidate", lambda: None)
    monkeypatch.setattr(proxy_server._DISPATCHER_STATUS_SERVICE, "invalidate_meta", lambda: None)

    result = await proxy_server.admin_toggle_subscription_node(
        "group-a",
        _JsonRequest({"node_identity": subscription_node_identity(target), "enabled": False}),
    )

    assert result["success"] is True
    assert [node["enabled"] for node in published[0]] == [False, False, True, True]
    assert db_updates == [("group-a", 2, 1)]
