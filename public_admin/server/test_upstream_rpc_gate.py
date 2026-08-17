from __future__ import annotations

import pytest

from .upstream_rpc_gate import UpstreamRpcGate, build_rpc_identity


def test_build_rpc_identity_prefers_account_over_user_id_and_key():
    assert build_rpc_identity({
        "account": " Cyh6699 ",
        "UserID": "931119",
        "key": "secret",
    }) == "account:cyh6699"


def test_build_rpc_identity_falls_back_to_user_id_then_key():
    assert build_rpc_identity({"UserID": "931119", "key": "secret"}) == "user:931119"
    assert build_rpc_identity({"key": "secret"}).startswith("key:")
    assert build_rpc_identity({}) == "unknown"


@pytest.mark.anyio
async def test_gate_serializes_same_account_but_allows_different_accounts():
    class Repository:
        def __init__(self):
            self.held = set()

        async def try_claim(self, identity, holder, *, external):
            if identity in self.held:
                return False
            self.held.add(identity)
            return True

        async def release(self, identity, holder):
            self.held.discard(identity)

    repository = Repository()
    gate = UpstreamRpcGate(repository)

    first = await gate.reserve_external("account:first", wait_seconds=0.2)
    second = await gate.reserve_external("account:second", wait_seconds=0.2)
    blocked = await gate.reserve_external("account:first", wait_seconds=0.2)

    assert first is not None
    assert second is not None
    assert blocked is None

    await gate.release(first)
    unblocked = await gate.reserve_external("account:first", wait_seconds=0.2)
    assert unblocked is not None
