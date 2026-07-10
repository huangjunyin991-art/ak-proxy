from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any, Iterable

from ...account_identity import AccountIdentityService, get_phase_spec, sync_account_id_spec_for_username
from .schemas import LoginAggregateDelta, LoginDeltaBackfillResult, LoginDeltaFlushResult


_LOGIN_EVENT_IDENTITY_SERVICE = AccountIdentityService(lambda: None)
_USER_STATS_ACCOUNT_ID_SPEC = get_phase_spec("core", "user_stats", "username", "account_id")


async def ensure_login_event_tables(conn) -> None:
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS login_aggregate_delta (
            id BIGSERIAL PRIMARY KEY,
            login_record_id BIGINT UNIQUE,
            username TEXT NOT NULL,
            ip_address TEXT NOT NULL,
            request_path TEXT DEFAULT '',
            status_code INTEGER NOT NULL DEFAULT 200,
            is_success BOOLEAN NOT NULL DEFAULT FALSE,
            login_time TIMESTAMP NOT NULL,
            login_day DATE NOT NULL,
            login_hour SMALLINT NOT NULL,
            login_minute TIMESTAMP NOT NULL,
            password_present BOOLEAN NOT NULL DEFAULT FALSE,
            source TEXT NOT NULL DEFAULT 'live',
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            processed_at TIMESTAMP,
            process_error TEXT DEFAULT ''
        )
    ''')
    await conn.execute("ALTER TABLE login_aggregate_delta ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'live'")
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS login_rollup_daily (
            login_day DATE PRIMARY KEY,
            total_count BIGINT NOT NULL DEFAULT 0,
            success_count BIGINT NOT NULL DEFAULT 0,
            failed_count BIGINT NOT NULL DEFAULT 0,
            first_login TIMESTAMP,
            last_login TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    ''')
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS login_rollup_hourly (
            login_day DATE NOT NULL,
            login_hour SMALLINT NOT NULL,
            total_count BIGINT NOT NULL DEFAULT 0,
            success_count BIGINT NOT NULL DEFAULT 0,
            failed_count BIGINT NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (login_day, login_hour)
        )
    ''')
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS login_rollup_minutely (
            login_minute TIMESTAMP PRIMARY KEY,
            login_day DATE NOT NULL,
            total_count BIGINT NOT NULL DEFAULT 0,
            success_count BIGINT NOT NULL DEFAULT 0,
            failed_count BIGINT NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    ''')
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS user_login_rollup_daily (
            username TEXT NOT NULL,
            login_day DATE NOT NULL,
            total_count BIGINT NOT NULL DEFAULT 0,
            success_count BIGINT NOT NULL DEFAULT 0,
            failed_count BIGINT NOT NULL DEFAULT 0,
            first_login TIMESTAMP,
            last_login TIMESTAMP,
            first_success TIMESTAMP,
            last_success TIMESTAMP,
            last_ip TEXT DEFAULT '',
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (username, login_day)
        )
    ''')
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS ip_login_rollup_daily (
            ip_address TEXT NOT NULL,
            login_day DATE NOT NULL,
            total_count BIGINT NOT NULL DEFAULT 0,
            success_count BIGINT NOT NULL DEFAULT 0,
            failed_count BIGINT NOT NULL DEFAULT 0,
            first_seen TIMESTAMP,
            last_seen TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (ip_address, login_day)
        )
    ''')
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS login_aggregate_backfill_state (
            state_key TEXT PRIMARY KEY,
            last_login_record_id BIGINT NOT NULL DEFAULT 0,
            completed_at TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    ''')
    await conn.execute('''
        INSERT INTO login_aggregate_backfill_state (state_key)
        VALUES ('login_records')
        ON CONFLICT(state_key) DO NOTHING
    ''')
    await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_delta_pending ON login_aggregate_delta(processed_at, id)')
    await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_delta_pending_source ON login_aggregate_delta(processed_at, source, id)')
    await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_delta_day ON login_aggregate_delta(login_day, id)')
    await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_delta_username_day ON login_aggregate_delta(username, login_day)')
    await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_delta_ip_day ON login_aggregate_delta(ip_address, login_day)')
    await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_rollup_hourly_day ON login_rollup_hourly(login_day, login_hour)')
    await conn.execute('CREATE INDEX IF NOT EXISTS idx_login_rollup_minutely_day ON login_rollup_minutely(login_day, total_count DESC)')
    await conn.execute('CREATE INDEX IF NOT EXISTS idx_user_login_rollup_day_count ON user_login_rollup_daily(login_day, total_count DESC, last_login DESC)')
    await conn.execute('CREATE INDEX IF NOT EXISTS idx_ip_login_rollup_day_count ON ip_login_rollup_daily(login_day, total_count DESC, last_seen DESC)')


async def insert_login_delta(conn, delta: LoginAggregateDelta) -> None:
    await conn.execute('''
        INSERT INTO login_aggregate_delta (
            login_record_id, username, ip_address, request_path, status_code,
            is_success, login_time, login_day, login_hour, login_minute,
            password_present, source
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'live')
        ON CONFLICT(login_record_id) DO NOTHING
    ''',
        delta.login_record_id,
        delta.username,
        delta.ip_address,
        delta.request_path,
        delta.status_code,
        delta.is_success,
        delta.login_time,
        delta.login_day,
        delta.login_hour,
        delta.login_minute,
        delta.password_present,
    )


async def claim_pending_deltas(conn, limit: int) -> list[dict[str, Any]]:
    rows = await conn.fetch('''
        SELECT id, login_record_id, username, ip_address, request_path, status_code,
               is_success, login_time, login_day, login_hour, login_minute,
               password_present, source
        FROM login_aggregate_delta
        WHERE processed_at IS NULL
        ORDER BY CASE WHEN source = 'live' THEN 0 ELSE 1 END, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
    ''', max(1, min(int(limit or 500), 5000)))
    return [dict(row) for row in rows]


async def mark_deltas_processed(conn, ids: Iterable[int]) -> None:
    normalized = [int(value) for value in ids if value is not None]
    if not normalized:
        return
    await conn.execute('''
        UPDATE login_aggregate_delta
        SET processed_at = NOW(), process_error = ''
        WHERE id = ANY($1::bigint[])
    ''', normalized)


async def apply_login_rollups(conn, rows: list[dict[str, Any]]) -> LoginDeltaFlushResult:
    if not rows:
        return LoginDeltaFlushResult()

    daily = defaultdict(_empty_count_bucket)
    hourly = defaultdict(_empty_count_bucket)
    minutely = defaultdict(_empty_count_bucket)
    users = defaultdict(_empty_user_bucket)
    ips = defaultdict(_empty_ip_bucket)
    live_users = defaultdict(_empty_user_bucket)
    live_ips = defaultdict(_empty_ip_bucket)

    for row in rows:
        username = _normalize_username(row.get('username'))
        ip_address = str(row.get('ip_address') or '').strip()
        login_time = row.get('login_time')
        login_day = row.get('login_day')
        login_hour = int(row.get('login_hour') or 0)
        login_minute = row.get('login_minute')
        is_success = bool(row.get('is_success'))
        is_backfill = str(row.get('source') or '').strip().lower() == 'backfill'

        _add_count(daily[login_day], login_time, is_success)
        _add_count(hourly[(login_day, login_hour)], login_time, is_success)
        _add_count(minutely[login_minute], login_time, is_success)

        if username:
            user_bucket = users[(username, login_day)]
            _add_user_count(user_bucket, login_time, is_success, ip_address)
            if not is_backfill:
                _add_user_count(live_users[(username, login_day)], login_time, is_success, ip_address)
        if ip_address:
            ip_bucket = ips[(ip_address, login_day)]
            _add_ip_count(ip_bucket, login_time, is_success)
            if not is_backfill:
                _add_ip_count(live_ips[(ip_address, login_day)], login_time, is_success)

    await _upsert_daily_rollups(conn, daily)
    await _upsert_hourly_rollups(conn, hourly)
    await _upsert_minutely_rollups(conn, minutely)
    await _upsert_user_rollups(conn, users)
    await _upsert_ip_rollups(conn, ips)
    await _update_user_stats_from_successes(conn, live_users)
    await _update_ip_stats_from_events(conn, live_ips)

    return LoginDeltaFlushResult(
        claimed=len(rows),
        processed=len(rows),
        users=len(users),
        ips=len(ips),
    )


async def backfill_login_deltas_once(conn, limit: int = 1000) -> LoginDeltaBackfillResult:
    normalized_limit = max(1, min(int(limit or 1000), 10000))
    state = await conn.fetchrow('''
        SELECT last_login_record_id, completed_at
        FROM login_aggregate_backfill_state
        WHERE state_key = 'login_records'
        FOR UPDATE
    ''')
    if state and state['completed_at']:
        return LoginDeltaBackfillResult(
            inserted=0,
            last_login_record_id=int(state['last_login_record_id'] or 0),
            completed=True,
        )
    last_id = int(state['last_login_record_id'] or 0) if state else 0
    ids = await conn.fetch('''
        SELECT id
        FROM login_records
        WHERE id > $1
        ORDER BY id ASC
        LIMIT $2
    ''', last_id, normalized_limit)
    selected_ids = [int(row['id']) for row in ids]
    if not selected_ids:
        await conn.execute('''
            INSERT INTO login_aggregate_backfill_state (state_key, last_login_record_id, completed_at, updated_at)
            VALUES ('login_records', $1, NOW(), NOW())
            ON CONFLICT(state_key) DO UPDATE SET
                completed_at = NOW(),
                updated_at = NOW()
        ''', last_id)
        return LoginDeltaBackfillResult(inserted=0, last_login_record_id=last_id, completed=True)

    result = await conn.execute('''
        INSERT INTO login_aggregate_delta (
            login_record_id, username, ip_address, request_path, status_code,
            is_success, login_time, login_day, login_hour, login_minute,
            password_present, source
        )
        SELECT id,
               COALESCE(NULLIF(username, ''), 'unknown') AS username,
               COALESCE(NULLIF(ip_address, ''), 'unknown') AS ip_address,
               COALESCE(request_path, '') AS request_path,
               COALESCE(status_code, 200) AS status_code,
               COALESCE(login_success, FALSE) AS is_success,
               COALESCE(login_time, NOW()) AS login_time,
               COALESCE(login_time, NOW())::date AS login_day,
               EXTRACT(HOUR FROM COALESCE(login_time, NOW()))::smallint AS login_hour,
               date_trunc('minute', COALESCE(login_time, NOW())) AS login_minute,
               FALSE AS password_present,
               'backfill' AS source
        FROM login_records
        WHERE id = ANY($1::bigint[])
        ON CONFLICT(login_record_id) DO NOTHING
    ''', selected_ids)
    inserted = _rowcount(result)
    new_last_id = max(selected_ids)
    await conn.execute('''
        UPDATE login_aggregate_backfill_state
        SET last_login_record_id = $1,
            updated_at = NOW()
        WHERE state_key = 'login_records'
    ''', new_last_id)
    return LoginDeltaBackfillResult(
        inserted=inserted,
        last_login_record_id=new_last_id,
        completed=False,
    )


def _empty_count_bucket() -> dict[str, Any]:
    return {
        'total_count': 0,
        'success_count': 0,
        'failed_count': 0,
        'first_login': None,
        'last_login': None,
    }


def _empty_user_bucket() -> dict[str, Any]:
    bucket = _empty_count_bucket()
    bucket.update({
        'first_success': None,
        'last_success': None,
        'last_ip': '',
    })
    return bucket


def _empty_ip_bucket() -> dict[str, Any]:
    return {
        'total_count': 0,
        'success_count': 0,
        'failed_count': 0,
        'first_seen': None,
        'last_seen': None,
    }


def _normalize_username(value: Any) -> str:
    return str(value or '').strip().lower()


def _add_count(bucket: dict[str, Any], login_time: datetime, is_success: bool) -> None:
    bucket['total_count'] += 1
    if is_success:
        bucket['success_count'] += 1
    else:
        bucket['failed_count'] += 1
    bucket['first_login'] = _earliest(bucket.get('first_login'), login_time)
    bucket['last_login'] = _latest(bucket.get('last_login'), login_time)


def _add_user_count(bucket: dict[str, Any], login_time: datetime, is_success: bool, ip_address: str) -> None:
    _add_count(bucket, login_time, is_success)
    if not is_success:
        return
    bucket['first_success'] = _earliest(bucket.get('first_success'), login_time)
    if bucket.get('last_success') is None or login_time >= bucket['last_success']:
        bucket['last_success'] = login_time
        bucket['last_ip'] = ip_address or bucket.get('last_ip') or ''


def _add_ip_count(bucket: dict[str, Any], login_time: datetime, is_success: bool) -> None:
    bucket['total_count'] += 1
    if is_success:
        bucket['success_count'] += 1
    else:
        bucket['failed_count'] += 1
    bucket['first_seen'] = _earliest(bucket.get('first_seen'), login_time)
    bucket['last_seen'] = _latest(bucket.get('last_seen'), login_time)


def _earliest(left: datetime | None, right: datetime | None) -> datetime | None:
    if left is None:
        return right
    if right is None:
        return left
    return left if left <= right else right


def _latest(left: datetime | None, right: datetime | None) -> datetime | None:
    if left is None:
        return right
    if right is None:
        return left
    return left if left >= right else right


async def _upsert_daily_rollups(conn, daily: dict[Any, dict[str, Any]]) -> None:
    if not daily:
        return
    await conn.executemany('''
        INSERT INTO login_rollup_daily (
            login_day, total_count, success_count, failed_count,
            first_login, last_login, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT(login_day) DO UPDATE SET
            total_count = login_rollup_daily.total_count + EXCLUDED.total_count,
            success_count = login_rollup_daily.success_count + EXCLUDED.success_count,
            failed_count = login_rollup_daily.failed_count + EXCLUDED.failed_count,
            first_login = CASE
                WHEN login_rollup_daily.first_login IS NULL THEN EXCLUDED.first_login
                WHEN EXCLUDED.first_login IS NULL THEN login_rollup_daily.first_login
                WHEN EXCLUDED.first_login < login_rollup_daily.first_login THEN EXCLUDED.first_login
                ELSE login_rollup_daily.first_login
            END,
            last_login = CASE
                WHEN login_rollup_daily.last_login IS NULL THEN EXCLUDED.last_login
                WHEN EXCLUDED.last_login IS NULL THEN login_rollup_daily.last_login
                WHEN EXCLUDED.last_login > login_rollup_daily.last_login THEN EXCLUDED.last_login
                ELSE login_rollup_daily.last_login
            END,
            updated_at = NOW()
    ''', [
        (day, bucket['total_count'], bucket['success_count'], bucket['failed_count'],
         bucket['first_login'], bucket['last_login'])
        for day, bucket in daily.items()
    ])


async def _upsert_hourly_rollups(conn, hourly: dict[tuple[Any, int], dict[str, Any]]) -> None:
    if not hourly:
        return
    await conn.executemany('''
        INSERT INTO login_rollup_hourly (
            login_day, login_hour, total_count, success_count, failed_count, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT(login_day, login_hour) DO UPDATE SET
            total_count = login_rollup_hourly.total_count + EXCLUDED.total_count,
            success_count = login_rollup_hourly.success_count + EXCLUDED.success_count,
            failed_count = login_rollup_hourly.failed_count + EXCLUDED.failed_count,
            updated_at = NOW()
    ''', [
        (day, hour, bucket['total_count'], bucket['success_count'], bucket['failed_count'])
        for (day, hour), bucket in hourly.items()
    ])


async def _upsert_minutely_rollups(conn, minutely: dict[Any, dict[str, Any]]) -> None:
    if not minutely:
        return
    await conn.executemany('''
        INSERT INTO login_rollup_minutely (
            login_minute, login_day, total_count, success_count, failed_count, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT(login_minute) DO UPDATE SET
            total_count = login_rollup_minutely.total_count + EXCLUDED.total_count,
            success_count = login_rollup_minutely.success_count + EXCLUDED.success_count,
            failed_count = login_rollup_minutely.failed_count + EXCLUDED.failed_count,
            updated_at = NOW()
    ''', [
        (minute, bucket['first_login'].date(), bucket['total_count'], bucket['success_count'], bucket['failed_count'])
        for minute, bucket in minutely.items()
        if minute is not None and bucket.get('first_login') is not None
    ])


async def _upsert_user_rollups(conn, users: dict[tuple[str, Any], dict[str, Any]]) -> None:
    if not users:
        return
    await conn.executemany('''
        INSERT INTO user_login_rollup_daily (
            username, login_day, total_count, success_count, failed_count,
            first_login, last_login, first_success, last_success, last_ip,
            updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT(username, login_day) DO UPDATE SET
            total_count = user_login_rollup_daily.total_count + EXCLUDED.total_count,
            success_count = user_login_rollup_daily.success_count + EXCLUDED.success_count,
            failed_count = user_login_rollup_daily.failed_count + EXCLUDED.failed_count,
            first_login = CASE
                WHEN user_login_rollup_daily.first_login IS NULL THEN EXCLUDED.first_login
                WHEN EXCLUDED.first_login IS NULL THEN user_login_rollup_daily.first_login
                WHEN EXCLUDED.first_login < user_login_rollup_daily.first_login THEN EXCLUDED.first_login
                ELSE user_login_rollup_daily.first_login
            END,
            last_login = CASE
                WHEN user_login_rollup_daily.last_login IS NULL THEN EXCLUDED.last_login
                WHEN EXCLUDED.last_login IS NULL THEN user_login_rollup_daily.last_login
                WHEN EXCLUDED.last_login > user_login_rollup_daily.last_login THEN EXCLUDED.last_login
                ELSE user_login_rollup_daily.last_login
            END,
            first_success = CASE
                WHEN user_login_rollup_daily.first_success IS NULL THEN EXCLUDED.first_success
                WHEN EXCLUDED.first_success IS NULL THEN user_login_rollup_daily.first_success
                WHEN EXCLUDED.first_success < user_login_rollup_daily.first_success THEN EXCLUDED.first_success
                ELSE user_login_rollup_daily.first_success
            END,
            last_success = CASE
                WHEN user_login_rollup_daily.last_success IS NULL THEN EXCLUDED.last_success
                WHEN EXCLUDED.last_success IS NULL THEN user_login_rollup_daily.last_success
                WHEN EXCLUDED.last_success > user_login_rollup_daily.last_success THEN EXCLUDED.last_success
                ELSE user_login_rollup_daily.last_success
            END,
            last_ip = CASE
                WHEN EXCLUDED.last_success IS NOT NULL
                 AND (
                    user_login_rollup_daily.last_success IS NULL
                    OR EXCLUDED.last_success >= user_login_rollup_daily.last_success
                 )
                THEN EXCLUDED.last_ip
                ELSE user_login_rollup_daily.last_ip
            END,
            updated_at = NOW()
    ''', [
        (username, day, bucket['total_count'], bucket['success_count'], bucket['failed_count'],
         bucket['first_login'], bucket['last_login'], bucket['first_success'],
         bucket['last_success'], bucket.get('last_ip') or '')
        for (username, day), bucket in users.items()
    ])


async def _upsert_ip_rollups(conn, ips: dict[tuple[str, Any], dict[str, Any]]) -> None:
    if not ips:
        return
    await conn.executemany('''
        INSERT INTO ip_login_rollup_daily (
            ip_address, login_day, total_count, success_count, failed_count,
            first_seen, last_seen, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT(ip_address, login_day) DO UPDATE SET
            total_count = ip_login_rollup_daily.total_count + EXCLUDED.total_count,
            success_count = ip_login_rollup_daily.success_count + EXCLUDED.success_count,
            failed_count = ip_login_rollup_daily.failed_count + EXCLUDED.failed_count,
            first_seen = CASE
                WHEN ip_login_rollup_daily.first_seen IS NULL THEN EXCLUDED.first_seen
                WHEN EXCLUDED.first_seen IS NULL THEN ip_login_rollup_daily.first_seen
                WHEN EXCLUDED.first_seen < ip_login_rollup_daily.first_seen THEN EXCLUDED.first_seen
                ELSE ip_login_rollup_daily.first_seen
            END,
            last_seen = CASE
                WHEN ip_login_rollup_daily.last_seen IS NULL THEN EXCLUDED.last_seen
                WHEN EXCLUDED.last_seen IS NULL THEN ip_login_rollup_daily.last_seen
                WHEN EXCLUDED.last_seen > ip_login_rollup_daily.last_seen THEN EXCLUDED.last_seen
                ELSE ip_login_rollup_daily.last_seen
            END,
            updated_at = NOW()
    ''', [
        (ip_address, day, bucket['total_count'], bucket['success_count'], bucket['failed_count'],
         bucket['first_seen'], bucket['last_seen'])
        for (ip_address, day), bucket in ips.items()
    ])


async def _update_user_stats_from_successes(conn, users: dict[tuple[str, Any], dict[str, Any]]) -> None:
    rows = [
        (username, int(bucket['success_count']), bucket['first_success'], bucket['last_success'], bucket.get('last_ip') or '')
        for (username, _day), bucket in users.items()
        if int(bucket.get('success_count') or 0) > 0 and bucket.get('last_success') is not None
    ]
    if not rows:
        return
    await conn.executemany('''
        INSERT INTO user_stats (username, login_count, first_login, last_login, last_ip)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(username) DO UPDATE SET
            login_count = user_stats.login_count + EXCLUDED.login_count,
            first_login = CASE
                WHEN user_stats.first_login IS NULL THEN EXCLUDED.first_login
                WHEN EXCLUDED.first_login IS NULL THEN user_stats.first_login
                WHEN EXCLUDED.first_login < user_stats.first_login THEN EXCLUDED.first_login
                ELSE user_stats.first_login
            END,
            last_login = CASE
                WHEN user_stats.last_login IS NULL THEN EXCLUDED.last_login
                WHEN EXCLUDED.last_login IS NULL THEN user_stats.last_login
                WHEN EXCLUDED.last_login > user_stats.last_login THEN EXCLUDED.last_login
                ELSE user_stats.last_login
            END,
            last_ip = CASE
                WHEN EXCLUDED.last_ip <> ''
                 AND (
                    user_stats.last_login IS NULL
                    OR EXCLUDED.last_login >= user_stats.last_login
                 )
                THEN EXCLUDED.last_ip
                ELSE user_stats.last_ip
            END
    ''', rows)
    usernames = sorted({row[0] for row in rows if row[0]})
    await conn.execute('''
        UPDATE user_stats us
        SET real_name = aa.nickname
        FROM authorized_accounts aa
        WHERE us.username = ANY($1::text[])
          AND us.username = aa.username
          AND COALESCE(us.real_name, '') = ''
          AND COALESCE(aa.nickname, '') <> ''
    ''', usernames)
    for username in usernames:
        await sync_account_id_spec_for_username(
            conn,
            _LOGIN_EVENT_IDENTITY_SERVICE,
            _USER_STATS_ACCOUNT_ID_SPEC,
            username,
        )


async def _update_ip_stats_from_events(conn, ips: dict[tuple[str, Any], dict[str, Any]]) -> None:
    rows = [
        (ip_address, int(bucket['total_count']), bucket['first_seen'], bucket['last_seen'])
        for (ip_address, _day), bucket in ips.items()
        if ip_address and ip_address != 'unknown'
    ]
    if not rows:
        return
    await conn.executemany('''
        INSERT INTO ip_stats (ip_address, request_count, first_seen, last_seen)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT(ip_address) DO UPDATE SET
            request_count = ip_stats.request_count + EXCLUDED.request_count,
            first_seen = CASE
                WHEN ip_stats.first_seen IS NULL THEN EXCLUDED.first_seen
                WHEN EXCLUDED.first_seen IS NULL THEN ip_stats.first_seen
                WHEN EXCLUDED.first_seen < ip_stats.first_seen THEN EXCLUDED.first_seen
                ELSE ip_stats.first_seen
            END,
            last_seen = CASE
                WHEN ip_stats.last_seen IS NULL THEN EXCLUDED.last_seen
                WHEN EXCLUDED.last_seen IS NULL THEN ip_stats.last_seen
                WHEN EXCLUDED.last_seen > ip_stats.last_seen THEN EXCLUDED.last_seen
                ELSE ip_stats.last_seen
            END
    ''', rows)


def _rowcount(command_result: str) -> int:
    try:
        return int(str(command_result or '').split()[-1])
    except Exception:
        return 0
