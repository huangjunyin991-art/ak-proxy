"""Safe observation and selection of subscription nodes by public egress IP.

This module deliberately has no dependency on proxy-core staging. A failed IP
probe is diagnostic data only: it must never remove a node, mutate ``enabled``,
or interrupt a serving generation.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import time
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterable

import httpx

from .identity import subscription_node_identity

logger = logging.getLogger("TransparentProxy")
DEFAULT_PROBE_URL = "https://api.ipify.org"


def _default_state_path() -> Path:
    configured = os.environ.get("AK_PUBLIC_IP_STATE_FILE")
    return Path(configured) if configured else Path.home() / ".cache" / "ak-proxy" / "public_ip_state.json"


def _global_ip(value: Any) -> str:
    try:
        parsed = ipaddress.ip_address(str(value or "").strip())
    except ValueError:
        return ""
    return str(parsed) if parsed.is_global else ""


class PublicIpObservationStore:
    """Durable, failure-tolerant observations keyed by immutable node identity."""

    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path else _default_state_path()
        self.payload = self._load()

    def _load(self) -> dict[str, Any]:
        try:
            parsed = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(parsed, dict) and isinstance(parsed.get("nodes", {}), dict):
                parsed.setdefault("representatives", {})
                return parsed
        except (FileNotFoundError, OSError, TypeError, ValueError):
            pass
        return {"version": 1, "nodes": {}, "representatives": {}}

    def save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
            temporary.write_text(json.dumps(self.payload, ensure_ascii=True, sort_keys=True, indent=2), encoding="utf-8")
            os.replace(temporary, self.path)
        except OSError as exc:
            logger.warning("[PublicIpScan] observation state save failed: %s", exc)

    def observation(self, identity: str) -> dict[str, Any]:
        entry = self.payload.get("nodes", {}).get(identity)
        return dict(entry) if isinstance(entry, dict) else {}

    def record_success(self, identity: str, public_ip: str, *, checked_at: float | None = None) -> dict[str, Any]:
        public_ip = _global_ip(public_ip)
        if not public_ip:
            return self.record_failure(identity, "invalid_public_ip", checked_at=checked_at)
        nodes = self.payload.setdefault("nodes", {})
        previous = nodes.get(identity) if isinstance(nodes.get(identity), dict) else {}
        same = str(previous.get("observed_ip") or "") == public_ip
        consecutive = int(previous.get("consecutive_matches") or 0) + 1 if same else 1
        entry = {
            **previous,
            "observed_ip": public_ip,
            "consecutive_matches": consecutive,
            "confirmed_ip": public_ip if consecutive >= 2 else "",
            "last_checked_at": float(checked_at if checked_at is not None else time.time()),
            "last_error": "",
        }
        nodes[identity] = entry
        return dict(entry)

    def record_failure(self, identity: str, reason: str, *, checked_at: float | None = None) -> dict[str, Any]:
        nodes = self.payload.setdefault("nodes", {})
        previous = nodes.get(identity) if isinstance(nodes.get(identity), dict) else {}
        # One failed diagnostic probe must not erase an already confirmed route.
        entry = {
            **previous,
            "last_checked_at": float(checked_at if checked_at is not None else time.time()),
            "last_error": str(reason or "probe_failed")[:160],
        }
        nodes[identity] = entry
        return dict(entry)

    def select_runtime_nodes(self, nodes: Iterable[dict[str, Any]]) -> dict[str, Any]:
        """Build a separate runtime set without modifying the node catalogue."""
        catalog = [deepcopy(node) for node in nodes if isinstance(node, dict)]
        groups: dict[str, list[tuple[int, str]]] = {}
        roles: dict[str, dict[str, str]] = {}
        logical_routes: dict[str, list[int]] = {}
        for index, node in enumerate(catalog):
            identity = subscription_node_identity(node)
            logical_routes.setdefault(identity, []).append(index)

        selected_indexes: set[int] = set()
        for identity, indexes in logical_routes.items():
            # Preserve manual intent when identical copies disagree: use an
            # enabled copy if one exists, otherwise retain the first disabled
            # copy so normal core filtering keeps its established semantics.
            index = next((item for item in indexes if catalog[item].get("enabled", True) is not False), indexes[0])
            node = catalog[index]
            selected_indexes.add(index)
            confirmed_ip = _global_ip(self.observation(identity).get("confirmed_ip"))
            if confirmed_ip:
                groups.setdefault(confirmed_ip, []).append((index, identity))
            else:
                roles[identity] = {"role": "unconfirmed", "public_exit_ip": ""}

        representatives = self.payload.setdefault("representatives", {})
        standby_count = 0
        for public_ip, members in groups.items():
            preferred = str(representatives.get(public_ip) or "")
            chosen_index, chosen_identity = next((item for item in members if item[1] == preferred), members[0])
            representatives[public_ip] = chosen_identity
            roles[chosen_identity] = {"role": "primary", "public_exit_ip": public_ip}
            for index, identity in members:
                if index == chosen_index:
                    continue
                selected_indexes.discard(index)
                roles[identity] = {"role": "standby_shared_ip", "public_exit_ip": public_ip}
                standby_count += 1

        runtime_nodes: list[dict[str, Any]] = []
        for index, node in enumerate(catalog):
            identity = subscription_node_identity(node)
            role = roles.get(identity, {"role": "unconfirmed", "public_exit_ip": ""})
            if index in selected_indexes:
                node["public_exit_ip"] = role["public_exit_ip"]
                node["public_ip_runtime_role"] = role["role"]
                runtime_nodes.append(node)
        return {
            "nodes": runtime_nodes,
            "roles": roles,
            "standby_count": standby_count,
            "confirmed_ip_count": len(groups),
        }


class PublicIpScanner:
    """Low-concurrency scanner of already-running SOCKS exits only."""

    def __init__(self, store: PublicIpObservationStore | None = None, *, probe_url: str | None = None,
                 timeout_seconds: float = 5.0, concurrency: int = 5) -> None:
        self.store = store or PublicIpObservationStore()
        self.probe_url = str(probe_url or os.environ.get("AK_PUBLIC_IP_PROBE_URL") or DEFAULT_PROBE_URL).strip()
        self.timeout_seconds = max(1.0, min(float(timeout_seconds), 10.0))
        self.concurrency = max(1, min(int(concurrency), 5))

    async def _probe(self, exit_item: dict[str, Any], semaphore: asyncio.Semaphore) -> tuple[str, str, str]:
        identity = str(exit_item.get("node_identity") or "").strip()
        try:
            port = int(exit_item.get("local_port") or 0)
        except (TypeError, ValueError):
            port = 0
        if not identity or port <= 0:
            return identity, "", "missing_identity_or_port"
        timeout = httpx.Timeout(self.timeout_seconds, connect=min(2.0, self.timeout_seconds))
        async with semaphore:
            try:
                async with httpx.AsyncClient(proxy=f"socks5://127.0.0.1:{port}", timeout=timeout,
                                             follow_redirects=False, trust_env=False) as client:
                    response = await client.get(self.probe_url, headers={"Accept": "text/plain", "User-Agent": "AK-Proxy-IP-Observer/2.0"})
                public_ip = _global_ip(response.text) if 200 <= response.status_code < 300 else ""
                return identity, public_ip, "" if public_ip else f"http_{response.status_code}"
            except Exception as exc:
                return identity, "", type(exc).__name__

    async def scan_once(self, exits: Iterable[dict[str, Any]]) -> dict[str, int]:
        unique: dict[str, dict[str, Any]] = {}
        for item in exits:
            if isinstance(item, dict):
                identity = str(item.get("node_identity") or "").strip()
                if identity and identity not in unique:
                    unique[identity] = item
        semaphore = asyncio.Semaphore(self.concurrency)
        results = await asyncio.gather(*(self._probe(item, semaphore) for item in unique.values()))
        success = 0
        for identity, public_ip, reason in results:
            if public_ip:
                self.store.record_success(identity, public_ip)
                success += 1
            elif identity:
                self.store.record_failure(identity, reason)
        self.store.save()
        return {"scanned": len(results), "success": success, "failed": len(results) - success}


def public_ip_role(identity: str, *, state_path: str | Path | None = None) -> dict[str, str]:
    """Return UI-safe diagnostic state without requiring a live scanner."""
    observed = PublicIpObservationStore(state_path).observation(identity)
    confirmed_ip = _global_ip(observed.get("confirmed_ip"))
    return {"public_exit_ip": confirmed_ip, "public_ip_state": "confirmed" if confirmed_ip else ("observed" if observed.get("observed_ip") else "unknown")}
