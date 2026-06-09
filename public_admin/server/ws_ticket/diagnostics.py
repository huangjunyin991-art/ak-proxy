from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable

from .diagnostics_policy import WsTicketDiagnosticsPolicyStore


WINDOWS = (
    ("15m", "15 minutes"),
    ("1h", "1 hour"),
    ("24h", "24 hours"),
)


async def collect_ws_ticket_diagnostics(pool_supplier: Callable[[], Any] | Any, policy_store: Any = None) -> dict[str, Any]:
    policy_service = policy_store or WsTicketDiagnosticsPolicyStore(pool_supplier)
    policy = await policy_service.get_policy()
    pool = _resolve_pool(pool_supplier)
    async with pool.acquire() as conn:
        has_events = await _table_exists(conn, "ws_ticket_events")
        has_tickets = await _table_exists(conn, "ws_tickets")
        if not has_tickets:
            return _unavailable("ws_tickets table is not initialized", policy=policy)

        windows = {}
        if has_events and policy.get("effective_enabled"):
            for name, interval in WINDOWS:
                windows[name] = await _collect_event_window(conn, interval)
            recent_failures = await _collect_recent_failures(conn)
            audience_rows = await _collect_audience_rows(conn)
        else:
            for name, _interval in WINDOWS:
                windows[name] = _empty_window(name)
            recent_failures = []
            audience_rows = []

        ticket_state = await _collect_ticket_state(conn)
        return {
            "success": True,
            "available": True,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "event_table_available": bool(has_events),
            "recording_enabled": bool(policy.get("effective_enabled")),
            "policy": policy,
            "windows": windows,
            "audiences": audience_rows,
            "ticket_state": ticket_state,
            "recent_failures": recent_failures,
        }


def _resolve_pool(pool_supplier: Callable[[], Any] | Any) -> Any:
    return pool_supplier() if callable(pool_supplier) else pool_supplier


async def _table_exists(conn, table_name: str) -> bool:
    value = await conn.fetchval("SELECT to_regclass($1)", f"public.{table_name}")
    return bool(value)


async def _collect_event_window(conn, interval: str) -> dict[str, Any]:
    rows = await conn.fetch(
        f"""
        SELECT
            COALESCE(NULLIF(audience, ''), '-') AS audience,
            COALESCE(NULLIF(event_type, ''), '-') AS event_type,
            COALESCE(NULLIF(code, ''), '-') AS code,
            COUNT(*)::bigint AS count
        FROM ws_ticket_events
        WHERE created_at >= NOW() - INTERVAL '{interval}'
        GROUP BY audience, event_type, code
        """
    )
    summary = _empty_window(interval)
    summary["reject_codes"] = {}
    summary["by_audience"] = {}
    for row in rows:
        audience = str(row["audience"] or "-")
        event_type = str(row["event_type"] or "-")
        code = str(row["code"] or "-")
        count = int(row["count"] or 0)
        if event_type == "issue" and code == "ok":
            summary["issued"] += count
        elif event_type == "consume" and code == "ok":
            summary["consumed"] += count
        elif event_type == "reject":
            summary["rejected"] += count
            summary["reject_codes"][code] = summary["reject_codes"].get(code, 0) + count
        bucket = summary["by_audience"].setdefault(audience, {"issued": 0, "consumed": 0, "rejected": 0})
        if event_type == "issue" and code == "ok":
            bucket["issued"] += count
        elif event_type == "consume" and code == "ok":
            bucket["consumed"] += count
        elif event_type == "reject":
            bucket["rejected"] += count
    issued = max(0, int(summary["issued"]))
    consumed = max(0, int(summary["consumed"]))
    rejected = max(0, int(summary["rejected"]))
    summary["total_events"] = issued + consumed + rejected
    summary["consume_rate_pct"] = round(consumed / issued * 100, 2) if issued else 0
    summary["reject_rate_pct"] = round(rejected / max(issued + rejected, 1) * 100, 2)
    summary["reject_codes"] = _sorted_counts(summary["reject_codes"])
    summary["by_audience"] = [
        {"audience": audience, **values}
        for audience, values in sorted(summary["by_audience"].items(), key=lambda item: item[0])
    ]
    return summary


