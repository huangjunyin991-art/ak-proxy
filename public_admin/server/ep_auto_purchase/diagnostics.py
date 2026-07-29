"""Short-lived in-memory diagnostics for one EP sell-list response."""

from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Mapping


DEFAULT_SNAPSHOT_TTL_SECONDS = 3600


@dataclass
class ListingDiagnosticSnapshot:
    """A test-only response cache. It is neither persisted nor used by purchasing."""

    ttl_seconds: int = DEFAULT_SNAPSHOT_TTL_SECONDS
    _record: dict[str, Any] | None = None

    def capture(
        self,
        account: str,
        payload: Mapping[str, Any],
        summary: Mapping[str, Any],
        *,
        now: datetime | None = None,
    ) -> bool:
        captured_at = now or datetime.now()
        cloned_payload = copy.deepcopy(dict(payload))
        digest = _payload_digest(cloned_payload)
        existing = self._active_record(captured_at)
        if existing is not None and existing["digest"] == digest:
            return False
        self._record = {
            "account": str(account or "").strip().lower(),
            "captured_at": captured_at,
            "expires_at": captured_at + timedelta(seconds=max(1, int(self.ttl_seconds))),
            "digest": digest,
            "summary": copy.deepcopy(dict(summary or {})),
            "payload": cloned_payload,
        }
        return True

    def summary(self, *, now: datetime | None = None) -> dict[str, Any]:
        record = self._active_record(now or datetime.now())
        if record is None:
            return {"available": False}
        return {
            "available": True,
            "account": record["account"],
            "captured_at": record["captured_at"],
            "expires_at": record["expires_at"],
            "summary": copy.deepcopy(record["summary"]),
        }

    def payload(self, *, now: datetime | None = None) -> dict[str, Any]:
        record = self._active_record(now or datetime.now())
        if record is None:
            return {"available": False}
        return {
            "available": True,
            "account": record["account"],
            "captured_at": record["captured_at"],
            "expires_at": record["expires_at"],
            "payload": copy.deepcopy(record["payload"]),
        }

    def clear_expired(self, *, now: datetime | None = None) -> bool:
        return self._active_record(now or datetime.now()) is None

    def _active_record(self, now: datetime) -> dict[str, Any] | None:
        if self._record is None:
            return None
        if self._record["expires_at"] <= now:
            self._record = None
            return None
        return self._record


def _payload_digest(payload: Mapping[str, Any]) -> str:
    value = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
