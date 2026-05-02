import asyncio
from datetime import datetime, timezone


def _safe_int(value) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def _row_get(row, key: str, default=None):
    try:
        return dict(row).get(key, default)
    except Exception:
        return default


def normalize_range_days(range_name: str) -> int:
    value = str(range_name or "7d").strip().lower()
    if value == "24h":
        return 1
    if value == "30d":
        return 30
    return 7


async def _fetch_with_timeout(awaitable, timeout_seconds: float):
    return await asyncio.wait_for(awaitable, timeout=timeout_seconds)


async def _table_exists(conn, table_name: str, timeout_seconds: float) -> bool:
    value = await _fetch_with_timeout(conn.fetchval("SELECT to_regclass($1)", f"public.{table_name}"), timeout_seconds)
    return bool(value)


async def collect_chat_summary(pool, range_name: str = "7d", timeout_seconds: float = 6.0) -> dict:
    days = normalize_range_days(range_name)
    data = {
        "available": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "range": "24h" if days == 1 else f"{days}d",
        "conversation_total": 0,
        "group_total": 0,
        "direct_total": 0,
        "message_total": 0,
        "message_today": 0,
        "message_in_range": 0,
        "deleted_message_total": 0,
        "text_storage_bytes": 0,
        "stored_payload_bytes": 0,
        "declared_attachment_bytes": 0,
        "file_asset_total": 0,
        "file_asset_active": 0,
        "file_asset_expired": 0,
        "file_storage_bytes": 0,
        "estimated_storage_bytes": 0,
        "message_type_distribution": [],
        "message_trend": [],
    }
    async with pool.acquire() as conn:
        required = ["im_conversation", "im_message"]
        for table_name in required:
            if not await _table_exists(conn, table_name, timeout_seconds):
                return {"available": False, "message": f"缺少 {table_name} 表", "generated_at": data["generated_at"]}
        has_file_asset = await _table_exists(conn, "im_file_asset", timeout_seconds)
        row = await _fetch_with_timeout(conn.fetchrow('''
            SELECT COUNT(*) AS conversation_total,
                   COUNT(*) FILTER (WHERE conversation_type = 'group') AS group_total,
                   COUNT(*) FILTER (WHERE conversation_type <> 'group') AS direct_total
            FROM im_conversation
            WHERE deleted_at IS NULL
        '''), timeout_seconds)
        if row:
            data["conversation_total"] = _safe_int(_row_get(row, "conversation_total"))
            data["group_total"] = _safe_int(_row_get(row, "group_total"))
            data["direct_total"] = _safe_int(_row_get(row, "direct_total"))
        row = await _fetch_with_timeout(conn.fetchrow('''
            SELECT COUNT(*) AS message_total,
                   COUNT(*) FILTER (WHERE sent_at >= date_trunc('day', NOW())) AS message_today,
                   COUNT(*) FILTER (WHERE sent_at >= NOW() - ($1::int * INTERVAL '1 day')) AS message_in_range,
                   COUNT(*) FILTER (WHERE deleted_at IS NOT NULL OR status = 'recalled') AS deleted_message_total,
                   COALESCE(SUM(content_size_stored) FILTER (WHERE deleted_at IS NULL AND message_type = 'text'), 0) AS text_storage_bytes,
                   COALESCE(SUM(octet_length(content_payload)) FILTER (WHERE deleted_at IS NULL), 0) AS stored_payload_bytes,
                   COALESCE(SUM(content_size_stored) FILTER (WHERE deleted_at IS NULL AND message_type IN ('image', 'file', 'voice')), 0) AS declared_attachment_bytes
            FROM im_message
        ''', days), timeout_seconds)
        if row:
            data["message_total"] = _safe_int(_row_get(row, "message_total"))
            data["message_today"] = _safe_int(_row_get(row, "message_today"))
            data["message_in_range"] = _safe_int(_row_get(row, "message_in_range"))
            data["deleted_message_total"] = _safe_int(_row_get(row, "deleted_message_total"))
            data["text_storage_bytes"] = _safe_int(_row_get(row, "text_storage_bytes"))
            data["stored_payload_bytes"] = _safe_int(_row_get(row, "stored_payload_bytes"))
            data["declared_attachment_bytes"] = _safe_int(_row_get(row, "declared_attachment_bytes"))
        rows = await _fetch_with_timeout(conn.fetch('''
            SELECT message_type,
                   COUNT(*) AS count,
                   COALESCE(SUM(octet_length(content_payload)), 0) AS payload_bytes,
                   COALESCE(SUM(content_size_stored) FILTER (WHERE message_type = 'text'), 0) AS text_bytes,
                   COALESCE(SUM(content_size_stored) FILTER (WHERE message_type IN ('image', 'file', 'voice')), 0) AS attachment_bytes,
                   COALESCE(SUM(
                       CASE
                           WHEN message_type = 'text' THEN content_size_stored
                           WHEN message_type IN ('image', 'file', 'voice') THEN content_size_stored
                           ELSE octet_length(content_payload)
                       END
                   ), 0) AS estimated_storage_bytes
            FROM im_message
            WHERE deleted_at IS NULL
            GROUP BY message_type
            ORDER BY estimated_storage_bytes DESC, COUNT(*) DESC, message_type ASC
            LIMIT 20
        '''), timeout_seconds)
        data["message_type_distribution"] = [
            {
                "message_type": str(_row_get(row, "message_type") or "unknown"),
                "count": _safe_int(_row_get(row, "count")),
                "payload_bytes": _safe_int(_row_get(row, "payload_bytes")),
                "text_bytes": _safe_int(_row_get(row, "text_bytes")),
                "attachment_bytes": _safe_int(_row_get(row, "attachment_bytes")),
                "estimated_storage_bytes": _safe_int(_row_get(row, "estimated_storage_bytes")),
            }
            for row in rows
        ]
        rows = await _fetch_with_timeout(conn.fetch('''
            SELECT date_trunc('day', sent_at) AS bucket, COUNT(*) AS count
            FROM im_message
            WHERE deleted_at IS NULL
              AND sent_at >= NOW() - ($1::int * INTERVAL '1 day')
            GROUP BY bucket
            ORDER BY bucket ASC
        ''', days), timeout_seconds)
        data["message_trend"] = [
            {"bucket": _row_get(row, "bucket").isoformat() if _row_get(row, "bucket") else "", "count": _safe_int(_row_get(row, "count"))}
            for row in rows
        ]
        if has_file_asset:
            row = await _fetch_with_timeout(conn.fetchrow('''
                SELECT COUNT(*) AS file_asset_total,
                       COUNT(*) FILTER (WHERE deleted_at IS NULL AND status = 'active') AS file_asset_active,
                       COUNT(*) FILTER (WHERE expires_at <= NOW()) AS file_asset_expired,
                       COALESCE(SUM(file_size) FILTER (WHERE deleted_at IS NULL AND status = 'active'), 0) AS file_storage_bytes
                FROM im_file_asset
            '''), timeout_seconds)
            if row:
                data["file_asset_total"] = _safe_int(_row_get(row, "file_asset_total"))
                data["file_asset_active"] = _safe_int(_row_get(row, "file_asset_active"))
                data["file_asset_expired"] = _safe_int(_row_get(row, "file_asset_expired"))
                data["file_storage_bytes"] = _safe_int(_row_get(row, "file_storage_bytes"))
    data["estimated_storage_bytes"] = data["stored_payload_bytes"] + data["file_storage_bytes"]
    return data


