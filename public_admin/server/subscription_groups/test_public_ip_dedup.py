from pathlib import Path

import pytest

from public_admin.server.subscription_groups.identity import subscription_node_identity
from public_admin.server.subscription_groups.public_ip_dedup import PublicIpObservationStore, PublicIpScanner


def _node(name: str, port: int) -> dict:
    return {
        "name": name, "display_name": name, "group_id": "g", "type": "vless",
        "server": f"{name}.example.com", "port": 443, "local_port": port,
        "core_supported": True, "enabled": True, "raw": {"uuid": name},
    }


def test_one_observation_never_removes_a_node(tmp_path: Path):
    nodes = [_node("first", 32101), _node("same-ip", 32102)]
    store = PublicIpObservationStore(tmp_path / "state.json")
    for node in nodes:
        store.record_success(subscription_node_identity(node), "157.254.20.4")

    result = store.select_runtime_nodes(nodes)

    assert [node["name"] for node in result["nodes"]] == ["first", "same-ip"]
    assert result["standby_count"] == 0
    assert all(node["enabled"] is True for node in nodes)


def test_two_matching_observations_select_stable_primary_without_disabling(tmp_path: Path):
    nodes = [_node("first", 32101), _node("same-ip", 32102), _node("other", 32103)]
    store = PublicIpObservationStore(tmp_path / "state.json")
    for node in nodes[:2]:
        identity = subscription_node_identity(node)
        store.record_success(identity, "157.254.20.4")
        store.record_success(identity, "157.254.20.4")
    other_identity = subscription_node_identity(nodes[2])
    store.record_success(other_identity, "114.26.125.154")
    store.record_success(other_identity, "114.26.125.154")

    first = store.select_runtime_nodes(nodes)
    second = store.select_runtime_nodes(list(reversed(nodes)))

    assert [node["name"] for node in first["nodes"]] == ["first", "other"]
    assert [node["name"] for node in second["nodes"]] == ["other", "first"]
    duplicate_identity = subscription_node_identity(nodes[1])
    assert first["roles"][duplicate_identity]["role"] == "standby_shared_ip"
    assert all(node["enabled"] is True for node in nodes)


def test_changed_successful_ip_revokes_confirmation_and_restores_node(tmp_path: Path):
    node = _node("rotating", 32101)
    store = PublicIpObservationStore(tmp_path / "state.json")
    identity = subscription_node_identity(node)
    store.record_success(identity, "157.254.20.4")
    store.record_success(identity, "157.254.20.4")
    store.record_success(identity, "114.26.125.154")

    assert store.observation(identity)["confirmed_ip"] == ""
    assert store.select_runtime_nodes([node])["nodes"][0]["public_ip_runtime_role"] == "unconfirmed"


@pytest.mark.asyncio
async def test_scan_failure_only_records_diagnostics_and_does_not_select(tmp_path: Path, monkeypatch):
    node = _node("broken", 32101)
    scanner = PublicIpScanner(PublicIpObservationStore(tmp_path / "state.json"))

    async def failed_probe(exit_item, semaphore):
        return exit_item["node_identity"], "", "ReadTimeout"

    monkeypatch.setattr(scanner, "_probe", failed_probe)
    result = await scanner.scan_once([{"node_identity": subscription_node_identity(node), "local_port": 32101}])

    assert result == {"scanned": 1, "success": 0, "failed": 1}
    assert scanner.store.select_runtime_nodes([node])["nodes"][0]["name"] == "broken"
