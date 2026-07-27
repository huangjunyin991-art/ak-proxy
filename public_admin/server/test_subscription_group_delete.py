from copy import deepcopy

import pytest

from public_admin.server import proxy_cores, proxy_server, singbox_manager


def test_dispatcher_node_identity_ignores_local_port_but_tracks_upstream_changes():
    node = {
        "group_id": "keep",
        "name": "node-a",
        "type": "ss",
        "server": "node.example.com",
        "port": 8388,
        "raw": {"type": "ss", "cipher": "aes-128-gcm", "password": "secret"},
    }
    moved_port = {**node, "local_port": 30001}
    changed_upstream = {**node, "raw": {**node["raw"], "password": "new-secret"}}

    original = proxy_server._build_dispatcher_exit_specs([{**node, "local_port": 10001}], 10001)[0]
    replacement = proxy_server._build_dispatcher_exit_specs([moved_port], 10001)[0]
    changed = proxy_server._build_dispatcher_exit_specs([changed_upstream], 10001)[0]

    assert original["node_identity"] == replacement["node_identity"]
    assert original["node_identity"] != changed["node_identity"]


@pytest.mark.asyncio
async def test_delete_group_uses_candidate_nodes_before_deleting_record(monkeypatch):
    target_group = {"id": "remove", "name": "Remove me"}
    groups = [target_group, {"id": "keep", "name": "Keep me"}]
    saved_nodes = [
        {"group_id": "remove", "name": "remove-1"},
        {"group_id": "remove", "name": "remove-2"},
        {"group_id": "keep", "name": "keep-1"},
    ]
    events = []

    async def require_admin(*args, **kwargs):
        return {"username": "admin"}, None

    async def get_groups():
        return groups

    async def delete_group(group_id):
        events.append(("delete", group_id))
        return True

    async def restore_group(group):
        events.append(("restore", group["id"]))
        return True

    async def apply_candidate(nodes, base_port, **kwargs):
        events.append(("candidate", [node["group_id"] for node in nodes], kwargs["allow_empty_generation"]))
        await kwargs["before_publish"]()
        return {"success": True, "message": "ready", "nodes_count": len(nodes)}

    monkeypatch.setattr(proxy_server, "_require_admin_token", require_admin)
    monkeypatch.setattr(proxy_server.db, "get_subscription_groups", get_groups)
    monkeypatch.setattr(proxy_server.db, "delete_subscription_group", delete_group)
    monkeypatch.setattr(proxy_server.db, "restore_subscription_group", restore_group)
    monkeypatch.setattr(singbox_manager, "load_saved_nodes", lambda: deepcopy(saved_nodes))
    monkeypatch.setattr(proxy_server, "_apply_subscription_runtime_nodes", apply_candidate)
    monkeypatch.setattr(proxy_server._SINGBOX_STATUS_CACHE, "invalidate", lambda: None)
    monkeypatch.setattr(proxy_server._DISPATCHER_STATUS_SERVICE, "invalidate_meta", lambda: None)

    result = await proxy_server.admin_delete_subscription_group("remove", object())

    assert result["success"] is True
    assert "2" in result["message"]
    assert events == [
        ("candidate", ["keep"], True),
        ("delete", "remove"),
    ]


@pytest.mark.asyncio
async def test_delete_group_keeps_database_record_when_candidate_fails(monkeypatch):
    target_group = {"id": "remove", "name": "Remove me"}
    deleted = False

    async def require_admin(*args, **kwargs):
        return {"username": "admin"}, None

    async def get_groups():
        return [target_group]

    async def delete_group(group_id):
        nonlocal deleted
        deleted = True
        return True

    async def apply_candidate(nodes, base_port, **kwargs):
        return {"success": False, "message": "candidate unavailable"}

    monkeypatch.setattr(proxy_server, "_require_admin_token", require_admin)
    monkeypatch.setattr(proxy_server.db, "get_subscription_groups", get_groups)
    monkeypatch.setattr(proxy_server.db, "delete_subscription_group", delete_group)
    monkeypatch.setattr(singbox_manager, "load_saved_nodes", lambda: [{"group_id": "remove", "name": "remove-1"}])
    monkeypatch.setattr(proxy_server, "_apply_subscription_runtime_nodes", apply_candidate)

    result = await proxy_server.admin_delete_subscription_group("remove", object())

    assert result["success"] is False
    assert "candidate unavailable" in result["message"]
    assert deleted is False


@pytest.mark.asyncio
async def test_runtime_publish_failure_restores_saved_nodes_and_group_record(monkeypatch, tmp_path):
    old_nodes = [{"group_id": "old", "name": "old-node"}]
    saved_generations = []
    callbacks = []

    def save_nodes(nodes):
        saved_generations.append(deepcopy(nodes))

    async def fake_apply_nodes(nodes, *, singbox_base_port, activation_callback, allow_empty):
        try:
            await activation_callback(nodes)
        except Exception as exc:
            return {"success": False, "message": str(exc)}
        return {"success": True, "message": "ready"}

    async def before_publish():
        callbacks.append("delete")

    async def rollback_publish():
        callbacks.append("restore")

    def replace_exits(specs):
        raise RuntimeError("dispatcher replacement failed")

    monkeypatch.setattr(proxy_server, "PUBLIC_ADMIN_DIR", str(tmp_path))
    monkeypatch.setattr(singbox_manager, "load_saved_nodes", lambda: deepcopy(old_nodes))
    monkeypatch.setattr(singbox_manager, "save_nodes", save_nodes)
    monkeypatch.setattr(proxy_cores, "apply_nodes", fake_apply_nodes)
    monkeypatch.setattr(proxy_server.dispatcher, "replace_socks5_exits", replace_exits)

    result = await proxy_server._apply_subscription_runtime_nodes(
        [{"group_id": "new", "name": "new-node"}],
        10001,
        before_publish=before_publish,
        rollback_before_publish=rollback_publish,
    )

    assert result["success"] is False
    assert callbacks == ["delete", "restore"]
    assert saved_generations[-1] == old_nodes
    assert not (tmp_path / "dispatcher_exits.json").exists()