async def collect_group_statistics(pool, range_name: str = "7d", limit: int = 100, timeout_seconds: float = 8.0) -> dict:
    days = normalize_range_days(range_name)
    normalized_limit = min(max(int(limit or 100), 1), 200)
    generated_at = datetime.now(timezone.utc).isoformat()
    async with pool.acquire() as conn:
        required = ["im_conversation", "im_message", "im_conversation_member", "im_conversation_admin"]
        for table_name in required:
            if not await _table_exists(conn, table_name, timeout_seconds):
                return {"available": False, "message": f"缺少 {table_name} 表", "generated_at": generated_at, "items": []}
        rows = await _fetch_with_timeout(conn.fetch('''
            WITH group_base AS (
                SELECT id, title, owner_username, last_message_at, created_at
                FROM im_conversation
                WHERE conversation_type = 'group'
                  AND deleted_at IS NULL
            ), message_stats AS (
                SELECT conversation_id,
                       COUNT(*) FILTER (WHERE deleted_at IS NULL) AS message_total,
                       COUNT(*) FILTER (WHERE deleted_at IS NULL AND sent_at >= date_trunc('day', NOW())) AS message_today,
                       COUNT(*) FILTER (WHERE deleted_at IS NULL AND sent_at >= NOW() - ($1::int * INTERVAL '1 day')) AS message_in_range,
                       COALESCE(SUM(content_size_stored) FILTER (WHERE deleted_at IS NULL AND message_type = 'text'), 0) AS text_storage_bytes,
                       COALESCE(SUM(octet_length(content_payload)) FILTER (WHERE deleted_at IS NULL), 0) AS payload_storage_bytes,
                       COALESCE(SUM(COALESCE(NULLIF(substring(content_payload FROM '"file_size"\\s*:\\s*([0-9]+)'), '')::bigint, 0)) FILTER (WHERE deleted_at IS NULL AND message_type IN ('image', 'file', 'voice')), 0) AS file_storage_bytes,
                       MAX(sent_at) FILTER (WHERE deleted_at IS NULL) AS last_message_at
                FROM im_message
                WHERE conversation_id IN (SELECT id FROM group_base)
                GROUP BY conversation_id
            ), member_stats AS (
                SELECT conversation_id, COUNT(*) AS member_count
                FROM im_conversation_member
                WHERE left_at IS NULL
                GROUP BY conversation_id
            ), admin_stats AS (
                SELECT conversation_id, COUNT(*) AS admin_count
                FROM im_conversation_admin
                WHERE revoked_at IS NULL
                GROUP BY conversation_id
            )
            SELECT g.id AS conversation_id,
                   COALESCE(g.title, '') AS title,
                   COALESCE(g.owner_username, '') AS owner_username,
                   COALESCE(ms.message_total, 0) AS message_total,
                   COALESCE(ms.message_today, 0) AS message_today,
                   COALESCE(ms.message_in_range, 0) AS message_in_range,
                   COALESCE(ms.text_storage_bytes, 0) AS text_storage_bytes,
                   COALESCE(ms.payload_storage_bytes, 0) AS payload_storage_bytes,
                   COALESCE(ms.file_storage_bytes, 0) AS file_storage_bytes,
                   COALESCE(mem.member_count, 0) AS member_count,
                   COALESCE(adm.admin_count, 0) AS admin_count,
                   COALESCE(ms.last_message_at, g.last_message_at, g.created_at) AS last_message_at
            FROM group_base g
            LEFT JOIN message_stats ms ON ms.conversation_id = g.id
            LEFT JOIN member_stats mem ON mem.conversation_id = g.id
            LEFT JOIN admin_stats adm ON adm.conversation_id = g.id
            ORDER BY (COALESCE(ms.payload_storage_bytes, 0) + COALESCE(ms.file_storage_bytes, 0)) DESC,
                     COALESCE(ms.message_in_range, 0) DESC,
                     g.id DESC
            LIMIT $2
        ''', days, normalized_limit), timeout_seconds)
    items = []
    for row in rows:
        text_storage = _safe_int(_row_get(row, "text_storage_bytes"))
        payload_storage = _safe_int(_row_get(row, "payload_storage_bytes"))
        file_storage = _safe_int(_row_get(row, "file_storage_bytes"))
        items.append({
            "conversation_id": _safe_int(_row_get(row, "conversation_id")),
            "title": str(_row_get(row, "title") or ""),
            "owner_username": str(_row_get(row, "owner_username") or ""),
            "member_count": _safe_int(_row_get(row, "member_count")),
            "admin_count": _safe_int(_row_get(row, "admin_count")),
            "message_total": _safe_int(_row_get(row, "message_total")),
            "message_today": _safe_int(_row_get(row, "message_today")),
            "message_in_range": _safe_int(_row_get(row, "message_in_range")),
            "text_storage_bytes": text_storage,
            "payload_storage_bytes": payload_storage,
            "file_storage_bytes": file_storage,
            "estimated_storage_bytes": payload_storage + file_storage,
            "last_message_at": _row_get(row, "last_message_at").isoformat() if _row_get(row, "last_message_at") else "",
        })
    return {
        "available": True,
        "generated_at": generated_at,
        "range": "24h" if days == 1 else f"{days}d",
        "limit": normalized_limit,
        "items": items,
        "file_storage_scope": "message_payload_file_size_estimate",
    }


