from pathlib import Path

import pytest

from public_admin.server.subscription_groups.public_ip_dedup import PublicIpDeduplicator


def _node(name: str, port: int, *, group_id: str = "g") -> dict:
    return {
        "name": name,
        "display_name": name,
        "group_id": group_id,
        "type": "vless",
        "server": f"{name}.example.com",
        "port": 443,
        "local_port": port,
        "core_supported": True,
        "enabled": True,
        "raw": {"uuid": name},
    }


@pytest.mark.asyncio
async def test_deduplicate_keeps_one_node_per_public_ip(tmp_path: Path, monkeypatch):
    nodes = [_node("first", 32101), _node("duplicate", 32102), _node("other", 32103)]
    dedup = PublicIpDeduplicator(cache_path=tmp_path / "cache.json")

    async def fake_probe(node, semaphore):
        from public_admin.server.subscription_groups.identity import subscription_node_identity

        return subscription_node_identity(node), ("157.254.20.4" if node["name"] != "other" else "114.26.125.154")

    monkeypatch.setattr(dedup, "_probe_node", fake_probe)
    result = await dedup.deduplicate(nodes)

    assert [node["name"] for node in result["nodes"]] == ["first", "other"]
    assert result["duplicate_count"] == 1
    assert result["unique_public_ips"] == 2


@pytest.mark.asyncio
async def test_deduplicate_preserves_unknown_nodes(tmp_path: Path, monkeypatch):
    nodes = [_node("reachable", 32101), _node("unknown", 32102)]
    dedup = PublicIpDeduplicator(cache_path=tmp_path / "cache.json")

    async def fake_probe(node, semaphore):
        from public_admin.server.subscription_groups.identity import subscription_node_identity

        return subscription_node_identity(node), "114.26.125.154" if node["name"] == "reachable" else ""

    monkeypatch.setattr(dedup, "_probe_node", fake_probe)
    result = await dedup.deduplicate(nodes)

    assert {node["name"] for node in result["nodes"]} == {"reachable", "unknown"}
    assert result["duplicate_count"] == 0
    assert result["unknown_count"] == 1


@pytest.mark.asyncio
async def test_deduplicate_uses_cached_representative(tmp_path: Path, monkeypatch):
    nodes = [_node("first", 32101), _node("duplicate", 32102)]
    dedup = PublicIpDeduplicator(cache_path=tmp_path / "cache.json")

    async def fake_probe(node, semaphore):
        from public_admin.server.subscription_groups.identity import subscription_node_identity

        return subscription_node_identity(node), "157.254.20.4"

    monkeypatch.setattr(dedup, "_probe_node", fake_probe)
    first = await dedup.deduplicate(nodes)
    assert [node["name"] for node in first["nodes"]] == ["first"]

    # A later subscription refresh can reorder nodes; the cached representative
    # keeps the same route when both identities are still present.
    second = await dedup.deduplicate(list(reversed(nodes)))
    assert [node["name"] for node in second["nodes"]] == ["first"]


@pytest.mark.asyncio
async def test_deduplicate_removes_identical_route_copies(tmp_path: Path, monkeypatch):
    first = _node("same", 32101)
    duplicate = dict(first, local_port=32102)
    dedup = PublicIpDeduplicator(cache_path=tmp_path / "cache.json")

    async def fake_probe(node, semaphore):
        from public_admin.server.subscription_groups.identity import subscription_node_identity

        return subscription_node_identity(node), "157.254.20.4"

    monkeypatch.setattr(dedup, "_probe_node", fake_probe)
    result = await dedup.deduplicate([first, duplicate])

    assert len(result["nodes"]) == 1
    assert result["duplicate_count"] == 1
