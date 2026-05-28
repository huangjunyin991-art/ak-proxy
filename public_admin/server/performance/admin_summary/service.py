from datetime import datetime, timedelta
from typing import Any, Awaitable, Callable, Dict

from .repository import fetch_admin_summary_row


NormalizeBansCallback = Callable[[Any], Awaitable[None]]
UserGrowthLoader = Callable[[], Awaitable[list[dict[str, Any]]]]
UserGrowthErrorHandler = Callable[[Exception], None]


async def build_admin_summary(pool, normalize_bans: NormalizeBansCallback = None,
                              user_growth_loader: UserGrowthLoader = None,
                              on_user_growth_error: UserGrowthErrorHandler = None) -> Dict[str, Any]:
    today = datetime.now().date()
    tomorrow = today + timedelta(days=1)
    async with pool.acquire() as conn:
        if normalize_bans is not None:
            await normalize_bans(conn)
        row = await fetch_admin_summary_row(conn, today, tomorrow)
    summary = _summary_from_row(row)
    if user_growth_loader is None:
        summary['user_growth'] = []
        return summary
    try:
        summary['user_growth'] = await user_growth_loader()
    except Exception as exc:
        if on_user_growth_error is not None:
            on_user_growth_error(exc)
        summary['user_growth'] = []
    return summary


def _summary_from_row(row: Dict[str, Any]) -> Dict[str, Any]:
    source = dict(row or {})
    return {
        'total_users': int(source.get('total_users') or 0),
        'total_ips': int(source.get('total_ips') or 0),
        'today_logins': int(source.get('today_logins') or 0),
        'banned_count': int(source.get('banned_count') or 0),
        'total_logins': int(source.get('total_logins') or 0),
        'total_ace': float(source.get('total_ace') or 0),
        'total_ep': float(source.get('total_ep') or 0),
        'total_sp': float(source.get('total_sp') or 0),
        'total_rp': float(source.get('total_rp') or 0),
        'total_tp': float(source.get('total_tp') or 0),
    }
