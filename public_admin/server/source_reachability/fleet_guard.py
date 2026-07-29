"""Fleet-wide guard against mass source-probe demotion."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Sequence


@dataclass(frozen=True)
class ProbeSnapshot:
    exit_obj: Any
    was_dispatch_ready: bool
    was_verified: bool


@dataclass(frozen=True)
class GuardDecision:
    protected_count: int
    ready_count: int
    target_count: int
    circuit_open: bool


class SourceFleetGuard:
    """Keeps a last-known-good floor without promoting unverified exits."""

    def __init__(
        self,
        minimum_ready: int = 100,
        circuit_min_incumbents: int = 20,
        circuit_failure_ratio: float = 0.5,
    ) -> None:
        self.minimum_ready = max(1, int(minimum_ready or 100))
        self.circuit_min_incumbents = max(2, int(circuit_min_incumbents or 20))
        self.circuit_failure_ratio = max(0.1, min(float(circuit_failure_ratio or 0.5), 1.0))

    @staticmethod
    def snapshot(exits: Iterable[Any]) -> list[ProbeSnapshot]:
        return [
            ProbeSnapshot(
                exit_obj=exit_obj,
                was_dispatch_ready=bool(exit_obj.is_dispatch_ready and not exit_obj.is_frozen),
                was_verified=bool(float(getattr(exit_obj, "source_probe_last_success_at", 0.0) or 0.0) > 0),
            )
            for exit_obj in exits
        ]

    def reconcile(
        self,
        all_exits: Sequence[Any],
        snapshots: Sequence[ProbeSnapshot],
        results: Sequence[bool],
    ) -> GuardDecision:
        failed_incumbents = [
            snapshot.exit_obj
            for snapshot, result in zip(snapshots, results)
            if (
                not result
                and snapshot.was_dispatch_ready
                and snapshot.was_verified
                and self._can_protect_failure(snapshot.exit_obj)
            )
        ]
        incumbent_count = sum(1 for snapshot in snapshots if snapshot.was_dispatch_ready and snapshot.was_verified)
        failure_ratio = (len(failed_incumbents) / incumbent_count) if incumbent_count else 0.0
        circuit_open = (
            incumbent_count >= self.circuit_min_incumbents
            and failure_ratio >= self.circuit_failure_ratio
        )

        verified_candidates = [
            exit_obj
            for exit_obj in all_exits
            if not exit_obj.is_direct
            and exit_obj.healthy
            and not exit_obj.is_frozen
            and float(getattr(exit_obj, "source_probe_last_success_at", 0.0) or 0.0) > 0
        ]
        target_count = min(self.minimum_ready, len(verified_candidates))
        ready_count = sum(1 for exit_obj in verified_candidates if exit_obj.is_dispatch_ready)

        if circuit_open:
            candidates = failed_incumbents
        else:
            needed = max(0, target_count - ready_count)
            candidates = sorted(
                failed_incumbents,
                key=lambda exit_obj: float(getattr(exit_obj, "source_probe_last_success_at", 0.0) or 0.0),
                reverse=True,
            )[:needed]

        protected_count = 0
        for exit_obj in candidates:
            if exit_obj.healthy and not exit_obj.is_frozen:
                exit_obj.source_probe_protected = True
                protected_count += 1

        ready_count = sum(1 for exit_obj in verified_candidates if exit_obj.is_dispatch_ready)
        return GuardDecision(
            protected_count=protected_count,
            ready_count=ready_count,
            target_count=target_count,
            circuit_open=circuit_open,
        )

    def allow_connect_failure_freeze(self, all_exits: Sequence[Any], failing_exit: Any) -> bool:
        """Allow hard freezing only while the verified ready fleet stays above its floor."""
        if not self._is_verified_tunnel(failing_exit) or not failing_exit.is_dispatch_ready:
            return True

        verified_exits = [exit_obj for exit_obj in all_exits if self._is_verified_tunnel(exit_obj)]
        target_count = min(self.minimum_ready, len(verified_exits))
        ready_count = sum(
            1
            for exit_obj in verified_exits
            if exit_obj.is_dispatch_ready and not exit_obj.is_frozen
        )
        return ready_count > target_count

    @staticmethod
    def _can_protect_failure(exit_obj: Any) -> bool:
        status_code = getattr(exit_obj, "source_probe_status_code", None)
        if status_code is None:
            return True
        code = int(status_code or 0)
        return code != 429 and code < 500

    @staticmethod
    def _is_verified_tunnel(exit_obj: Any) -> bool:
        return bool(
            not exit_obj.is_direct
            and exit_obj.healthy
            and float(getattr(exit_obj, "source_probe_last_success_at", 0.0) or 0.0) > 0
        )
