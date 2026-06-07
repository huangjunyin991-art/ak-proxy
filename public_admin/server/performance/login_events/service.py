from datetime import datetime

from .repository import (
    apply_login_rollups,
    backfill_login_deltas_once,
    claim_pending_deltas,
    insert_login_delta as insert_login_delta_record,
    mark_deltas_processed,
)
from .schemas import LoginAggregateDelta, LoginAuditEvent, LoginDeltaBackfillResult, LoginDeltaFlushResult


def build_login_delta_from_audit(event: LoginAuditEvent) -> LoginAggregateDelta:
    login_time = event.login_time.replace(microsecond=0)
    return LoginAggregateDelta(
        login_record_id=event.login_record_id,
        username=str(event.username or '').strip().lower() or 'unknown',
        ip_address=str(event.ip_address or '').strip() or 'unknown',
        request_path=str(event.request_path or ''),
        status_code=int(event.status_code or 200),
        is_success=bool(event.is_success),
        login_time=login_time,
        login_day=login_time.date(),
        login_hour=int(login_time.hour),
        login_minute=login_time.replace(second=0, microsecond=0),
        password_present=bool(event.password_present),
    )


async def insert_login_delta(conn, event: LoginAuditEvent) -> None:
    await insert_login_delta_record(conn, build_login_delta_from_audit(event))


async def flush_pending_login_deltas(pool, limit: int = 500) -> LoginDeltaFlushResult:
    async with pool.acquire() as conn:
        async with conn.transaction():
            rows = await claim_pending_deltas(conn, limit)
            if not rows:
                return LoginDeltaFlushResult()
            result = await apply_login_rollups(conn, rows)
            await mark_deltas_processed(conn, [row['id'] for row in rows])
            return result


async def run_login_delta_backfill_once(pool, limit: int = 1000) -> LoginDeltaBackfillResult:
    async with pool.acquire() as conn:
        async with conn.transaction():
            return await backfill_login_deltas_once(conn, limit)
