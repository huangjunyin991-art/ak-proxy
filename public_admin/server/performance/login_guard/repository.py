from datetime import datetime
from .schemas import PasswordFailureEvent


async def ensure_login_guard_tables(conn) -> None:
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS login_password_failure_events (
            id BIGSERIAL PRIMARY KEY,
            username TEXT NOT NULL,
            ip_address TEXT NOT NULL,
            login_record_id BIGINT,
            occurred_at TIMESTAMP NOT NULL DEFAULT NOW(),
            created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
    ''')
    await conn.execute('ALTER TABLE login_password_failure_events ADD COLUMN IF NOT EXISTS login_record_id BIGINT')
    await conn.execute('''
        CREATE INDEX IF NOT EXISTS idx_login_password_failure_events_lookup
        ON login_password_failure_events(username, ip_address, occurred_at DESC)
    ''')
    await conn.execute('''
        CREATE UNIQUE INDEX IF NOT EXISTS idx_login_password_failure_events_record_id
        ON login_password_failure_events(login_record_id)
        WHERE login_record_id IS NOT NULL
    ''')
    await conn.execute('''
        CREATE INDEX IF NOT EXISTS idx_login_password_failure_events_occurred_at
        ON login_password_failure_events(occurred_at DESC)
    ''')
    await conn.execute('''
        CREATE TABLE IF NOT EXISTS login_password_failure_backfills (
            username TEXT NOT NULL,
            ip_address TEXT NOT NULL,
            earliest_window_start TIMESTAMP NOT NULL,
            backfilled_at TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (username, ip_address)
        )
    ''')


async def record_password_failure_event(conn, event: PasswordFailureEvent) -> None:
    if not event.is_password_failure or event.is_success:
        return
    username = str(event.username or '').strip().lower()
    ip_address = str(event.ip_address or '').strip()
    if not username or not ip_address or username == 'unknown' or ip_address == 'unknown':
        return
    await conn.execute('''
        INSERT INTO login_password_failure_events (username, ip_address, occurred_at, login_record_id)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (login_record_id) WHERE login_record_id IS NOT NULL DO NOTHING
    ''', username, ip_address, event.occurred_at, event.login_record_id)


async def count_password_failure_events(conn, username: str, ip_address: str,
                                        window_start: datetime) -> int:
    normalized_username = str(username or '').strip().lower()
    normalized_ip = str(ip_address or '').strip()
    if not normalized_username or not normalized_ip:
        return 0
    value = await conn.fetchval('''
        WITH last_success AS (
            SELECT MAX(login_time) AS login_time
            FROM login_records
            WHERE username = $1
              AND ip_address = $2
              AND request_path = '/RPC/Login'
              AND login_success IS TRUE
              AND login_time >= $3
        )
        SELECT COUNT(*)
        FROM login_password_failure_events
        WHERE username = $1
          AND ip_address = $2
          AND occurred_at > COALESCE((SELECT login_time FROM last_success), $3)
          AND occurred_at >= $3
    ''', normalized_username, normalized_ip, window_start)
    return int(value or 0)


async def ensure_password_failure_events_backfilled(conn, username: str, ip_address: str,
                                                    window_start: datetime) -> None:
    normalized_username = str(username or '').strip().lower()
    normalized_ip = str(ip_address or '').strip()
    if not normalized_username or not normalized_ip:
        return
    row = await conn.fetchrow('''
        SELECT earliest_window_start
        FROM login_password_failure_backfills
        WHERE username = $1 AND ip_address = $2
    ''', normalized_username, normalized_ip)
    if row and row['earliest_window_start'] and row['earliest_window_start'] <= window_start:
        return
    await conn.execute('''
        INSERT INTO login_password_failure_events (username, ip_address, occurred_at, login_record_id)
        SELECT username, ip_address, login_time, id
        FROM login_records
        WHERE username = $1
          AND ip_address = $2
          AND request_path = '/RPC/Login'
          AND status_code = 401
          AND login_time >= $3
          AND (
                extra_data ILIKE '%賬戶或密碼不正確%'
             OR extra_data ILIKE '%账户或密码错误%'
             OR extra_data ILIKE '%local_password_mismatch": true%'
             OR extra_data ILIKE '%local_password_mismatch":true%'
          )
        ON CONFLICT (login_record_id) WHERE login_record_id IS NOT NULL DO NOTHING
    ''', normalized_username, normalized_ip, window_start)
    await conn.execute('''
        INSERT INTO login_password_failure_backfills (username, ip_address, earliest_window_start, backfilled_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT(username, ip_address) DO UPDATE SET
            earliest_window_start = LEAST(login_password_failure_backfills.earliest_window_start, $3),
            backfilled_at = NOW()
    ''', normalized_username, normalized_ip, window_start)


