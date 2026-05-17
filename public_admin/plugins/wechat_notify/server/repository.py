from __future__ import annotations

import json
import secrets
from datetime import datetime, timedelta
from typing import Any, Callable


class WechatNotifyRepository:
    def __init__(self, pool_supplier: Callable[[], Any]):
        self._pool_supplier = pool_supplier

    async def ensure_schema(self) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS im_wechat_notify_bind_tokens (
                    id BIGSERIAL PRIMARY KEY,
                    username TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    token TEXT NOT NULL UNIQUE,
                    provider_code TEXT DEFAULT '',
                    qrcode_url TEXT DEFAULT '',
                    expires_at TIMESTAMP NOT NULL,
                    used_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            ''')
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS im_wechat_notify_bindings (
                    id BIGSERIAL PRIMARY KEY,
                    username TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    enabled BOOLEAN NOT NULL DEFAULT TRUE,
                    metadata_json TEXT DEFAULT '{}',
                    bound_at TIMESTAMP DEFAULT NOW(),
                    unbound_at TIMESTAMP,
                    last_seen_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(username, channel)
                )
            ''')
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS im_wechat_notify_events (
                    id BIGSERIAL PRIMARY KEY,
                    event_id TEXT NOT NULL UNIQUE,
                    message_id BIGINT NOT NULL DEFAULT 0,
                    conversation_id BIGINT NOT NULL DEFAULT 0,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    created_at TIMESTAMP DEFAULT NOW()
                )
            ''')
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS im_wechat_notify_outbox (
                    id BIGSERIAL PRIMARY KEY,
                    event_id TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    recipient_username TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    conversation_id BIGINT NOT NULL DEFAULT 0,
                    title TEXT NOT NULL DEFAULT '',
                    summary TEXT NOT NULL DEFAULT '',
                    content TEXT NOT NULL DEFAULT '',
                    url TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'pending',
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    max_attempts INTEGER NOT NULL DEFAULT 5,
                    next_retry_at TIMESTAMP DEFAULT NOW(),
                    last_error TEXT DEFAULT '',
                    provider_message_id TEXT DEFAULT '',
                    provider_record_id TEXT DEFAULT '',
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    sent_at TIMESTAMP,
                    UNIQUE(event_id, channel, recipient_username)
                )
            ''')
            await conn.execute("ALTER TABLE im_wechat_notify_events ADD COLUMN IF NOT EXISTS message_id BIGINT NOT NULL DEFAULT 0")
            await conn.execute("ALTER TABLE im_wechat_notify_events ADD COLUMN IF NOT EXISTS conversation_id BIGINT NOT NULL DEFAULT 0")
            await conn.execute("ALTER TABLE im_wechat_notify_outbox ADD COLUMN IF NOT EXISTS conversation_id BIGINT NOT NULL DEFAULT 0")
            await conn.execute("ALTER TABLE im_wechat_notify_bindings DROP CONSTRAINT IF EXISTS im_wechat_notify_bindings_channel_target_id_key")
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_im_wechat_notify_bind_tokens_token ON im_wechat_notify_bind_tokens(token)')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_im_wechat_notify_bindings_username ON im_wechat_notify_bindings(username)')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_im_wechat_notify_outbox_status_retry ON im_wechat_notify_outbox(status, next_retry_at, id)')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_im_wechat_notify_outbox_recipient ON im_wechat_notify_outbox(recipient_username, created_at DESC)')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_im_wechat_notify_outbox_dedupe ON im_wechat_notify_outbox(channel, recipient_username, conversation_id, created_at DESC)')

    async def create_bind_token(self, *, username: str, channel: str, ttl_seconds: int) -> dict[str, Any]:
        token = secrets.token_urlsafe(24)
        expires_at = datetime.now() + timedelta(seconds=max(60, int(ttl_seconds or 1800)))
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            row = await conn.fetchrow('''
                INSERT INTO im_wechat_notify_bind_tokens (username, channel, token, expires_at)
                VALUES ($1, $2, $3, $4)
                RETURNING id, username, channel, token, provider_code, qrcode_url, expires_at, used_at, created_at
            ''', username, channel, token, expires_at)
        return _serialize_row(row)

    async def update_bind_token_qrcode(self, *, token: str, provider_code: str, qrcode_url: str) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute('''
                UPDATE im_wechat_notify_bind_tokens
                SET provider_code = $2, qrcode_url = $3
                WHERE token = $1
            ''', token, provider_code or '', qrcode_url or '')

    async def complete_binding(self, *, token: str, channel: str, target_id: str, metadata: dict[str, Any]) -> dict[str, Any] | None:
        pool = self._pool_supplier()
        metadata_json = json.dumps(metadata or {}, ensure_ascii=False)
        async with pool.acquire() as conn:
            async with conn.transaction():
                bind_token = await conn.fetchrow('''
                    SELECT id, username, channel, token, expires_at, used_at
                    FROM im_wechat_notify_bind_tokens
                    WHERE token = $1 AND channel = $2
                    FOR UPDATE
                ''', token, channel)
                if not bind_token or bind_token['used_at'] is not None or bind_token['expires_at'] < datetime.now():
                    return None
                username = str(bind_token['username'] or '').strip().lower()
                await conn.execute('UPDATE im_wechat_notify_bind_tokens SET used_at = NOW() WHERE id = $1', bind_token['id'])
                await conn.execute('''
                    UPDATE im_wechat_notify_bindings
                    SET enabled = FALSE, unbound_at = NOW(), last_seen_at = NOW()
                    WHERE channel = $1 AND target_id = $2 AND username <> $3 AND unbound_at IS NULL
                ''', channel, target_id, username)
                row = await conn.fetchrow('''
                    INSERT INTO im_wechat_notify_bindings (username, channel, target_id, enabled, metadata_json, bound_at, unbound_at, last_seen_at)
                    VALUES ($1, $2, $3, TRUE, $4, NOW(), NULL, NOW())
                    ON CONFLICT (username, channel) DO UPDATE SET
                        target_id = EXCLUDED.target_id,
                        enabled = TRUE,
                        metadata_json = EXCLUDED.metadata_json,
                        bound_at = NOW(),
                        unbound_at = NULL,
                        last_seen_at = NOW()
                    RETURNING id, username, channel, target_id, enabled, metadata_json, bound_at, unbound_at, last_seen_at
                ''', username, channel, target_id, metadata_json)
        return _serialize_binding(row)

    async def get_active_bindings(self, usernames: list[str], channel: str) -> dict[str, dict[str, Any]]:
        normalized = []
        seen = set()
        for item in usernames or []:
            username = str(item or '').strip().lower()
            if username and username not in seen:
                seen.add(username)
                normalized.append(username)
        if not normalized:
            return {}
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            rows = await conn.fetch('''
                SELECT id, username, channel, target_id, enabled, metadata_json, bound_at, unbound_at, last_seen_at
                FROM im_wechat_notify_bindings
                WHERE channel = $1 AND enabled = TRUE AND unbound_at IS NULL AND username = ANY($2::text[])
            ''', channel, normalized)
        return {str(row['username']).lower(): _serialize_binding(row) for row in rows}

    async def record_event(self, *, event_id: str, message_id: int, conversation_id: int, payload: dict[str, Any]) -> bool:
        pool = self._pool_supplier()
        payload_json = json.dumps(payload or {}, ensure_ascii=False)
        async with pool.acquire() as conn:
            result = await conn.execute('''
                INSERT INTO im_wechat_notify_events (event_id, message_id, conversation_id, payload_json)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (event_id) DO NOTHING
            ''', event_id, int(message_id or 0), int(conversation_id or 0), payload_json)
        return str(result).endswith('1')

    async def recent_outbox_exists(self, *, channel: str, recipient_username: str, conversation_id: int, window_seconds: int) -> bool:
        if int(window_seconds or 0) <= 0 or int(conversation_id or 0) <= 0:
            return False
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            value = await conn.fetchval('''
                SELECT EXISTS (
                    SELECT 1
                    FROM im_wechat_notify_outbox
                    WHERE channel = $1
                      AND recipient_username = $2
                      AND conversation_id = $3
                      AND status IN ('pending', 'retry', 'sending', 'sent')
                      AND created_at >= NOW() - (($4 || ' seconds')::interval)
                )
            ''', channel, recipient_username, int(conversation_id), int(window_seconds))
        return bool(value)

    async def enqueue_outbox(self, *, event_id: str, channel: str, recipient_username: str, target_id: str,
                             title: str, summary: str, content: str, url: str, payload: dict[str, Any], max_attempts: int) -> bool:
        pool = self._pool_supplier()
        payload_json = json.dumps(payload or {}, ensure_ascii=False)
        conversation_id = int((payload or {}).get('conversation_id') or 0)
        async with pool.acquire() as conn:
            result = await conn.execute('''
                INSERT INTO im_wechat_notify_outbox
                    (event_id, channel, recipient_username, target_id, conversation_id, title, summary, content, url, payload_json, max_attempts, status, next_retry_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', NOW())
                ON CONFLICT (event_id, channel, recipient_username) DO NOTHING
            ''', event_id, channel, recipient_username, target_id, conversation_id, title, summary, content, url, payload_json, int(max_attempts or 5))
        return str(result).endswith('1')

    async def claim_pending_outbox(self, *, limit: int) -> list[dict[str, Any]]:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            rows = await conn.fetch('''
                UPDATE im_wechat_notify_outbox
                SET status = 'sending', updated_at = NOW()
                WHERE id IN (
                    SELECT id
                    FROM im_wechat_notify_outbox
                    WHERE status IN ('pending', 'retry') AND next_retry_at <= NOW() AND attempt_count < max_attempts
                    ORDER BY next_retry_at ASC, id ASC
                    LIMIT $1
                    FOR UPDATE SKIP LOCKED
                )
                RETURNING *
            ''', max(1, int(limit or 50)))
        return [_serialize_outbox(row) for row in rows]

    async def mark_outbox_sent(self, *, outbox_id: int, provider_message_id: str, provider_record_id: str) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute('''
                UPDATE im_wechat_notify_outbox
                SET status = 'sent', sent_at = NOW(), updated_at = NOW(), last_error = '', provider_message_id = $2, provider_record_id = $3
                WHERE id = $1
            ''', int(outbox_id), provider_message_id or '', provider_record_id or '')

    async def mark_outbox_failed(self, *, outbox_id: int, error: str, retry_base_seconds: int) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute('''
                UPDATE im_wechat_notify_outbox
                SET attempt_count = attempt_count + 1,
                    status = CASE WHEN attempt_count + 1 >= max_attempts THEN 'failed' ELSE 'retry' END,
                    next_retry_at = NOW() + (($2 * LEAST(16, GREATEST(1, attempt_count + 1))) || ' seconds')::interval,
                    last_error = $3,
                    updated_at = NOW()
                WHERE id = $1
            ''', int(outbox_id), max(5, int(retry_base_seconds or 60)), str(error or '')[:1000])


def _serialize_row(row: Any) -> dict[str, Any]:
    if not row:
        return {}
    result = dict(row)
    for key in list(result.keys()):
        value = result.get(key)
        if hasattr(value, 'isoformat'):
            result[key] = value.isoformat()
    return result


def _serialize_binding(row: Any) -> dict[str, Any]:
    result = _serialize_row(row)
    result['metadata'] = _load_json(result.pop('metadata_json', '{}'))
    return result


def _serialize_outbox(row: Any) -> dict[str, Any]:
    result = _serialize_row(row)
    result['payload'] = _load_json(result.pop('payload_json', '{}'))
    return result


def _load_json(value: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(value or '{}')
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}
