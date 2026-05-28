import logging
from typing import Any, Awaitable, Callable, Dict

from .repository import fetch_notification_campaign_page
from .schemas import NotificationHistoryQuery


logger = logging.getLogger("TransparentProxy.NotificationHistory")
NotificationHistoryFallback = Callable[[int, int, str], Awaitable[Dict[str, Any]]]


async def build_notification_campaign_page(pool, *, limit: int = 20, offset: int = 0,
                                           created_by: str = None,
                                           fallback: NotificationHistoryFallback = None) -> Dict[str, Any]:
    try:
        query = NotificationHistoryQuery(limit=limit, offset=offset, created_by=created_by)
        async with pool.acquire() as conn:
            return await fetch_notification_campaign_page(conn, query)
    except Exception as exc:
        logger.warning(f"[NotificationHistory] 通知历史分页聚合优化查询失败，降级旧查询: {exc}")
        if fallback is None:
            return {'total': 0, 'rows': []}
        return await fallback(limit, offset, created_by)
