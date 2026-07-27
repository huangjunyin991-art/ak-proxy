import asyncio
from pathlib import Path

import pytest

from public_admin.server.proxy_cores import manager
from public_admin.server.proxy_cores.classifier import MIHOMO_CORE, SINGBOX_CORE
from public_admin.server.proxy_cores.rolling import StagedCore


def _stage(core_type: str, base_port: int, nodes_count: int = 1) -> StagedCore:
    return StagedCore(
        core_type=core_type,
        nodes_count=nodes_count,
        base_port=base_port,
        staging_config_path=Path(f"/{core_type}-candidate"),
        active_config_path=Path(f"/{core_type}-active"),
    )


@pytest.mark.asyncio
async def test_rollover_activates_only_after_both_candidates_are_ready(monkeypatch):
    events = []
    singbox_stage = _stage(SINGBOX_CORE, 30001)
    mihomo_stage = _stage(MIHOMO_CORE, 31001, nodes_count=0)

    async def stage_singbox(nodes, base_port):
        events.append(("stage", SINGBOX_CORE, base_port))
        return {"success": True, "message": "ready", "nodes_count": len(nodes), "stage": singbox_stage}

    async def stage_mihomo(nodes, base_port):
        events.append(("stage", MIHOMO_CORE, base_port))
        return {"success": True, "message": "ready", "nodes_count": len(nodes), "stage": mihomo_stage}

    monkeypatch.setattr(manager.singbox_core, "stage_nodes", stage_singbox)
    monkeypatch.setattr(manager.mihomo_core, "stage_nodes", stage_mihomo)
    monkeypatch.setattr(manager.singbox_core, "promote_stage", lambda stage: events.append(("promote", stage.core_type)))
    monkeypatch.setattr(manager.mihomo_core, "promote_stage", lambda stage: events.append(("promote", stage.core_type)))
    monkeypatch.setattr(manager.singbox_core, "retire_stage_previous", lambda stage: events.append(("retire", stage.core_type)))
    monkeypatch.setattr(manager.mihomo_core, "retire_stage_previous", lambda stage: events.append(("retire", stage.core_type)))
    monkeypatch.setattr(
        manager,
        "candidate_base_port",
        lambda core, default, required_ports=1, reserved_ranges=(): 30001 if core == SINGBOX_CORE else 31001,
    )
    monkeypatch.setattr(manager, "mark_active_base_port", lambda *args: None)
    monkeypatch.setattr(manager, "clear_active_base_port", lambda *args: None)
    monkeypatch.setattr(manager, "DRAIN_SECONDS", 0)

    async def activate(runtime_nodes):
        events.append(("activate", [node["local_port"] for node in runtime_nodes if node.get("core_supported")]))

    result = await manager.apply_nodes([
        {
            "name": "SS",
            "type": "ss",
            "server": "node.example.com",
            "port": 443,
            "raw": {"cipher": "aes-128-gcm", "password": "secret"},
        },
    ], activation_callback=activate)
    await asyncio.sleep(0)

    assert result["success"] is True
    assert events[:5] == [
        ("stage", SINGBOX_CORE, 30001),
        ("stage", MIHOMO_CORE, 31001),
        ("promote", SINGBOX_CORE),
        ("promote", MIHOMO_CORE),
        ("activate", [30001]),
    ]


@pytest.mark.asyncio
async def test_rollover_discards_ready_candidate_when_other_core_fails(monkeypatch):
    events = []
    singbox_stage = _stage(SINGBOX_CORE, 30001)

    async def stage_singbox(nodes, base_port):
        return {"success": True, "message": "ready", "nodes_count": len(nodes), "stage": singbox_stage}

    async def stage_mihomo(nodes, base_port):
        return {"success": False, "message": "candidate failed", "nodes_count": len(nodes)}

    monkeypatch.setattr(manager.singbox_core, "stage_nodes", stage_singbox)
    monkeypatch.setattr(manager.mihomo_core, "stage_nodes", stage_mihomo)
    monkeypatch.setattr(manager.singbox_core, "discard_stage", lambda stage: events.append(("discard", stage.core_type)))
    monkeypatch.setattr(
        manager,
        "candidate_base_port",
        lambda core, default, required_ports=1, reserved_ranges=(): 30001 if core == SINGBOX_CORE else 31001,
    )

    activated = False

    async def activate(runtime_nodes):
        nonlocal activated
        activated = True

    result = await manager.apply_nodes([
        {
            "name": "SS",
            "type": "ss",
            "server": "node.example.com",
            "port": 443,
            "raw": {"cipher": "aes-128-gcm", "password": "secret"},
        },
    ], activation_callback=activate)

    assert result["success"] is False
    assert activated is False
    assert events == [("discard", SINGBOX_CORE)]


@pytest.mark.asyncio
async def test_rollover_allows_intentional_empty_generation(monkeypatch):
    events = []
    singbox_stage = _stage(SINGBOX_CORE, 30001, nodes_count=0)
    mihomo_stage = _stage(MIHOMO_CORE, 31001, nodes_count=0)

    async def stage_singbox(nodes, base_port):
        return {"success": True, "message": "empty ready", "nodes_count": len(nodes), "stage": singbox_stage}

    async def stage_mihomo(nodes, base_port):
        return {"success": True, "message": "empty ready", "nodes_count": len(nodes), "stage": mihomo_stage}

    monkeypatch.setattr(manager.singbox_core, "stage_nodes", stage_singbox)
    monkeypatch.setattr(manager.mihomo_core, "stage_nodes", stage_mihomo)
    monkeypatch.setattr(manager.singbox_core, "promote_stage", lambda stage: events.append(("promote", stage.core_type)))
    monkeypatch.setattr(manager.mihomo_core, "promote_stage", lambda stage: events.append(("promote", stage.core_type)))
    monkeypatch.setattr(manager.singbox_core, "retire_stage_previous", lambda stage: None)
    monkeypatch.setattr(manager.mihomo_core, "retire_stage_previous", lambda stage: None)
    monkeypatch.setattr(
        manager,
        "candidate_base_port",
        lambda core, default, required_ports=1, reserved_ranges=(): 30001 if core == SINGBOX_CORE else 31001,
    )
    monkeypatch.setattr(manager, "mark_active_base_port", lambda *args: None)
    monkeypatch.setattr(manager, "clear_active_base_port", lambda *args: None)
    monkeypatch.setattr(manager, "DRAIN_SECONDS", 0)

    result = await manager.apply_nodes([], allow_empty=True)
    await asyncio.sleep(0)

    assert result["success"] is True
    assert result["nodes_count"] == 0
    assert events == [("promote", SINGBOX_CORE), ("promote", MIHOMO_CORE)]
