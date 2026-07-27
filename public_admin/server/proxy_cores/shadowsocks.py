# -*- coding: utf-8 -*-
"""Normalize Shadowsocks nodes before routing them to a proxy core."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


MIHOMO_SUPPORTED_PLUGINS = frozenset({
    "gost-plugin",
    "obfs",
    "restls",
    "shadow-tls",
    "v2ray-plugin",
})
_PLUGIN_ALIASES = {
    "obfs-local": "obfs",
    "shadow_tls": "shadow-tls",
    "shadowtls": "shadow-tls",
    "simple-obfs": "obfs",
}


@dataclass(frozen=True)
class ShadowsocksSpec:
    server: str
    port: int
    cipher: str
    password: str
    plugin: str
    plugin_options: dict[str, Any]
    client_fingerprint: str
    udp: bool


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _first_text(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _as_bool(value: Any, default: bool) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _normalize_plugin_name(value: Any) -> str:
    name = str(value or "").strip().lower()
    return _PLUGIN_ALIASES.get(name, name)


def _normalize_option(key: str, value: Any) -> Any:
    key = str(key or "").strip().replace("_", "-")
    if key == "version":
        try:
            return int(value)
        except (TypeError, ValueError):
            return value
    if key in {"mux", "tls"}:
        return _as_bool(value, False)
    return value


def parse_plugin_options(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return {
            str(key).strip().replace("_", "-"): _normalize_option(str(key), option)
            for key, option in value.items()
            if str(key or "").strip()
        }

    text = str(value or "").strip()
    if not text:
        return {}
    options: dict[str, Any] = {}
    for field in text.split(";"):
        key, separator, option = field.partition("=")
        key = key.strip().replace("_", "-")
        if not key:
            continue
        options[key] = _normalize_option(key, option if separator else True)
    return options


def _plugin_details(node: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    raw = _mapping(node.get("raw"))
    outbound = _mapping(node.get("outbound_config"))
    plugin_text = _first_text(raw.get("plugin"), outbound.get("plugin"))
    plugin_name, separator, inline_options = plugin_text.partition(";")
    options = parse_plugin_options(inline_options if separator else "")
    explicit_options = (
        raw.get("plugin-opts")
        or raw.get("plugin_opts")
        or outbound.get("plugin-opts")
        or outbound.get("plugin_opts")
    )
    options.update(parse_plugin_options(explicit_options))
    return _normalize_plugin_name(plugin_name), options


def plugin_name(node: dict[str, Any]) -> str:
    return _plugin_details(node)[0]


def is_mihomo_supported_plugin(plugin: str) -> bool:
    return _normalize_plugin_name(plugin) in MIHOMO_SUPPORTED_PLUGINS


def normalize_shadowsocks(node: dict[str, Any]) -> ShadowsocksSpec:
    raw = _mapping(node.get("raw"))
    outbound = _mapping(node.get("outbound_config"))
    plugin, plugin_options = _plugin_details(node)
    return ShadowsocksSpec(
        server=_first_text(node.get("server"), raw.get("server"), outbound.get("server")),
        port=int(node.get("port") or raw.get("port") or outbound.get("server_port") or 0),
        cipher=_first_text(
            raw.get("cipher"),
            raw.get("method"),
            outbound.get("method"),
            outbound.get("cipher"),
            "aes-128-gcm",
        ),
        password=_first_text(raw.get("password"), outbound.get("password")),
        plugin=plugin,
        plugin_options=plugin_options,
        client_fingerprint=_first_text(
            raw.get("client-fingerprint"),
            raw.get("client_fingerprint"),
            outbound.get("client-fingerprint"),
            outbound.get("client_fingerprint"),
        ),
        udp=_as_bool(raw.get("udp", outbound.get("udp")), True),
    )