async def collect_file_assets(pool, status: str = "active", limit: int = 50, timeout_seconds: float = 8.0) -> dict:
    normalized_status = str(status or "active").strip().lower()
    if normalized_status not in ("active", "expired", "missing", "all"):
        normalized_status = "active"
    normalized_limit = min(max(int(limit or 50), 1), 100)
    generated_at = datetime.now(timezone.utc).isoformat()
    async with pool.acquire() as conn:
        if not await _table_exists(conn, "im_file_asset", timeout_seconds):
            return {"available": False, "message": "缺少 im_file_asset 表", "generated_at": generated_at, "items": []}
        if not await _table_exists(conn, "im_message", timeout_seconds):
            return {"available": False, "message": "缺少 im_message 表", "generated_at": generated_at, "items": []}
        rows = await _fetch_with_timeout(conn.fetch('''
            WITH selected_assets AS (
                SELECT storage_name, original_name, mime_type, file_size, expires_at, status, created_at, updated_at, deleted_at
                FROM im_file_asset
                WHERE ($1 = 'all' OR LOWER(status) = $1)
                ORDER BY file_size DESC, created_at DESC
                LIMIT $2
            )
            SELECT a.storage_name,
                   a.original_name,
                   a.mime_type,
                   a.file_size,
                   a.expires_at,
                   a.status,
                   a.created_at,
                   a.updated_at,
                   a.deleted_at,
                   COALESCE(refs.referenced_messages, 0) AS referenced_messages
            FROM selected_assets a
            LEFT JOIN LATERAL (
                SELECT COUNT(*) AS referenced_messages
                FROM im_message m
                WHERE m.deleted_at IS NULL
                  AND m.content_payload LIKE '%' || a.storage_name || '%'
            ) refs ON TRUE
            ORDER BY a.file_size DESC, a.created_at DESC
        ''', normalized_status, normalized_limit), timeout_seconds)
    items = []
    for row in rows:
        items.append({
            "storage_name": str(_row_get(row, "storage_name") or ""),
            "original_name": str(_row_get(row, "original_name") or ""),
            "mime_type": str(_row_get(row, "mime_type") or ""),
            "file_size": _safe_int(_row_get(row, "file_size")),
            "expires_at": _row_get(row, "expires_at").isoformat() if _row_get(row, "expires_at") else "",
            "status": str(_row_get(row, "status") or ""),
            "created_at": _row_get(row, "created_at").isoformat() if _row_get(row, "created_at") else "",
            "updated_at": _row_get(row, "updated_at").isoformat() if _row_get(row, "updated_at") else "",
            "deleted_at": _row_get(row, "deleted_at").isoformat() if _row_get(row, "deleted_at") else "",
            "referenced_messages": _safe_int(_row_get(row, "referenced_messages")),
        })
    return {
        "available": True,
        "generated_at": generated_at,
        "status": normalized_status,
        "limit": normalized_limit,
        "items": items,
    }
