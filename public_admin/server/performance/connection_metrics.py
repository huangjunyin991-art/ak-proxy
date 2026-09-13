"""Read-only observations for httpx/httpcore connection pools.

The dispatcher keeps request concurrency separately on ``OutboundExit.active``.
This module deliberately reads the transport pool instead, so the dashboard can
show actual open and in-use network connections without coupling request
dispatch to monitoring.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any


def _connection_list(client: Any) -> tuple[list[Any], bool]:
    """Return pool connections and whether the pool was inspectable.

    ``_transport._pool`` is an httpx/httpcore implementation detail, so every
    access is guarded. A client without that shape (including test doubles or
    a future httpx transport) is reported as unavailable rather than raising
    from the status endpoint.
    """

    try:
        pool = getattr(getattr(client, "_transport", None), "_pool", None)
        if pool is None:
            return [], False
        connections = getattr(pool, "connections", None)
        if callable(connections):
            connections = connections()
        if connections is None:
            connections = getattr(pool, "_connections", None)
        if connections is None:
            return [], False
        if isinstance(connections, Iterable):
            return list(connections), True
    except Exception:
        return [], False
    return [], False


def _connection_is_closed(connection: Any) -> bool:
    try:
        value = getattr(connection, "is_closed", False)
        return bool(value() if callable(value) else value)
    except Exception:
        return False


def _connection_is_idle(connection: Any) -> bool | None:
    try:
        value = getattr(connection, "is_idle", None)
        if value is None:
            return None
        return bool(value() if callable(value) else value)
    except Exception:
        return None


def inspect_client_connections(client: Any) -> dict[str, int | bool]:
    """Return open/active/idle connections for one httpx client.

    ``active`` means an open connection that is not idle according to
    httpcore. If a transport does not expose idle state, the open connection
    is conservatively counted as active so the dashboard never understates
    current network usage.
    """

    connections, available = _connection_list(client)
    open_count = 0
    active_count = 0
    idle_count = 0
    for connection in connections:
        if _connection_is_closed(connection):
            continue
        open_count += 1
        idle = _connection_is_idle(connection)
        if idle is True:
            idle_count += 1
        else:
            active_count += 1
    return {
        "available": available,
        "open": open_count,
        "active": active_count,
        "idle": idle_count,
    }


def summarize_clients(clients: Iterable[Any]) -> dict[str, int | bool]:
    """Aggregate current and retired client pools without double counting."""

    total = {"available": True, "open": 0, "active": 0, "idle": 0}
    seen: set[int] = set()
    for client in clients:
        if client is None or id(client) in seen:
            continue
        seen.add(id(client))
        metrics = inspect_client_connections(client)
        total["available"] = bool(total["available"]) and bool(metrics["available"])
        for field in ("open", "active", "idle"):
            total[field] = int(total[field]) + int(metrics[field])
    if not seen:
        total["available"] = True
    return total
