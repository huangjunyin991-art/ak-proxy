from __future__ import annotations

import hashlib
import json
from typing import Any, Callable


class NotifyCenterRepository:
    def __init__(self, pool_supplier: Callable[[], Any]):
        self._pool_supplier = pool_supplier

    async def ensure_schema(self) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS notify_push_subscriptions (
                    id BIGSERIAL PRIMARY KEY,
                    username TEXT NOT NULL,
                    endpoint TEXT NOT NULL,
                    endpoint_hash TEXT NOT NULL,
                    p256dh TEXT NOT NULL,
                    auth TEXT NOT NULL,
                    user_agent TEXT DEFAULT '',
                    platform TEXT DEFAULT '',
                    enabled BOOLEAN NOT NULL DEFAULT TRUE,
                    metadata_json TEXT DEFAULT '{}',
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    last_seen_at TIMESTAMP DEFAULT NOW(),
                    disabled_at TIMESTAMP
                )
            ''')
            await conn.execute("ALTER TABLE notify_push_subscriptions ADD COLUMN IF NOT EXISTS endpoint_hash TEXT NOT NULL DEFAULT ''")
            await conn.execute("ALTER TABLE notify_push_subscriptions DROP CONSTRAINT IF EXISTS notify_push_subscriptions_username_endpoint_key")
            await conn.execute("UPDATE notify_push_subscriptions SET endpoint_hash = md5(endpoint) WHERE endpoint_hash = ''")
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS notify_events (
                    id BIGSERIAL PRIMARY KEY,
                    event_id TEXT NOT NULL UNIQUE,
                    source TEXT NOT NULL DEFAULT 'im',
                    event_type TEXT NOT NULL DEFAULT '',
                    message_id BIGINT NOT NULL DEFAULT 0,
                    conversation_id BIGINT NOT NULL DEFAULT 0,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    created_at TIMESTAMP DEFAULT NOW()
                )
            ''')
            await conn.execute('''
                ALTER TABLE notify_events
                ALTER COLUMN message_id TYPE BIGINT USING (
                    CASE WHEN message_id::text ~ '^-?[0-9]+$' THEN message_id::text::BIGINT ELSE 0 END
                )
            ''')
            await conn.execute("ALTER TABLE notify_events ALTER COLUMN message_id SET DEFAULT 0")
            await conn.execute("ALTER TABLE notify_events ALTER COLUMN message_id SET NOT NULL")
            await conn.execute('''
                ALTER TABLE notify_events
                ALTER COLUMN conversation_id TYPE BIGINT USING (
                    CASE WHEN conversation_id::text ~ '^-?[0-9]+$' THEN conversation_id::text::BIGINT ELSE 0 END
                )
            ''')
            await conn.execute("ALTER TABLE notify_events ALTER COLUMN conversation_id SET DEFAULT 0")
            await conn.execute("ALTER TABLE notify_events ALTER COLUMN conversation_id SET NOT NULL")
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS notify_outbox (
                    id BIGSERIAL PRIMARY KEY,
                    event_id TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    recipient_username TEXT NOT NULL,
                    subscription_id BIGINT NOT NULL DEFAULT 0,
                    conversation_id BIGINT NOT NULL DEFAULT 0,
                    title TEXT NOT NULL DEFAULT '',
                    body TEXT NOT NULL DEFAULT '',
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
                    UNIQUE(event_id, channel, subscription_id)
                )
            ''')
            await conn.execute('''
                ALTER TABLE notify_outbox
                ALTER COLUMN subscription_id TYPE BIGINT USING (
                    CASE WHEN subscription_id::text ~ '^-?[0-9]+$' THEN subscription_id::text::BIGINT ELSE 0 END
                )
            ''')
            await conn.execute("ALTER TABLE notify_outbox ALTER COLUMN subscription_id SET DEFAULT 0")
            await conn.execute("ALTER TABLE notify_outbox ALTER COLUMN subscription_id SET NOT NULL")
            await conn.execute('''
                ALTER TABLE notify_outbox
                ALTER COLUMN conversation_id TYPE BIGINT USING (
                    CASE WHEN conversation_id::text ~ '^-?[0-9]+$' THEN conversation_id::text::BIGINT ELSE 0 END
                )
            ''')
            await conn.execute("ALTER TABLE notify_outbox ALTER COLUMN conversation_id SET DEFAULT 0")
            await conn.execute("ALTER TABLE notify_outbox ALTER COLUMN conversation_id SET NOT NULL")
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_notify_push_subscriptions_username ON notify_push_subscriptions(username)')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_notify_push_subscriptions_enabled ON notify_push_subscriptions(enabled, username)')
            await conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_notify_push_subscriptions_user_endpoint_hash ON notify_push_subscriptions(username, endpoint_hash)')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_notify_outbox_status_retry ON notify_outbox(status, next_retry_at, id)')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_notify_outbox_recipient ON notify_outbox(recipient_username, created_at DESC)')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_notify_outbox_dedupe ON notify_outbox(channel, recipient_username, conversation_id, created_at DESC)')

    async def upsert_subscription(self, *, username: str, endpoint: str, p256dh: str, auth: str,
                                  user_agent: str, platform: str, metadata: dict[str, Any]) -> dict[str, Any]:
        pool = self._pool_supplier()
        metadata_json = json.dumps(metadata or {}, ensure_ascii=False)
        endpoint_hash = _build_endpoint_hash(endpoint)
        async with pool.acquire() as conn:
            await conn.execute('''
                UPDATE notify_push_subscriptions
                SET enabled = FALSE, disabled_at = NOW(), updated_at = NOW()
                WHERE endpoint_hash = $1 AND username <> $2 AND enabled = TRUE
            ''', endpoint_hash, username)
            row = await conn.fetchrow('''
                INSERT INTO notify_push_subscriptions
                    (username, endpoint, endpoint_hash, p256dh, auth, user_agent, platform, enabled, metadata_json, created_at, updated_at, last_seen_at, disabled_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, NOW(), NOW(), NOW(), NULL)
                ON CONFLICT (username, endpoint_hash) DO UPDATE SET
                    endpoint = EXCLUDED.endpoint,
                    p256dh = EXCLUDED.p256dh,
                    auth = EXCLUDED.auth,
                    user_agent = EXCLUDED.user_agent,
                    platform = EXCLUDED.platform,
                    enabled = TRUE,
                    metadata_json = EXCLUDED.metadata_json,
                    updated_at = NOW(),
                    last_seen_at = NOW(),
                    disabled_at = NULL
                RETURNING *
            ''', username, endpoint, endpoint_hash, p256dh, auth, user_agent or '', platform or '', metadata_json)
        return _serialize_subscription(row)

    async def disable_subscription(self, *, username: str, endpoint: str) -> bool:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            result = await conn.execute('''
                UPDATE notify_push_subscriptions
                SET enabled = FALSE, disabled_at = NOW(), updated_at = NOW()
                WHERE username = $1 AND endpoint = $2 AND enabled = TRUE
            ''', username, endpoint)
        return str(result).endswith('1')

    async def disable_subscription_by_id(self, subscription_id: int) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute('''
                UPDATE notify_push_subscriptions
                SET enabled = FALSE, disabled_at = NOW(), updated_at = NOW()
                WHERE id = $1
            ''', int(subscription_id or 0))

    async def get_active_subscriptions(self, usernames: list[str]) -> dict[str, list[dict[str, Any]]]:
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
                SELECT *
                FROM notify_push_subscriptions
                WHERE enabled = TRUE AND disabled_at IS NULL AND username = ANY($1::text[])
                ORDER BY username ASC, id ASC
            ''', normalized)
        result: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            item = _serialize_subscription(row)
            result.setdefault(str(item.get('username') or '').lower(), []).append(item)
        return result

    async def get_user_push_diagnostics(self, username: str, *, limit: int = 10) -> dict[str, Any]:
        normalized = str(username or '').strip().lower()
        if not normalized:
            return {'active_subscription_count': 0, 'subscriptions': [], 'recent_outbox': []}
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            subscription_rows = await conn.fetch('''
                SELECT id, username, endpoint_hash, user_agent, platform, enabled, created_at, updated_at, last_seen_at, disabled_at
                FROM notify_push_subscriptions
                WHERE username = $1
                ORDER BY updated_at DESC, id DESC
                LIMIT $2
            ''', normalized, max(1, int(limit or 10)))
            outbox_rows = await conn.fetch('''
                SELECT id, event_id, channel, recipient_username, subscription_id, conversation_id, status, attempt_count, max_attempts, next_retry_at, last_error, provider_record_id, created_at, updated_at, sent_at
                FROM notify_outbox
                WHERE recipient_username = $1
                ORDER BY created_at DESC, id DESC
                LIMIT $2
            ''', normalized, max(1, int(limit or 10)))
        subscriptions = [_serialize_row(row) for row in subscription_rows]
        active_count = sum(1 for item in subscriptions if item.get('enabled') and not item.get('disabled_at'))
        return {
            'active_subscription_count': active_count,
            'subscriptions': subscriptions,
            'recent_outbox': [_serialize_row(row) for row in outbox_rows],
        }

    async def record_event(self, *, event_id: str, event_type: str, message_id: int, conversation_id: int, payload: dict[str, Any]) -> bool:
        pool = self._pool_supplier()
        payload_json = json.dumps(payload or {}, ensure_ascii=False)
        async with pool.acquire() as conn:
            result = await conn.execute('''
                INSERT INTO notify_events (event_id, source, event_type, message_id, conversation_id, payload_json)
                VALUES ($1, 'im', $2, $3, $4, $5)
                ON CONFLICT (event_id) DO NOTHING
            ''', event_id, event_type or '', int(message_id or 0), int(conversation_id or 0), payload_json)
        return str(result).endswith('1')

    async def recent_outbox_exists(self, *, channel: str, recipient_username: str, conversation_id: int, window_seconds: int) -> bool:
        if int(window_seconds or 0) <= 0 or int(conversation_id or 0) <= 0:
            return False
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            value = await conn.fetchval('''
                SELECT EXISTS (
                    SELECT 1
                    FROM notify_outbox
                    WHERE channel = $1
                      AND recipient_username = $2
                      AND conversation_id = $3
                      AND status IN ('pending', 'retry', 'sending', 'sent')
                      AND created_at >= NOW() - ($4 * INTERVAL '1 second')
                )
            ''', channel, recipient_username, int(conversation_id), int(window_seconds))
        return bool(value)

    async def enqueue_outbox(self, *, event_id: str, channel: str, recipient_username: str, subscription_id: int,
                             title: str, body: str, url: str, payload: dict[str, Any], max_attempts: int) -> bool:
        pool = self._pool_supplier()
        payload_json = json.dumps(payload or {}, ensure_ascii=False)
        conversation_id = int((payload or {}).get('conversation_id') or 0)
        async with pool.acquire() as conn:
            result = await conn.execute('''
                INSERT INTO notify_outbox
                    (event_id, channel, recipient_username, subscription_id, conversation_id, title, body, url, payload_json, max_attempts, status, next_retry_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', NOW())
                ON CONFLICT (event_id, channel, subscription_id) DO NOTHING
            ''', event_id, channel, recipient_username, int(subscription_id or 0), conversation_id, title, body, url, payload_json, int(max_attempts or 5))
        return str(result).endswith('1')

    async def claim_pending_outbox(self, *, limit: int) -> list[dict[str, Any]]:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            rows = await conn.fetch('''
                UPDATE notify_outbox
                SET status = 'sending', updated_at = NOW()
                WHERE id IN (
                    SELECT o.id
                    FROM notify_outbox o
                    JOIN notify_push_subscriptions s ON s.id = o.subscription_id
                    WHERE o.status IN ('pending', 'retry')
                      AND o.next_retry_at <= NOW()
                      AND o.attempt_count < o.max_attempts
                      AND s.enabled = TRUE
                      AND s.disabled_at IS NULL
                    ORDER BY o.next_retry_at ASC, o.id ASC
                    LIMIT $1
                    FOR UPDATE OF o SKIP LOCKED
                )
                RETURNING *
            ''', max(1, int(limit or 100)))
        items = [_serialize_outbox(row) for row in rows]
        subscription_ids = [int(item.get('subscription_id') or 0) for item in items if int(item.get('subscription_id') or 0) > 0]
        subscriptions = await self.get_subscriptions_by_ids(subscription_ids)
        for item in items:
            item['subscription'] = subscriptions.get(int(item.get('subscription_id') or 0), {})
        return items

    async def get_subscriptions_by_ids(self, subscription_ids: list[int]) -> dict[int, dict[str, Any]]:
        ids = sorted({int(item or 0) for item in subscription_ids or [] if int(item or 0) > 0})
        if not ids:
            return {}
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            rows = await conn.fetch('SELECT * FROM notify_push_subscriptions WHERE id = ANY($1::bigint[])', ids)
        return {int(row['id']): _serialize_subscription(row) for row in rows}

    async def mark_outbox_sent(self, *, outbox_id: int, provider_message_id: str, provider_record_id: str) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute('''
                UPDATE notify_outbox
                SET status = 'sent', sent_at = NOW(), updated_at = NOW(), last_error = '', provider_message_id = $2, provider_record_id = $3
                WHERE id = $1
            ''', int(outbox_id), provider_message_id or '', provider_record_id or '')

    async def mark_outbox_failed(self, *, outbox_id: int, error: str, retry_base_seconds: int) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute('''
                UPDATE notify_outbox
                SET attempt_count = attempt_count + 1,
                    status = CASE WHEN attempt_count + 1 >= max_attempts THEN 'failed' ELSE 'retry' END,
                    next_retry_at = NOW() + (($2 * LEAST(16, GREATEST(1, attempt_count + 1))) || ' seconds')::interval,
                    last_error = $3,
                    updated_at = NOW()
                WHERE id = $1
            ''', int(outbox_id), max(5, int(retry_base_seconds or 60)), str(error or '')[:1000])

    async def mark_outbox_permanent_failed(self, *, outbox_id: int, error: str) -> None:
        pool = self._pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute('''
                UPDATE notify_outbox
                SET attempt_count = max_attempts,
                    status = 'failed',
                    last_error = $2,
                    updated_at = NOW()
                WHERE id = $1
            ''', int(outbox_id), str(error or '')[:1000])


def _serialize_row(row: Any) -> dict[str, Any]:
    if not row:
        return {}
    result = dict(row)
    for key in list(result.keys()):
        value = result.get(key)
        if hasattr(value, 'isoformat'):
            result[key] = value.isoformat()
    return result


def _serialize_subscription(row: Any) -> dict[str, Any]:
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


def _build_endpoint_hash(endpoint: str) -> str:
    return hashlib.md5(str(endpoint or '').encode('utf-8')).hexdigest()