def _empty_window(label: str) -> dict[str, Any]:
    return {
        "label": label,
        "issued": 0,
        "consumed": 0,
        "rejected": 0,
        "total_events": 0,
        "consume_rate_pct": 0,
        "reject_rate_pct": 0,
        "reject_codes": [],
        "by_audience": [],
    }


async def _collect_recent_failures(conn) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        """
        SELECT created_at, audience, code, subject, role, resource_type, resource_id, site, client_ip
        FROM ws_ticket_events
        WHERE event_type = 'reject' OR COALESCE(code, '') NOT IN ('', 'ok')
        ORDER BY created_at DESC, id DESC
        LIMIT 24
        """
    )
    return [_row_to_failure(row) for row in rows]


async def _collect_audience_rows(conn) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        """
        SELECT
            COALESCE(NULLIF(audience, ''), '-') AS audience,
            COUNT(*) FILTER (WHERE event_type = 'issue' AND code = 'ok')::bigint AS issued,
            COUNT(*) FILTER (WHERE event_type = 'consume' AND code = 'ok')::bigint AS consumed,
            COUNT(*) FILTER (WHERE event_type = 'reject')::bigint AS rejected,
            MAX(created_at) AS last_event_at
        FROM ws_ticket_events
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY audience
        ORDER BY audience
        """
    )
    return [
        {
            "audience": str(row["audience"] or "-"),
            "issued": int(row["issued"] or 0),
            "consumed": int(row["consumed"] or 0),
            "rejected": int(row["rejected"] or 0),
            "last_event_at": _iso(row["last_event_at"]),
        }
        for row in rows
    ]


async def _collect_ticket_state(conn) -> dict[str, Any]:
    rows = await conn.fetch(
        """
        SELECT
            COALESCE(NULLIF(audience, ''), '-') AS audience,
            COUNT(*) FILTER (WHERE consumed_at IS NULL AND expires_at > NOW())::bigint AS pending,
            COUNT(*) FILTER (WHERE consumed_at IS NULL AND expires_at <= NOW())::bigint AS expired_unconsumed,
            COUNT(*) FILTER (WHERE consumed_at IS NOT NULL)::bigint AS consumed_total,
            COUNT(*)::bigint AS stored_total
        FROM ws_tickets
        GROUP BY audience
        ORDER BY audience
        """
    )
    by_audience = []
    totals = {"pending": 0, "expired_unconsumed": 0, "consumed_total": 0, "stored_total": 0}
    for row in rows:
        item = {
            "audience": str(row["audience"] or "-"),
            "pending": int(row["pending"] or 0),
            "expired_unconsumed": int(row["expired_unconsumed"] or 0),
            "consumed_total": int(row["consumed_total"] or 0),
            "stored_total": int(row["stored_total"] or 0),
        }
        for key in totals:
            totals[key] += item[key]
        by_audience.append(item)
    return {**totals, "by_audience": by_audience}


def _row_to_failure(row) -> dict[str, Any]:
    return {
        "created_at": _iso(row["created_at"]),
        "audience": str(row["audience"] or "-"),
        "code": str(row["code"] or "-"),
        "subject": str(row["subject"] or ""),
        "role": str(row["role"] or ""),
        "resource_type": str(row["resource_type"] or ""),
        "resource_id": str(row["resource_id"] or ""),
        "site": str(row["site"] or ""),
        "client_ip": str(row["client_ip"] or ""),
    }


def _sorted_counts(counts: dict[str, int]) -> list[dict[str, Any]]:
    return [
        {"code": code, "count": count}
        for code, count in sorted(counts.items(), key=lambda item: (-int(item[1]), item[0]))
    ]


def _iso(value) -> str:
    if not value:
        return ""
    try:
        return value.isoformat()
    except Exception:
        return str(value)


def _unavailable(message: str, *, policy: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "success": False,
        "available": False,
        "message": message,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "recording_enabled": bool((policy or {}).get("effective_enabled")),
        "policy": policy or {},
        "windows": {},
        "audiences": [],
        "ticket_state": {},
        "recent_failures": [],
    }
