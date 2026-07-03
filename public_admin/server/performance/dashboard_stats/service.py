import json
from datetime import datetime, timedelta
from typing import Any, Dict, List

from .repository import fetch_traffic_dashboard_row, fetch_user_growth_bucket_rows, fetch_user_growth_rows


_EMPTY_TRAFFIC_DASHBOARD = {
    'today_requests': 0,
    'success_rate': 0,
    'active_users': 0,
    'peak_rpm': 0,
    'hourly_data': [],
    'top_users': [],
    'top_ips': [],
}


async def build_traffic_dashboard(pool) -> Dict[str, Any]:
    today = datetime.now().date()
    tomorrow = today + timedelta(days=1)
    async with pool.acquire() as conn:
        row = await fetch_traffic_dashboard_row(conn, today, tomorrow)
    if not row:
        return dict(_EMPTY_TRAFFIC_DASHBOARD)
    total = int(row.get('total') or 0)
    success = int(row.get('success') or 0)
    success_rate = (success / total) * 100 if total > 0 else 0
    return {
        'today_requests': total,
        'success_rate': round(success_rate, 1),
        'active_users': int(row.get('active_users') or 0),
        'peak_rpm': int(row.get('peak_rpm') or 0),
        'hourly_data': _load_json_list(row.get('hourly_data_json')),
        'top_users': _load_json_list(row.get('top_users_json')),
        'top_ips': _load_json_list(row.get('top_ips_json')),
    }


async def build_user_growth(pool, days: int = 30) -> List[Dict[str, Any]]:
    async with pool.acquire() as conn:
        return await fetch_user_growth_rows(conn, days)


async def build_user_growth_periods(pool) -> Dict[str, List[Dict[str, Any]]]:
    async with pool.acquire() as conn:
        day_rows = await fetch_user_growth_rows(conn, 30)
        week_rows = await fetch_user_growth_bucket_rows(conn, 'week', 12)
        month_rows = await fetch_user_growth_bucket_rows(conn, 'month', 12)
    return {
        'day': day_rows,
        'week': week_rows,
        'month': month_rows,
    }


def _load_json_list(value: Any) -> List[Dict[str, Any]]:
    if isinstance(value, list):
        return value
    if not value:
        return []
    parsed = json.loads(str(value))
    return parsed if isinstance(parsed, list) else []
