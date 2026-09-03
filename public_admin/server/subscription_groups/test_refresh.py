import asyncio

import pytest

from public_admin.server.subscription_groups.refresh import SubscriptionRefreshService
from public_admin.server.subscription_groups.identity import subscription_node_identity


def _node(group_id="g", port=443, enabled=True):
    return {
        "group_id": group_id,
        "group_name": "old",
        "source_type": "url",
        "source_url": "https://feed.example/token",
        "name": f"node-{port}",
        "display_name": f"node-{port}",
        "type": "vless",
        "server": f"edge-{port}.example.com",
        "port": port,
        "raw": {"uuid": f"uuid-{port}"},
        "enabled": enabled,
    }


def _service(fetcher, applier, *, threshold=10.0):
    return SubscriptionRefreshService(
        groups_loader=lambda: asyncio.sleep(0, result=[]),
        nodes_loader=lambda: [],
        exits_loader=lambda: [],
        fetcher=fetcher,
        applier=applier,
        group_counter_updater=lambda *args: asyncio.sleep(0, result=True),
        logger=__import__("logging").getLogger("test-sub-refresh"),
        availability_threshold=threshold,
        cooldown_seconds=0,
    )


@pytest.mark.asyncio
async def test_refresh_only_triggers_below_ten_percent(monkeypatch):
    service = _service(lambda _: asyncio.sleep(0, result={"nodes": [_node(port=1)]}), lambda _: asyncio.sleep(0, result={"success": True}))
    group = {"id": "g", "name": "group", "source_type": "url", "source_url": "https://feed.example/token"}
    nodes = [_node(port=index) for index in range(10)]
    exits = [
        {"node_identity": subscription_node_identity(node), "dispatch_ready": index == 0, "frozen": False}
        for index, node in enumerate(nodes)
    ]

    result = await service.refresh_group(group, saved_nodes=nodes, exits=exits)
    assert result.triggered is False
    assert result.reason == "health_above_threshold"

    exits[0]["dispatch_ready"] = False
    result = await service.refresh_group(group, saved_nodes=nodes, exits=exits, force=True)
    assert result.triggered is True
    assert result.success is True


@pytest.mark.asyncio
async def test_empty_refresh_keeps_old_generation():
    applied = []
    service = _service(
        lambda _: asyncio.sleep(0, result={"nodes": [], "error": "empty_subscription"}),
        lambda nodes: applied.append(nodes) or asyncio.sleep(0, result={"success": True}),
    )
    group = {"id": "g", "name": "group", "source_type": "url", "source_url": "https://feed.example/token"}
    result = await service.refresh_group(group, saved_nodes=[_node()], exits=[], force=True)
    assert result.success is False
    assert result.reason == "empty_subscription"
    assert applied == []


@pytest.mark.asyncio
async def test_failed_apply_keeps_old_generation_and_preserves_other_groups():
    applied = []
    service = _service(
        lambda _: asyncio.sleep(0, result={"nodes": [_node(port=8443, enabled=True)]}),
        lambda nodes: applied.append(nodes) or asyncio.sleep(0, result={"success": False, "message": "core not ready"}),
    )
    group = {"id": "g", "name": "group", "source_type": "url", "source_url": "https://feed.example/token"}
    old = [_node(), _node(group_id="other", port=9443)]
    result = await service.refresh_group(group, saved_nodes=old, exits=[], force=True)
    assert result.success is False
    assert "core not ready" in result.reason
    assert len(applied) == 1
    assert any(node["group_id"] == "other" for node in applied[0])


@pytest.mark.asyncio
async def test_run_once_reloads_generation_between_groups():
    groups = [
        {"id": "g1", "name": "one", "source_type": "url", "source_url": "https://one.example/token"},
        {"id": "g2", "name": "two", "source_type": "url", "source_url": "https://two.example/token"},
    ]
    nodes = [_node(group_id="g1"), _node(group_id="g2", port=8443)]
    current_nodes = list(nodes)
    applied_generations = []

    async def fetch(url):
        port = 9443 if "two" in url else 443
        return {"nodes": [_node(group_id="g1" if "one" in url else "g2", port=port)]}

    async def apply(candidate):
        nonlocal current_nodes
        current_nodes = candidate
        applied_generations.append(candidate)
        return {"success": True}

    service = SubscriptionRefreshService(
        groups_loader=lambda: asyncio.sleep(0, result=groups),
        nodes_loader=lambda: current_nodes,
        exits_loader=lambda: [],
        fetcher=fetch,
        applier=apply,
        group_counter_updater=lambda *args: asyncio.sleep(0, result=True),
        logger=__import__("logging").getLogger("test-sub-refresh"),
        cooldown_seconds=0,
    )
    await service.run_once()
    assert len(applied_generations) == 2
    assert {node["group_id"] for node in applied_generations[-1]} == {"g1", "g2"}
    assert any(node["port"] == 443 for node in applied_generations[-1])
    assert any(node["port"] == 9443 for node in applied_generations[-1])
