"""Deduplicate runtime subscription nodes by their observed public egress IP."""

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


class PublicIpDedupRequired(RuntimeError):
    """Signal that a staged candidate must be rebuilt without duplicate exits."""

    def __init__(self, nodes: list[dict[str, Any]], details: dict[str, Any]):
        super().__init__("public egress IP duplicates detected")
        self.retry_nodes = nodes
        self.details = details


class PublicIpDeduplicator:
    """Probe candidate SOCKS listeners and keep one node for each public IP."""

    def __init__(
        self,
        *,
        probe_url: str | None = None,
        cache_path: str | Path | None = None,
        timeout_seconds: float = 5.0,
        cache_ttl_seconds: float = 15 * 60,
        concurrency: int = 32,
    ) -> None:
        self.probe_url = str(
            probe_url or os.environ.get("AK_PUBLIC_IP_PROBE_URL") or "https://api.ipify.org"
        ).strip()
        self.cache_path = Path(
            cache_path
            or os.environ.get("AK_PUBLIC_IP_CACHE_FILE")
            or (Path.home() / ".cache" / "ak-proxy" / "public_ip_cache.json")
        )
        self.timeout_seconds = max(1.0, min(float(timeout_seconds), 15.0))
        self.cache_ttl_seconds = max(60.0, float(cache_ttl_seconds))
        self.concurrency = max(1, min(int(concurrency), 32))
        self._cache: dict[str, Any] = self._load_cache()
        self._cache_lock = asyncio.Lock()

    def _load_cache(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
            return payload if isinstance(payload, dict) else {}
        except (FileNotFoundError, OSError, ValueError, TypeError):
            return {}

    async def _save_cache(self) -> None:
        async with self._cache_lock:
            try:
                self.cache_path.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.cache_path.with_suffix(f".{os.getpid()}.tmp")
                temporary.write_text(
                    json.dumps(self._cache, ensure_ascii=True, sort_keys=True, indent=2),
                    encoding="utf-8",
                )
                os.replace(temporary, self.cache_path)
            except OSError as exc:
                logger.warning("[PublicIpDedup] cache save failed: %s", exc)

    @staticmethod
    def _valid_ip(value: str) -> str:
        candidate = str(value or "").strip()
        try:
            parsed = ipaddress.ip_address(candidate)
            return str(parsed) if parsed.is_global else ""
        except ValueError:
            return ""

    def _cached_ip(self, identity: str, now: float) -> str:
        entry = self._cache.get("nodes", {}).get(identity)
        if not isinstance(entry, dict):
            return ""
        try:
            checked_at = float(entry.get("checked_at") or 0.0)
        except (TypeError, ValueError):
            return ""
        if now - checked_at > self.cache_ttl_seconds:
            return ""
        return self._valid_ip(entry.get("public_ip", ""))

    async def _probe_node(self, node: dict[str, Any], semaphore: asyncio.Semaphore) -> tuple[str, str]:
        identity = subscription_node_identity(node)
        now = time.time()
        cached = self._cached_ip(identity, now)
        if cached:
            return identity, cached
        try:
            port = int(node.get("local_port") or 0)
        except (TypeError, ValueError):
            port = 0
        if port <= 0:
            return identity, ""
        timeout = httpx.Timeout(self.timeout_seconds, connect=min(2.0, self.timeout_seconds))
        async with semaphore:
            try:
                async with httpx.AsyncClient(
                    proxy=f"socks5://127.0.0.1:{port}",
                    timeout=timeout,
                    follow_redirects=False,
                    trust_env=False,
                ) as client:
                    response = await client.get(
                        self.probe_url,
                        headers={"Accept": "text/plain", "User-Agent": "AK-Proxy-Public-IP/1.0"},
                    )
                public_ip = self._valid_ip(response.text) if 200 <= response.status_code < 300 else ""
            except Exception as exc:
                logger.debug("[PublicIpDedup] probe failed port=%s error=%s", port, exc)
                public_ip = ""
        if public_ip:
            self._cache.setdefault("nodes", {})[identity] = {
                "public_ip": public_ip,
                "checked_at": now,
            }
        return identity, public_ip

    async def deduplicate(self, nodes: Iterable[dict[str, Any]]) -> dict[str, Any]:
        candidates = [deepcopy(node) for node in nodes if isinstance(node, dict)]
        for node in candidates:
            node.pop("public_exit_ip", None)
        supported = [node for node in candidates if node.get("core_supported", True) is not False and node.get("enabled", True) is not False]
        semaphore = asyncio.Semaphore(self.concurrency)
        results = await asyncio.gather(*(self._probe_node(node, semaphore) for node in supported))
        ip_by_identity = dict(results)
        representatives: dict[str, str] = self._cache.setdefault("representatives", {})
        seen_ips: dict[str, str] = {}
        duplicate_nodes: list[dict[str, Any]] = []
        unknown_count = 0
        known_by_ip: dict[str, list[tuple[int, dict[str, Any], str]]] = {}
        for index, node in enumerate(candidates):
            identity = subscription_node_identity(node)
            public_ip = ip_by_identity.get(identity, "")
            if not public_ip:
                if node in supported:
                    unknown_count += 1
                continue
            known_by_ip.setdefault(public_ip, []).append((index, node, identity))

        # Use the cached identity whenever it is still present. Otherwise the
        # first node in the current subscription order becomes the incumbent.
        incumbents: dict[str, tuple[int, dict[str, Any], str]] = {}
        for public_ip, group in known_by_ip.items():
            preferred = representatives.get(public_ip)
            incumbent = next((item for item in group if item[2] == preferred), group[0])
            incumbents[public_ip] = incumbent
            representatives[public_ip] = incumbent[2]
            seen_ips[public_ip] = incumbent[2]
            incumbent[1]["public_exit_ip"] = public_ip
            duplicate_nodes.extend(item[1] for item in group if item[0] != incumbent[0])

        known_incumbent_indices = {index for index, _, _ in incumbents.values()}
        # Keep the original order for all unambiguous nodes and selected
        # representatives, while dropping only confirmed duplicate IP routes.
        selected = [
            node for index, node in enumerate(candidates)
            if (
                not ip_by_identity.get(subscription_node_identity(node), "")
                or index in known_incumbent_indices
            )
        ]
        await self._save_cache()
        return {
            "nodes": selected,
            "ip_by_identity": ip_by_identity,
            "duplicates": [
                {
                    "node_identity": subscription_node_identity(node),
                    "name": str(node.get("display_name") or node.get("name") or ""),
                    "group_id": str(node.get("group_id") or ""),
                    "public_exit_ip": ip_by_identity.get(subscription_node_identity(node), ""),
                }
                for node in duplicate_nodes
            ],
            "duplicate_count": len(duplicate_nodes),
            "unique_public_ips": len(seen_ips),
            "unknown_count": unknown_count,
            "probed_count": len(supported),
        }
