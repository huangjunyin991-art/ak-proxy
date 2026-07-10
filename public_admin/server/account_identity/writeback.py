from __future__ import annotations

import re
from typing import Iterable

from .migration_registry import AccountIDColumnSpec, PHASE_BY_KEY
from .service import AccountIdentityService, normalize_account_username


_SQL_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def quote_identifier(value: str) -> str:
    name = str(value or "").strip()
    if not _SQL_IDENTIFIER_RE.fullmatch(name):
        raise ValueError(f"invalid sql identifier: {value!r}")
    return f'"{name}"'


def get_phase_spec(
    phase_key: str,
    table_name: str,
    username_column: str,
    account_id_column: str,
) -> AccountIDColumnSpec:
    phase = PHASE_BY_KEY.get(str(phase_key or "").strip().lower())
    if not phase:
        raise ValueError(f"unknown account id phase: {phase_key}")
    target = (
        str(table_name or "").strip(),
        str(username_column or "").strip(),
        str(account_id_column or "").strip(),
    )
    for spec in phase.specs:
        current = (spec.table_name, spec.username_column, spec.account_id_column)
        if current == target:
            return spec
    raise ValueError(
        "unknown account id phase spec: "
        f"{phase_key}:{table_name}:{username_column}:{account_id_column}"
    )


async def get_table_columns(conn, table_name: str) -> list[str]:
    rows = await conn.fetch(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
        """,
        table_name,
    )
    result: list[str] = []
    for row in rows:
        value = row["column_name"]
        if value in (None, ""):
            continue
        result.append(str(value).strip())
    return result


async def ensure_account_id_for_username(
    conn,
    identity_service: AccountIdentityService,
    username: str,
) -> int:
    normalized = normalize_account_username(username)
    if not normalized:
        return 0
    identity = await identity_service.ensure_identity(normalized, conn=conn)
    return int((identity or {}).get("account_id") or 0)


async def sync_account_id_spec_for_username(
    conn,
    identity_service: AccountIdentityService,
    spec: AccountIDColumnSpec,
    username: str,
    account_id: int = 0,
) -> int:
    normalized = normalize_account_username(username)
    if not normalized:
        return 0
    columns = await get_table_columns(conn, spec.table_name)
    if not columns:
        return 0
    if spec.username_column not in columns or spec.account_id_column not in columns:
        return 0
    resolved_account_id = int(account_id or 0)
    if resolved_account_id <= 0:
        resolved_account_id = await ensure_account_id_for_username(conn, identity_service, normalized)
    if resolved_account_id <= 0:
        return 0
    table_sql = quote_identifier(spec.table_name)
    username_sql = quote_identifier(spec.username_column)
    account_id_sql = quote_identifier(spec.account_id_column)
    status = await conn.execute(
        f"""
        UPDATE {table_sql}
        SET {account_id_sql} = $1
        WHERE LOWER(BTRIM({username_sql})) = $2
          AND ({account_id_sql} IS NULL OR {account_id_sql} <> $1)
        """,
        resolved_account_id,
        normalized,
    )
    return _parse_command_rowcount(status)


async def sync_account_id_specs_for_username(
    conn,
    identity_service: AccountIdentityService,
    specs: Iterable[AccountIDColumnSpec],
    username: str,
    account_id: int = 0,
) -> dict[str, int]:
    normalized = normalize_account_username(username)
    if not normalized:
        return {}
    resolved_account_id = int(account_id or 0)
    if resolved_account_id <= 0:
        resolved_account_id = await ensure_account_id_for_username(conn, identity_service, normalized)
    if resolved_account_id <= 0:
        return {}
    results: dict[str, int] = {}
    for spec in specs:
        key = f"{spec.table_name}.{spec.username_column}->{spec.account_id_column}"
        results[key] = await sync_account_id_spec_for_username(
            conn,
            identity_service,
            spec,
            normalized,
            account_id=resolved_account_id,
        )
    return results


def _parse_command_rowcount(status: str) -> int:
    try:
        return int(str(status or "").split()[-1])
    except Exception:
        return 0
