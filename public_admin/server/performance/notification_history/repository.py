from typing import Any, Dict, List

from .schemas import NotificationHistoryQuery


async def fetch_notification_campaign_page(conn, query: NotificationHistoryQuery) -> Dict[str, Any]:
    limit = max(1, min(int(query.limit or 20), 100))
    offset = max(0, int(query.offset or 0))
    params: List[Any] = []
    where = ''
    created_by = str(query.created_by or '').strip()
    if created_by:
        params.append(created_by)
        where = 'WHERE created_by = $1'
    total = await conn.fetchval(f'SELECT COUNT(*) FROM notification_campaigns {where}', *params)
    params.extend([limit, offset])
    limit_idx = len(params) - 1
    offset_idx = len(params)
    rows = await conn.fetch(f'''
        WITH page_campaigns AS (
            SELECT id, notification_type, title, content, payload_json,
                   audience_mode, audience_snapshot_json, created_by,
                   target_count, created_at, published_at
            FROM notification_campaigns
            {where}
            ORDER BY id DESC
            LIMIT ${limit_idx} OFFSET ${offset_idx}
        ), delivery_counts AS (
            SELECT campaign_id,
                   COUNT(*) FILTER (WHERE read_at IS NOT NULL) AS read_count,
                   COUNT(*) FILTER (WHERE read_at IS NULL) AS unread_count
            FROM notification_deliveries
            WHERE campaign_id IN (SELECT id FROM page_campaigns)
            GROUP BY campaign_id
        )
        SELECT pc.id, pc.notification_type, pc.title, pc.content, pc.payload_json,
               pc.audience_mode, pc.audience_snapshot_json, pc.created_by,
               pc.target_count, pc.created_at, pc.published_at,
               COALESCE(dc.read_count, 0) AS read_count,
               COALESCE(dc.unread_count, 0) AS unread_count
        FROM page_campaigns pc
        LEFT JOIN delivery_counts dc ON dc.campaign_id = pc.id
        ORDER BY pc.id DESC
    ''', *params)
    return {'total': int(total or 0), 'rows': [dict(row) for row in rows]}
