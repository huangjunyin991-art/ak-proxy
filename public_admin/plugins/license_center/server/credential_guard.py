from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable


@dataclass(frozen=True)
class CredentialGuardDecision:
    allowed: bool = True
    action: str = ""
    reason: str = "ok"
    scope_kind: str = ""
    failure_count: int = 0
    retry_after_seconds: int = 0
    locked_until: datetime | None = None

    def to_error(self) -> dict[str, Any]:
        retry_after = max(0, int(self.retry_after_seconds or 0))
        return {
            "error": True,
            "success": False,
            "message": "尝试次数过多，请稍后再试",
            "error_code": "CREDENTIAL_RATE_LIMITED",
            "data": {
                "is_locked": True,
                "reason": self.reason,
                "scope": self.scope_kind,
                "failed_attempts": self.failure_count,
                "retry_after_seconds": retry_after,
                "locked_until": self.locked_until.isoformat(sep=" ", timespec="seconds") if self.locked_until else "",
            },
        }


@dataclass(frozen=True)
class _CredentialScope:
    guard_key: str
    scope_kind: str
    threshold: int


class LicenseCredentialGuard:
    """Rate-limit sensitive license credential and TOTP attempts."""

    TARGET_FAILURE_LIMIT = 5
    COMPOSITE_FAILURE_LIMIT = 8
    IP_FAILURE_LIMIT = 30
    WINDOW_SECONDS = 15 * 60
    LOCK_SECONDS = 15 * 60
    CLEANUP_INTERVAL_SECONDS = 5 * 60
    RETENTION_DAYS = 7

    def __init__(self, pool_supplier: Callable[[], Any]):
        self._pool_supplier = pool_supplier
        self._last_cleanup_at = 0.0

    async def ensure_schema(self) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS license_center_credential_attempts (
                    guard_key TEXT PRIMARY KEY,
                    action TEXT NOT NULL DEFAULT '',
                    scope_kind TEXT NOT NULL DEFAULT '',
                    license_key TEXT NOT NULL DEFAULT '',
                    machine_id TEXT NOT NULL DEFAULT '',
                    ip_address TEXT NOT NULL DEFAULT '',
                    failure_count INTEGER NOT NULL DEFAULT 0,
                    locked_until TIMESTAMP,
                    last_failed_at TIMESTAMP,
                    last_success_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                )
                """
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_lc_credential_attempts_lock "
                "ON license_center_credential_attempts(locked_until)"
            )
            await conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_lc_credential_attempts_action_scope "
                "ON license_center_credential_attempts(action, scope_kind, updated_at DESC)"
            )

    async def ensure_allowed(
        self,
        *,
        action: str,
        license_key: str,
        machine_id: str,
        ip_address: str = "",
    ) -> CredentialGuardDecision:
        scopes = self._scopes(action=action, license_key=license_key, machine_id=machine_id, ip_address=ip_address)
        if not scopes:
            return CredentialGuardDecision(allowed=True, action=self._normalize_action(action))
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await self._cleanup_if_needed(conn)
            return await self._current_lock(conn, self._normalize_action(action), scopes)

    async def record_failure(
        self,
        *,
        action: str,
        license_key: str,
        machine_id: str,
        ip_address: str = "",
    ) -> CredentialGuardDecision:
        normalized_action = self._normalize_action(action)
        normalized_license = self._normalize_license(license_key)
        normalized_machine = self._normalize_text(machine_id)
        normalized_ip = self._normalize_text(ip_address)
        scopes = self._scopes(
            action=normalized_action,
            license_key=normalized_license,
            machine_id=normalized_machine,
            ip_address=normalized_ip,
        )
        if not scopes:
            return CredentialGuardDecision(allowed=True, action=normalized_action)
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await self._cleanup_if_needed(conn)
            async with conn.transaction():
                locked = await self._current_lock(conn, normalized_action, scopes)
                if not locked.allowed:
                    return locked
                strongest = CredentialGuardDecision(allowed=True, action=normalized_action)
                for scope in scopes:
                    decision = await self._record_scope_failure(
                        conn,
                        scope,
                        action=normalized_action,
                        license_key=normalized_license,
                        machine_id=normalized_machine,
                        ip_address=normalized_ip,
                    )
                    if not decision.allowed:
                        strongest = self._pick_stronger_lock(strongest, decision)
                return strongest

    async def record_success(
        self,
        *,
        action: str,
        license_key: str,
        machine_id: str,
        ip_address: str = "",
    ) -> None:
        normalized_action = self._normalize_action(action)
        scopes = self._scopes(
            action=normalized_action,
            license_key=license_key,
            machine_id=machine_id,
            ip_address=ip_address,
        )
        if not scopes:
            return
        pool = self._pool_supplier()
        keys = [scope.guard_key for scope in scopes]
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE license_center_credential_attempts
                SET failure_count = 0,
                    locked_until = NULL,
                    last_success_at = NOW(),
                    updated_at = NOW()
                WHERE guard_key = ANY($1::text[])
                """,
                keys,
            )

    async def _record_scope_failure(
        self,
        conn,
        scope: _CredentialScope,
        *,
        action: str,
        license_key: str,
        machine_id: str,
        ip_address: str,
    ) -> CredentialGuardDecision:
        now = datetime.now()
        await conn.execute(
            """
            INSERT INTO license_center_credential_attempts
                (guard_key, action, scope_kind, license_key, machine_id, ip_address, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
            ON CONFLICT (guard_key) DO NOTHING
            """,
            scope.guard_key,
            action,
            scope.scope_kind,
            self._fingerprint_label(license_key),
            self._fingerprint_label(machine_id),
            self._fingerprint_label(ip_address),
        )
        row = await conn.fetchrow(
            """
            SELECT failure_count, last_failed_at, locked_until
            FROM license_center_credential_attempts
            WHERE guard_key = $1
            FOR UPDATE
            """,
            scope.guard_key,
        )
        failure_count = int(row["failure_count"] or 0) if row else 0
        last_failed_at = row["last_failed_at"] if row else None
        if not last_failed_at or now - last_failed_at > timedelta(seconds=self.WINDOW_SECONDS):
            failure_count = 0
        failure_count += 1
        locked_until = None
        if failure_count >= scope.threshold:
            locked_until = now + timedelta(seconds=self.LOCK_SECONDS)
        await conn.execute(
            """
            UPDATE license_center_credential_attempts
            SET failure_count = $2,
                locked_until = $3,
                last_failed_at = NOW(),
                updated_at = NOW()
            WHERE guard_key = $1
            """,
            scope.guard_key,
            failure_count,
            locked_until,
        )
        if locked_until:
            return self._locked_decision(
                action=action,
                scope_kind=scope.scope_kind,
                failure_count=failure_count,
                locked_until=locked_until,
                reason="failure_threshold_reached",
            )
        return CredentialGuardDecision(
            allowed=True,
            action=action,
            scope_kind=scope.scope_kind,
            failure_count=failure_count,
        )

    async def _current_lock(
        self,
        conn,
        action: str,
        scopes: list[_CredentialScope],
    ) -> CredentialGuardDecision:
        keys = [scope.guard_key for scope in scopes]
        rows = await conn.fetch(
            """
            SELECT guard_key, scope_kind, failure_count, locked_until
            FROM license_center_credential_attempts
            WHERE guard_key = ANY($1::text[])
              AND locked_until IS NOT NULL
              AND locked_until > NOW()
            """,
            keys,
        )
        if not rows:
            return CredentialGuardDecision(allowed=True, action=action)
        strongest = CredentialGuardDecision(allowed=True, action=action)
        for row in rows:
            decision = self._locked_decision(
                action=action,
                scope_kind=str(row["scope_kind"] or ""),
                failure_count=int(row["failure_count"] or 0),
                locked_until=row["locked_until"],
                reason="locked",
            )
            strongest = self._pick_stronger_lock(strongest, decision)
        return strongest

    def _scopes(
        self,
        *,
        action: str,
        license_key: str,
        machine_id: str,
        ip_address: str,
    ) -> list[_CredentialScope]:
        normalized_action = self._normalize_action(action)
        normalized_license = self._normalize_license(license_key)
        normalized_machine = self._normalize_text(machine_id)
        normalized_ip = self._normalize_text(ip_address)
        scopes: list[_CredentialScope] = []
        if normalized_license and normalized_machine:
            scopes.append(self._scope(normalized_action, "license_machine", self.TARGET_FAILURE_LIMIT, normalized_license, normalized_machine))
        if normalized_license and normalized_ip:
            scopes.append(self._scope(normalized_action, "license_ip", self.COMPOSITE_FAILURE_LIMIT, normalized_license, normalized_ip))
        if normalized_machine and normalized_ip:
            scopes.append(self._scope(normalized_action, "machine_ip", self.COMPOSITE_FAILURE_LIMIT, normalized_machine, normalized_ip))
        if normalized_ip:
            scopes.append(self._scope(normalized_action, "ip", self.IP_FAILURE_LIMIT, normalized_ip))
        return scopes

    def _scope(self, action: str, scope_kind: str, threshold: int, *parts: str) -> _CredentialScope:
        seed = "\n".join(["license_credential_guard", action, scope_kind, *[self._normalize_text(part) for part in parts]])
        digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
        return _CredentialScope(
            guard_key=digest,
            scope_kind=scope_kind,
            threshold=max(1, int(threshold or 1)),
        )

    def _locked_decision(
        self,
        *,
        action: str,
        scope_kind: str,
        failure_count: int,
        locked_until: datetime | None,
        reason: str,
    ) -> CredentialGuardDecision:
        now = datetime.now()
        retry_after = int(max(0, ((locked_until or now) - now).total_seconds()))
        return CredentialGuardDecision(
            allowed=False,
            action=action,
            reason=reason,
            scope_kind=scope_kind,
            failure_count=int(failure_count or 0),
            retry_after_seconds=retry_after,
            locked_until=locked_until,
        )

    def _pick_stronger_lock(
        self,
        current: CredentialGuardDecision,
        candidate: CredentialGuardDecision,
    ) -> CredentialGuardDecision:
        if current.allowed:
            return candidate
        if candidate.allowed:
            return current
        if candidate.retry_after_seconds > current.retry_after_seconds:
            return candidate
        if candidate.failure_count > current.failure_count:
            return candidate
        return current

    async def _cleanup_if_needed(self, conn) -> None:
        now = time.time()
        if now - self._last_cleanup_at < self.CLEANUP_INTERVAL_SECONDS:
            return
        self._last_cleanup_at = now
        await conn.execute(
            """
            DELETE FROM license_center_credential_attempts
            WHERE updated_at < NOW() - ($1::int * INTERVAL '1 day')
              AND (locked_until IS NULL OR locked_until < NOW())
            """,
            self.RETENTION_DAYS,
        )

    @staticmethod
    def _normalize_action(value: str) -> str:
        normalized = "".join(ch if ch.isalnum() or ch in ("_", "-") else "_" for ch in str(value or "").strip().lower())
        return normalized[:80] or "credential"

    @staticmethod
    def _normalize_license(value: str) -> str:
        return str(value or "").strip().upper()[:120]

    @staticmethod
    def _normalize_text(value: str) -> str:
        return str(value or "").strip().lower()[:200]

    @staticmethod
    def _fingerprint_label(value: str) -> str:
        normalized = str(value or "").strip()
        if not normalized:
            return ""
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
