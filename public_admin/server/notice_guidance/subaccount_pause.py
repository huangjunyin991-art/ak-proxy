from __future__ import annotations

import threading
import time
from typing import Any, Mapping


NOTICE_GUIDANCE_INTERNAL_HEADER = "x-ak-notice-guidance"
DEFAULT_MANUAL_MY_SUBACCOUNT_PAUSE_SECONDS = 60.0


def _trim_string(value: Any) -> str:
    return str(value or "").strip()


class NoticeGuidanceMySubaccountPauseCoordinator:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: dict[str, float] = {}

    def build_identity_key(self, auth: Mapping[str, Any] | None) -> str:
        if not auth:
            return ""
        user_id = _trim_string(
            auth.get("user_id")
            or auth.get("UserID")
            or auth.get("userId")
            or auth.get("userid")
            or auth.get("Id")
            or auth.get("id")
        )
        if user_id:
            return f"user_id:{user_id}"
        key = _trim_string(auth.get("key") or auth.get("Key"))
        if key:
            return f"key:{key}"
        account = _trim_string(
            auth.get("account")
            or auth.get("Account")
            or auth.get("username")
            or auth.get("UserName")
        ).lower()
        if account:
            return f"account:{account}"
        return ""

    def mark_manual_call(
        self,
        auth: Mapping[str, Any] | None,
        pause_seconds: float = DEFAULT_MANUAL_MY_SUBACCOUNT_PAUSE_SECONDS,
    ) -> dict[str, float]:
        identity_key = self.build_identity_key(auth)
        if not identity_key:
            return {"remaining_seconds": 0.0, "pause_until_epoch_ms": 0.0}
        expires_at = time.time() + max(0.0, float(pause_seconds or 0.0))
        with self._lock:
            self._entries[identity_key] = expires_at
            self._purge_locked(now=time.time())
        return self.get_pause_info(auth)

    def get_pause_info(self, auth: Mapping[str, Any] | None) -> dict[str, float]:
        identity_key = self.build_identity_key(auth)
        if not identity_key:
            return {"remaining_seconds": 0.0, "pause_until_epoch_ms": 0.0}
        now = time.time()
        with self._lock:
            expires_at = self._entries.get(identity_key, 0.0)
            if expires_at <= now:
                if identity_key in self._entries:
                    del self._entries[identity_key]
                self._purge_locked(now=now)
                return {"remaining_seconds": 0.0, "pause_until_epoch_ms": 0.0}
            remaining_seconds = max(0.0, expires_at - now)
            self._purge_locked(now=now)
        return {
            "remaining_seconds": remaining_seconds,
            "pause_until_epoch_ms": expires_at * 1000.0,
        }

    def _purge_locked(self, now: float | None = None) -> None:
        current = time.time() if now is None else float(now)
        stale_keys = [key for key, expires_at in self._entries.items() if expires_at <= current]
        for key in stale_keys:
            self._entries.pop(key, None)


notice_guidance_my_subaccount_pause_coordinator = NoticeGuidanceMySubaccountPauseCoordinator()
