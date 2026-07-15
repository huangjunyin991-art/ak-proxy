from __future__ import annotations

import hashlib
import re
from typing import Any, Callable

from .migration_registry import ACCOUNT_ID_PHASES, PHASE_BY_KEY, AccountIDColumnSpec, AccountIDPhase


_SQL_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _quote_identifier(value: str) -> str:
    name = str(value or "").strip()
    if not _SQL_IDENTIFIER_RE.fullmatch(name):
        raise ValueError(f"invalid sql identifier: {value!r}")
    return f'"{name}"'


def _normalize_phase_key(value: str) -> str:
    return str(value or "").strip().lower()


def _safe_index_name(table_name: str, column_name: str) -> str:
    base = f"idx_{table_name}_{column_name}"
    if len(base) <= 63:
        return base
    digest = hashlib.sha1(base.encode("utf-8")).hexdigest()[:10]
    prefix = base[: 63 - len(digest) - 1]
    return f"{prefix}_{digest}"


class AccountIdentityMigrationService:
    def __init__(self, pool_supplier: Callable[[], Any]):
        self._pool_supplier = pool_supplier

    def list_plan(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for phase in ACCOUNT_ID_PHASES:
            items.append(
                {
                    "key": phase.key,
                    "title": phase.title,
                    "description": phase.description,
                    "column_count": len(phase.specs),
                    "tables": sorted({spec.table_name for spec in phase.specs}),
                    "specs": [
                        {
                            "table_name": spec.table_name,
                            "username_column": spec.username_column,
                            "account_id_column": spec.account_id_column,
                            "description": spec.description,
                        }
                        for spec in phase.specs
                    ],
                }
            )
        return items

    async def ensure_phase_columns(self, phase_key: str = "", conn=None) -> list[dict[str, Any]]:
        if conn is not None:
            return await self._ensure_phase_columns(conn, self._select_phases(phase_key))
        pool = self._pool_supplier()
        async with pool.acquire() as owned_conn:
            return await self._ensure_phase_columns(owned_conn, self._select_phases(phase_key))

    async def collect_phase_stats(self, phase_key: str = "", conn=None) -> list[dict[str, Any]]:
        if conn is not None:
            return await self._collect_phase_stats(conn, self._select_phases(phase_key))
        pool = self._pool_supplier()
        async with pool.acquire() as owned_conn:
            return await self._collect_phase_stats(owned_conn, self._select_phases(phase_key))

    async def backfill_phase_account_ids(
        self,
        phase_key: str = "",
        limit_per_spec: int = 0,
        dry_run: bool = True,
        spec_keys: set[tuple[str, str, str]] | None = None,
        conn=None,
    ) -> list[dict[str, Any]]:
        phases = self._select_phases(phase_key, spec_keys=spec_keys)
        if conn is not None:
            return await self._backfill_phase_account_ids(conn, phases, limit_per_spec, dry_run)
        pool = self._pool_supplier()
        async with pool.acquire() as owned_conn:
            async with owned_conn.transaction():
                return await self._backfill_phase_account_ids(
                    owned_conn,
                    phases,
                    limit_per_spec,
                    dry_run,
                )

    async def find_pending_backfill_specs(self, phase_key: str = "", conn=None) -> list[dict[str, Any]]:
        phases = self._select_phases(phase_key)
        if conn is not None:
            return await self._find_pending_backfill_specs(conn, phases)
        pool = self._pool_supplier()
        async with pool.acquire() as owned_conn:
            return await self._find_pending_backfill_specs(owned_conn, phases)

    def _select_phases(
        self,
        phase_key: str,
        spec_keys: set[tuple[str, str, str]] | None = None,
    ) -> tuple[AccountIDPhase, ...]:
        normalized = _normalize_phase_key(phase_key)
        if not normalized:
            selected = ACCOUNT_ID_PHASES
        else:
            phase = PHASE_BY_KEY.get(normalized)
            if not phase:
                raise ValueError(f"unknown account id migration phase: {phase_key}")
            selected = (phase,)
        if spec_keys is None:
            return selected
        normalized_keys = {
            (str(table_name), str(username_column), str(account_id_column))
            for table_name, username_column, account_id_column in spec_keys
        }
        filtered: list[AccountIDPhase] = []
        for phase in selected:
            specs = tuple(
                spec
                for spec in phase.specs
                if (spec.table_name, spec.username_column, spec.account_id_column) in normalized_keys
            )
            if specs:
                filtered.append(
                    AccountIDPhase(
                        key=phase.key,
                        title=phase.title,
                        description=phase.description,
                        specs=specs,
                    )
                )
        return tuple(filtered)

    async def _ensure_phase_columns(self, conn, phases: tuple[AccountIDPhase, ...]) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for phase in phases:
            for spec in phase.specs:
                if not await self._table_exists(conn, spec.table_name):
                    results.append(self._build_missing_table_result(phase, spec, "skipped_missing_table"))
                    continue
                table_sql = _quote_identifier(spec.table_name)
                account_id_sql = _quote_identifier(spec.account_id_column)
                username_sql = _quote_identifier(spec.username_column)
                await conn.execute(f"ALTER TABLE {table_sql} ADD COLUMN IF NOT EXISTS {account_id_sql} BIGINT")
                index_name = _safe_index_name(spec.table_name, spec.account_id_column)
                await conn.execute(
                    f"CREATE INDEX IF NOT EXISTS {_quote_identifier(index_name)} "
                    f"ON {table_sql}({account_id_sql})"
                )
                results.append(
                    {
                        "phase": phase.key,
                        "table_name": spec.table_name,
                        "username_column": spec.username_column,
                        "account_id_column": spec.account_id_column,
                        "description": spec.description,
                        "status": "ensured",
                        "table_sql": table_sql,
                        "username_sql": username_sql,
                    }
                )
        return results

    async def _collect_phase_stats(self, conn, phases: tuple[AccountIDPhase, ...]) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for phase in phases:
            for spec in phase.specs:
                if not await self._table_exists(conn, spec.table_name):
                    results.append(self._build_missing_table_result(phase, spec, "missing_table"))
                    continue
                if not await self._column_exists(conn, spec.table_name, spec.account_id_column):
                    results.append(
                        {
                            "phase": phase.key,
                            "table_name": spec.table_name,
                            "username_column": spec.username_column,
                            "account_id_column": spec.account_id_column,
                            "description": spec.description,
                            "status": "missing_account_id_column",
                            "candidate_rows": 0,
                            "filled_rows": 0,
                            "missing_rows": 0,
                        }
                    )
                    continue
                table_sql = _quote_identifier(spec.table_name)
                username_sql = _quote_identifier(spec.username_column)
                account_id_sql = _quote_identifier(spec.account_id_column)
                row = await conn.fetchrow(
                    f"""
                    SELECT
                        COUNT(*) FILTER (WHERE COALESCE(BTRIM({username_sql}), '') <> '') AS candidate_rows,
                        COUNT(*) FILTER (
                            WHERE COALESCE(BTRIM({username_sql}), '') <> ''
                              AND {account_id_sql} IS NOT NULL
                        ) AS filled_rows,
                        COUNT(*) FILTER (
                            WHERE COALESCE(BTRIM({username_sql}), '') <> ''
                              AND {account_id_sql} IS NULL
                        ) AS missing_rows
                    FROM {table_sql}
                    """
                )
                results.append(
                    {
                        "phase": phase.key,
                        "table_name": spec.table_name,
                        "username_column": spec.username_column,
                        "account_id_column": spec.account_id_column,
                        "description": spec.description,
                        "status": "ok",
                        "candidate_rows": int(row["candidate_rows"] or 0),
                        "filled_rows": int(row["filled_rows"] or 0),
                        "missing_rows": int(row["missing_rows"] or 0),
                    }
                )
        return results

    async def _backfill_phase_account_ids(
        self,
        conn,
        phases: tuple[AccountIDPhase, ...],
        limit_per_spec: int,
        dry_run: bool,
    ) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        normalized_limit = max(0, int(limit_per_spec or 0))
        for phase in phases:
            for spec in phase.specs:
                if not await self._table_exists(conn, spec.table_name):
                    results.append(self._build_missing_table_result(phase, spec, "skipped_missing_table"))
                    continue
                if not await self._column_exists(conn, spec.table_name, spec.account_id_column):
                    results.append(
                        {
                            "phase": phase.key,
                            "table_name": spec.table_name,
                            "username_column": spec.username_column,
                            "account_id_column": spec.account_id_column,
                            "description": spec.description,
                            "status": "missing_account_id_column",
                            "matched_rows": 0,
                            "updated_rows": 0,
                            "dry_run": dry_run,
                        }
                    )
                    continue
                if dry_run:
                    matched_rows = await self._count_backfill_matches(conn, spec, normalized_limit)
                    updated_rows = 0
                    status = "dry_run"
                else:
                    updated_rows = await self._run_backfill_update(conn, spec, normalized_limit)
                    matched_rows = updated_rows
                    status = "updated"
                results.append(
                    {
                        "phase": phase.key,
                        "table_name": spec.table_name,
                        "username_column": spec.username_column,
                        "account_id_column": spec.account_id_column,
                        "description": spec.description,
                        "status": status,
                        "matched_rows": int(matched_rows or 0),
                        "updated_rows": int(updated_rows or 0),
                        "dry_run": dry_run,
                        "limit_per_spec": normalized_limit,
                    }
                )
        return results

    async def _find_pending_backfill_specs(
        self,
        conn,
        phases: tuple[AccountIDPhase, ...],
    ) -> list[dict[str, Any]]:
        pending: list[dict[str, Any]] = []
        for phase in phases:
            for spec in phase.specs:
                if not await self._table_exists(conn, spec.table_name):
                    continue
                if not await self._column_exists(conn, spec.table_name, spec.account_id_column):
                    continue
                if not await self._has_backfill_match(conn, spec):
                    continue
                pending.append(
                    {
                        "phase": phase.key,
                        "table_name": spec.table_name,
                        "username_column": spec.username_column,
                        "account_id_column": spec.account_id_column,
                        "description": spec.description,
                    }
                )
        return pending

    async def _count_backfill_matches(self, conn, spec: AccountIDColumnSpec, limit_per_spec: int) -> int:
        cte_sql = self._build_backfill_match_cte_sql(spec, limit_per_spec)
        row = await conn.fetchrow(f"{cte_sql} SELECT COUNT(*) AS matched_rows FROM matched")
        return int(row["matched_rows"] or 0)

    async def _has_backfill_match(self, conn, spec: AccountIDColumnSpec) -> bool:
        cte_sql = self._build_backfill_match_cte_sql(spec, limit_per_spec=1)
        return bool(await conn.fetchval(f"{cte_sql} SELECT EXISTS(SELECT 1 FROM matched)"))

    async def _run_backfill_update(self, conn, spec: AccountIDColumnSpec, limit_per_spec: int) -> int:
        table_sql = _quote_identifier(spec.table_name)
        account_id_sql = _quote_identifier(spec.account_id_column)
        cte_sql = self._build_backfill_match_cte_sql(spec, limit_per_spec)
        row = await conn.fetchrow(
            f"""
            {cte_sql}
            , updated AS (
                UPDATE {table_sql} AS target
                SET {account_id_sql} = matched.account_id
                FROM matched
                WHERE target.ctid = matched.row_ctid
                RETURNING 1
            )
            SELECT COUNT(*) AS updated_rows FROM updated
            """
        )
        return int(row["updated_rows"] or 0)

    def _build_backfill_match_cte_sql(self, spec: AccountIDColumnSpec, limit_per_spec: int) -> str:
        table_sql = _quote_identifier(spec.table_name)
        username_sql = _quote_identifier(spec.username_column)
        account_id_sql = _quote_identifier(spec.account_id_column)
        limit_sql = f" LIMIT {int(limit_per_spec)}" if int(limit_per_spec or 0) > 0 else ""
        return f"""
            WITH matched AS (
                SELECT target.ctid AS row_ctid, alias.account_id
                FROM {table_sql} AS target
                JOIN account_username_aliases AS alias
                  ON alias.username = LOWER(BTRIM(target.{username_sql}))
                WHERE COALESCE(BTRIM(target.{username_sql}), '') <> ''
                  AND target.{account_id_sql} IS NULL
                ORDER BY target.ctid
                {limit_sql}
            )
        """

    async def _table_exists(self, conn, table_name: str) -> bool:
        return bool(await conn.fetchval("SELECT to_regclass($1) IS NOT NULL", table_name))

    async def _column_exists(self, conn, table_name: str, column_name: str) -> bool:
        return bool(
            await conn.fetchval(
                """
                SELECT EXISTS(
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = $1
                      AND column_name = $2
                )
                """,
                table_name,
                column_name,
            )
        )

    def _build_missing_table_result(self, phase: AccountIDPhase, spec: AccountIDColumnSpec, status: str) -> dict[str, Any]:
        return {
            "phase": phase.key,
            "table_name": spec.table_name,
            "username_column": spec.username_column,
            "account_id_column": spec.account_id_column,
            "description": spec.description,
            "status": status,
        }
