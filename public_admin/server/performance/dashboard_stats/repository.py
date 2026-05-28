from datetime import date
from typing import Any, Dict, List


async def fetch_traffic_dashboard_row(conn, start_day: date, end_day: date) -> Dict[str, Any]:
    row = await conn.fetchrow('''
        WITH daily AS (
            SELECT username, ip_address, login_time,
                   CASE
                       WHEN login_success IS TRUE THEN 1
                       WHEN login_success IS FALSE THEN 0
                       WHEN extra_data ILIKE '%"status": "success"%' OR extra_data ILIKE '%"status":"success"%' THEN 1
                       WHEN extra_data ILIKE '%"status": "failed"%' OR extra_data ILIKE '%"status":"failed"%' THEN 0
                       WHEN extra_data ILIKE '%"status": "blocked"%' OR extra_data ILIKE '%"status":"blocked"%' THEN 0
                       WHEN status_code = 200 THEN 1
                       ELSE 0
                   END AS success_flag
            FROM login_records
            WHERE login_time >= $1 AND login_time < $2
        ),
        summary AS (
            SELECT COUNT(*) AS total,
                   COALESCE(SUM(success_flag), 0) AS success,
                   COUNT(DISTINCT username) AS active_users
            FROM daily
        ),
        peak AS (
            SELECT COUNT(*) AS count
            FROM daily
            GROUP BY date_trunc('minute', login_time)
            ORDER BY count DESC
            LIMIT 1
        ),
        hourly AS (
            SELECT EXTRACT(HOUR FROM login_time)::int AS hour, COUNT(*) AS count
            FROM daily
            GROUP BY hour
        ),
        top_users AS (
            SELECT username, COUNT(*) AS count, MAX(login_time) AS last_login
            FROM daily
            GROUP BY username
            ORDER BY count DESC, last_login DESC
            LIMIT 10
        ),
        top_ips AS (
            SELECT ip_address AS ip, COUNT(*) AS count
            FROM daily
            GROUP BY ip_address
            ORDER BY count DESC
            LIMIT 10
        )
        SELECT summary.total,
               summary.success,
               summary.active_users,
               COALESCE((SELECT count FROM peak), 0) AS peak_rpm,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('hour', hour, 'count', count) ORDER BY hour) FROM hourly), '[]'::jsonb)::text AS hourly_data_json,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('username', username, 'count', count, 'last_login', last_login) ORDER BY count DESC, last_login DESC) FROM top_users), '[]'::jsonb)::text AS top_users_json,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('ip', ip, 'count', count) ORDER BY count DESC) FROM top_ips), '[]'::jsonb)::text AS top_ips_json
        FROM summary
    ''', start_day, end_day)
    return dict(row) if row else {}


async def fetch_user_growth_rows(conn, days: int = 30) -> List[Dict[str, Any]]:
    normalized_days = max(1, min(int(days or 30), 365))
    rows = await conn.fetch('''
        WITH bounds AS (
            SELECT (CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day'))::date AS start_day,
                   CURRENT_DATE::date AS end_day,
                   (CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day'))::timestamp AS start_ts,
                   (CURRENT_DATE + INTERVAL '1 day')::timestamp AS end_ts
        ),
        days AS (
            SELECT generate_series(start_day, end_day, INTERVAL '1 day')::date AS day
            FROM bounds
        ),
        baseline AS (
            SELECT COUNT(*) AS count
            FROM user_stats, bounds
            WHERE first_login IS NULL OR first_login < start_ts
        ),
        daily AS (
            SELECT first_login::date AS day, COUNT(*) AS count
            FROM user_stats, bounds
            WHERE first_login IS NOT NULL
              AND first_login >= start_ts
              AND first_login < end_ts
            GROUP BY first_login::date
        )
        SELECT day::text AS date,
               COALESCE(daily.count, 0) AS increase,
               baseline.count + SUM(COALESCE(daily.count, 0)) OVER (ORDER BY day) AS total
        FROM days
        CROSS JOIN baseline
        LEFT JOIN daily USING(day)
        ORDER BY day
    ''', normalized_days)
    return [dict(row) for row in rows]
