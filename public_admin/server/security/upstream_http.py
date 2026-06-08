from __future__ import annotations

import logging
import os
import re
from functools import lru_cache

logger = logging.getLogger("TransparentProxy")

_FALSE_VALUES = {"0", "false", "no", "off"}
_TRUE_VALUES = {"1", "true", "yes", "on"}
_WARNED_INSECURE: set[str] = set()


def _normalize_service_name(service_name: str) -> str:
    value = re.sub(r"[^A-Za-z0-9]+", "_", str(service_name or "upstream")).strip("_")
    return value.upper() or "UPSTREAM"


def _read_bool_env(name: str) -> bool | None:
    raw = str(os.environ.get(name, "")).strip().lower()
    if raw in _TRUE_VALUES:
        return True
    if raw in _FALSE_VALUES:
        return False
    return None


@lru_cache(maxsize=128)
def resolve_upstream_tls_verify(
    service_name: str = "upstream",
    env_var: str | None = None,
    default: bool = True,
):
    """Return the httpx verify value for fixed upstream calls.

    TLS verification is enabled by default. Legacy AK upstream callers may pass
    default=False as a compatibility exception while keeping the decision visible
    in one place and overrideable by environment variables.
    """

    ca_bundle = str(os.environ.get("AK_UPSTREAM_CA_BUNDLE") or "").strip()
    if ca_bundle:
        return ca_bundle

    service = _normalize_service_name(service_name)
    candidates = []
    if env_var:
        candidates.append(str(env_var).strip())
    candidates.extend((f"AK_{service}_TLS_VERIFY", "AK_UPSTREAM_TLS_VERIFY"))

    for candidate in candidates:
        if not candidate:
            continue
        parsed = _read_bool_env(candidate)
        if parsed is None:
            continue
        if not parsed:
            _warn_insecure_tls(service, candidate)
        return parsed
    if not bool(default):
        _warn_insecure_tls(service, "compatibility_default")
        return False
    return True


def _warn_insecure_tls(service: str, source: str) -> None:
    key = f"{service}:{source}"
    if key in _WARNED_INSECURE:
        return
    _WARNED_INSECURE.add(key)
    logger.warning(
        "[UpstreamTLS] insecure TLS verification disabled for %s by %s; "
        "use only as a temporary compatibility exception",
        service,
        source,
    )
