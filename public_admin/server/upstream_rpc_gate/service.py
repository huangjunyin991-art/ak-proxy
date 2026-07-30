from __future__ import annotations

import asyncio
import hashlib
import time
import uuid
from dataclasses import dataclass
from typing import Any, Mapping


class RpcGateBusy(RuntimeError):
    pass


@dataclass(frozen=True)
class RpcGateLease:
    identity: str
    holder: str
    include_global: bool = True


def build_rpc_identity(params: Mapping[str, Any] | None) -> str:
    values = params or {}
    user_id = str(values.get("UserID") or values.get("userId") or values.get("userid") or "").strip()
    if user_id:
        return "user:" + user_id
    key = str(values.get("key") or values.get("Key") or "").strip()
    if key:
        return "key:" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:24]
    account = str(values.get("account") or values.get("Account") or "").strip().lower()
    return "account:" + (account or "unknown")


class UpstreamRpcGate:
    def __init__(self, repository) -> None:
        self.repository = repository

    async def reserve_external(self, identity: str, wait_seconds: float = 25.0) -> RpcGateLease | None:
        holder = "external-" + uuid.uuid4().hex
        deadline = time.monotonic() + max(0.2, float(wait_seconds or 0.2))
        while time.monotonic() < deadline:
            if await self.repository.try_claim(identity, holder, external=True):
                return RpcGateLease(identity, holder)
            await asyncio.sleep(0.1)
        return None

    async def try_reserve_background(self, identity: str) -> RpcGateLease | None:
        holder = "background-" + uuid.uuid4().hex
        if await self.repository.try_claim(identity, holder, external=False):
            return RpcGateLease(identity, holder)
        return None

    async def reserve_ak_sell(self, identity: str, wait_seconds: float = 25.0) -> RpcGateLease | None:
        """Reserve only the account lock for trusted AK sell service traffic.

        Normal public RPC calls retain the global lock.  AK sell requests are
        already routed through independent tunnels, so only same-account calls
        need exclusion here.
        """
        holder = "ak-sell-" + uuid.uuid4().hex
        deadline = time.monotonic() + max(0.2, float(wait_seconds or 0.2))
        while time.monotonic() < deadline:
            if await self.repository.try_claim(
                identity,
                holder,
                external=False,
                include_global=False,
            ):
                return RpcGateLease(identity, holder, include_global=False)
            await asyncio.sleep(0.1)
        return None

    async def release(self, lease: RpcGateLease | None) -> None:
        if lease is not None:
            await self.repository.release(
                lease.identity,
                lease.holder,
                include_global=lease.include_global,
            )
