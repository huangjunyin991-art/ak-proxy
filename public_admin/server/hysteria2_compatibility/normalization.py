"""Normalize Hysteria2 fields shared by subscription and core adapters."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


_CERTIFICATE_FINGERPRINT_KEYS = (
    "certificate_fingerprint",
    "pinSHA256",
    "pin_sha256",
    "pin-sha256",
    "fingerprint",
)
_HEX_SHA256_RE = re.compile(r"[0-9a-f]{64}")


@dataclass(frozen=True)
class CertificateFingerprint:
    configured: bool
    value: str

    @property
    def valid(self) -> bool:
        return bool(self.value)


def _first_configured(raw: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        value = raw.get(key)
        if value is not None and str(value).strip():
            return value
    return None


def normalize_certificate_fingerprint(value: Any) -> str:
    text = str(value or "").strip().lower()
    for prefix in ("sha256 fingerprint=", "sha256=", "sha256:", "sha256/"):
        if text.startswith(prefix):
            text = text[len(prefix):]
            break
    compact = re.sub(r"[\s:]", "", text)
    return compact if _HEX_SHA256_RE.fullmatch(compact) else ""


def certificate_fingerprint(raw: dict[str, Any]) -> CertificateFingerprint:
    candidate = _first_configured(raw, _CERTIFICATE_FINGERPRINT_KEYS)
    if candidate is None:
        return CertificateFingerprint(configured=False, value="")
    return CertificateFingerprint(
        configured=True,
        value=normalize_certificate_fingerprint(candidate),
    )


def normalize_server_ports(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    values = value if isinstance(value, (list, tuple)) else str(value).split(",")
    normalized = []
    for item in values:
        port_range = str(item or "").strip()
        if not port_range:
            continue
        if re.fullmatch(r"\d+\s*-\s*\d+", port_range):
            port_range = re.sub(r"\s*-\s*", ":", port_range)
        normalized.append(port_range)
    return normalized


def normalize_hop_interval(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        return f"{text}s"
    return text


def normalize_bandwidth(value: Any) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return int(value)
    match = re.search(r"-?\d+(?:\.\d+)?", str(value))
    return int(float(match.group(0))) if match else None


def normalize_raw(raw: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(raw)
    server_ports = normalize_server_ports(
        normalized.get("server_ports")
        or normalized.get("server-ports")
        or normalized.get("ports")
        or normalized.get("mport")
    )
    if server_ports:
        normalized["server_ports"] = server_ports

    hop_interval = normalize_hop_interval(
        normalized.get("hop_interval") or normalized.get("hop-interval")
    )
    if hop_interval:
        normalized["hop_interval"] = hop_interval

    obfs = normalized.get("obfs")
    if isinstance(obfs, dict):
        obfs_type = str(obfs.get("type") or "").strip()
        obfs_password = str(
            obfs.get("password")
            or normalized.get("obfs_password")
            or normalized.get("obfs-password")
            or ""
        )
    else:
        obfs_type = str(obfs or "").strip()
        obfs_password = str(
            normalized.get("obfs_password")
            or normalized.get("obfs-password")
            or ""
        )
    normalized["obfs"] = {
        "type": obfs_type,
        "password": obfs_password,
    } if obfs_type else {}

    for target, aliases in (
        ("up_mbps", ("up_mbps", "upmbps", "up")),
        ("down_mbps", ("down_mbps", "downmbps", "down")),
    ):
        value = next(
            (normalized.get(alias) for alias in aliases if normalized.get(alias) is not None),
            None,
        )
        bandwidth = normalize_bandwidth(value)
        if bandwidth is not None:
            normalized[target] = bandwidth

    normalized["sni"] = (
        normalized.get("sni")
        or normalized.get("servername")
        or normalized.get("server_name")
        or ""
    )
    normalized["insecure"] = normalized.get(
        "insecure",
        normalized.get("skip-cert-verify", normalized.get("skip_cert_verify", False)),
    )

    fingerprint = certificate_fingerprint(normalized)
    candidate = (
        _first_configured(normalized, _CERTIFICATE_FINGERPRINT_KEYS)
        if fingerprint.configured
        else None
    )
    for alias in _CERTIFICATE_FINGERPRINT_KEYS:
        if alias != "certificate_fingerprint":
            normalized.pop(alias, None)
    if fingerprint.configured:
        normalized["certificate_fingerprint"] = (
            fingerprint.value or str(candidate or "").strip()
        )
    return normalized


def mihomo_server_ports(value: Any) -> str:
    terms = []
    for item in normalize_server_ports(value):
        term = re.sub(r"(?<=\d):(?=\d)", "-", item)
        if term:
            terms.append(term)
    return ",".join(terms)


def mihomo_hop_interval(value: Any) -> str:
    text = normalize_hop_interval(value)
    return re.sub(r"(?<=\d)s\b", "", text, flags=re.IGNORECASE)
