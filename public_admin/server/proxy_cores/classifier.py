# -*- coding: utf-8 -*-
"""Classify subscription nodes by the local proxy core that can run them."""

from __future__ import annotations

from copy import deepcopy
from typing import Any


SINGBOX_CORE = "singbox"
MIHOMO_CORE = "mihomo"
UNSUPPORTED_CORE = "unsupported"

SINGBOX_SUPPORTED_NETWORKS = {"", "tcp", "ws", "grpc"}
MIHOMO_ONLY_VLESS_NETWORKS = {"xhttp"}

PLACEHOLDER_SERVERS = {"0.0.0.0", "127.0.0.1", "::", "::1"}


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def node_protocol(node: dict[str, Any]) -> str:
    raw = node.get("raw") if isinstance(node.get("raw"), dict) else {}
    return str(raw.get("type") or node.get("type") or "").strip().lower()


def node_network(node: dict[str, Any]) -> str:
    raw = node.get("raw") if isinstance(node.get("raw"), dict) else {}
    return str(raw.get("network") or raw.get("type") or "").strip().lower()


def classify_node(node: dict[str, Any]) -> dict[str, Any]:
    """Return a classification dict without mutating *node*."""
    server = str(node.get("server") or "").strip()
    port = node.get("port")
    proto = node_protocol(node)
    network = node_network(node)
    raw = node.get("raw") if isinstance(node.get("raw"), dict) else {}

    if not server or server in PLACEHOLDER_SERVERS:
        return {
            "core_type": UNSUPPORTED_CORE,
            "supported": False,
            "reason": "placeholder_server",
        }
    try:
        if int(port) <= 0:
            raise ValueError("invalid port")
    except Exception:
        return {
            "core_type": UNSUPPORTED_CORE,
            "supported": False,
            "reason": "invalid_port",
        }

    if proto in {"anytls", "hysteria2", "hy2", "vmess", "ss", "shadowsocks"}:
        return {"core_type": SINGBOX_CORE, "supported": True, "reason": ""}

    if proto == "trojan":
        if network in SINGBOX_SUPPORTED_NETWORKS:
            return {"core_type": SINGBOX_CORE, "supported": True, "reason": ""}
        return {
            "core_type": UNSUPPORTED_CORE,
            "supported": False,
            "reason": f"unsupported_trojan_network:{network or 'unknown'}",
        }

    if proto == "vless":
        if network in MIHOMO_ONLY_VLESS_NETWORKS:
            return {"core_type": MIHOMO_CORE, "supported": True, "reason": ""}
        if str(raw.get("security") or "").strip().lower() == "reality":
            return {"core_type": SINGBOX_CORE, "supported": True, "reason": ""}
        if network in SINGBOX_SUPPORTED_NETWORKS:
            return {"core_type": SINGBOX_CORE, "supported": True, "reason": ""}
        return {
            "core_type": UNSUPPORTED_CORE,
            "supported": False,
            "reason": f"unsupported_vless_network:{network or 'unknown'}",
        }

    return {
        "core_type": UNSUPPORTED_CORE,
        "supported": False,
        "reason": f"unsupported_protocol:{proto or 'unknown'}",
    }


def prepare_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Copy nodes and attach core metadata used by config generation and UI."""
    prepared: list[dict[str, Any]] = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        item = deepcopy(node)
        classification = classify_node(item)
        item["core_type"] = classification["core_type"]
        item["core_supported"] = bool(classification["supported"])
        item["core_unsupported_reason"] = classification["reason"]
        item["skip_cert_verify"] = _as_bool(
            item.get("skip-cert-verify")
            or item.get("skip_cert_verify")
            or (item.get("raw") or {}).get("skip-cert-verify")
            or (item.get("raw") or {}).get("skip_cert_verify")
        )
        prepared.append(item)
    return prepared


def enabled_supported_nodes(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        item
        for item in prepare_nodes(nodes)
        if item.get("enabled", True) is not False
        and item.get("core_supported") is True
        and item.get("core_type") in {SINGBOX_CORE, MIHOMO_CORE}
    ]

