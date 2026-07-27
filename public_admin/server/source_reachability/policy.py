"""Protocol-aware policies for business-source reachability probes."""

from __future__ import annotations

from dataclasses import dataclass


QUIC_PROTOCOLS = frozenset({"hysteria2", "hy2", "tuic"})


@dataclass(frozen=True)
class SourceProbePolicy:
    pool: str
    batch_concurrency: int
    request_timeout_seconds: float
    connect_timeout_seconds: float
    hard_timeout_seconds: float
    max_attempts: int = 1
    retry_delay_seconds: float = 0.0

    def should_retry(self, *, reachable: bool, status_code: int | None, attempt: int) -> bool:
        return (
            attempt < self.max_attempts
            and not reachable
            and status_code is None
        )


DEFAULT_SOURCE_PROBE_POLICY = SourceProbePolicy(
    pool="default",
    batch_concurrency=12,
    request_timeout_seconds=10.0,
    connect_timeout_seconds=5.0,
    hard_timeout_seconds=15.0,
)

QUIC_SOURCE_PROBE_POLICY = SourceProbePolicy(
    pool="quic",
    batch_concurrency=3,
    request_timeout_seconds=22.0,
    connect_timeout_seconds=10.0,
    hard_timeout_seconds=25.0,
    max_attempts=2,
    retry_delay_seconds=0.5,
)


def source_probe_policy_for_protocol(protocol: str) -> SourceProbePolicy:
    normalized = str(protocol or "").strip().lower()
    if normalized in QUIC_PROTOCOLS:
        return QUIC_SOURCE_PROBE_POLICY
    return DEFAULT_SOURCE_PROBE_POLICY
