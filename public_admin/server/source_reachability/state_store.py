"""Atomic state store for last-known-good outbound identities."""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Iterable


DEFAULT_STATE_PATH = Path.home() / ".ak_proxy" / "source_reachability" / "fleet_state.json"


class SourceFleetStateStore:
    def __init__(self, path: Path | str | None = None) -> None:
        configured = os.environ.get("AK_PROXY_SOURCE_FLEET_STATE_FILE")
        self.path = Path(path or configured or DEFAULT_STATE_PATH)

    def load(self) -> dict[str, dict[str, Any]]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        exits = payload.get("exits") if isinstance(payload, dict) else None
        return exits if isinstance(exits, dict) else {}

    def save(self, exits: Iterable[Any]) -> None:
        records: dict[str, dict[str, Any]] = {}
        for exit_obj in exits:
            identity = str(getattr(exit_obj, "node_identity", "") or "").strip()
            last_success_at = float(getattr(exit_obj, "source_probe_last_success_at", 0.0) or 0.0)
            connect_failures = int(getattr(exit_obj, "_connect_failures", 0) or 0)
            if not identity or (last_success_at <= 0 and connect_failures <= 0):
                continue
            records[identity] = {
                "source_probe_ready": bool(getattr(exit_obj, "source_probe_ready", False)),
                "source_probe_protected": bool(getattr(exit_obj, "source_probe_protected", False)),
                "source_probe_last_success_at": last_success_at,
                "source_probe_checked_at": str(getattr(exit_obj, "source_probe_checked_at", "") or ""),
                "source_probe_status_code": getattr(exit_obj, "source_probe_status_code", None),
                "business_latency_ms": getattr(exit_obj, "latency_ms", None),
                "business_latency_checked_at": str(getattr(exit_obj, "latency_checked_at", "") or ""),
                "connect_failures": connect_failures,
                "frozen_until": float(getattr(exit_obj, "_frozen_until", 0.0) or 0.0),
                "frozen_reason": str(getattr(exit_obj, "_frozen_reason", "") or ""),
            }

        payload = json.dumps(
            {"version": 1, "saved_at": time.time(), "exits": records},
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
        )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(payload, encoding="utf-8")
            os.replace(temporary, self.path)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
