import asyncio
import json
from typing import Any

from .schema import normalize_username, serialize_time


class RiskIsolationRepository:
    def __init__(self, db_module):
        self.db = db_module
        self._ready = False
        self._init_lock = asyncio.Lock()

    async def ensure_schema(self) -> None:
        pool = self.db._get_pool()
        async with pool.acquire() as conn:
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS risk_isolations (
                    username TEXT PRIMARY KEY,
                    isolated_by TEXT NOT NULL DEFAULT '',
                    isolated_by_role TEXT NOT NULL DEFAULT '',
                    reason TEXT DEFAULT '',
                    isolation_source TEXT NOT NULL DEFAULT 'manual',
                    umbrella_root TEXT NOT NULL DEFAULT '',
                    is_active BOOLEAN NOT NULL DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    released_at TIMESTAMP
                )
            ''')
            await conn.execute("ALTER TABLE risk_isolations ADD COLUMN IF NOT EXISTS isolation_source TEXT NOT NULL DEFAULT 'manual'")
            await conn.execute("ALTER TABLE risk_isolations ADD COLUMN IF NOT EXISTS umbrella_root TEXT NOT NULL DEFAULT ''")
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_risk_isolations_active ON risk_isolations(is_active)')
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS risk_isolation_userkeys (
                    userkey TEXT PRIMARY KEY,
                    username TEXT NOT NULL DEFAULT '',
                    user_id TEXT NOT NULL DEFAULT '',
                    is_active BOOLEAN NOT NULL DEFAULT TRUE,
                    source TEXT NOT NULL DEFAULT '',
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    released_at TIMESTAMP
                )
            ''')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_risk_isolation_userkeys_active ON risk_isolation_userkeys(is_active)')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_risk_isolation_userkeys_username ON risk_isolation_userkeys(username)')
        self._ready = True

    async def ensure_ready(self) -> None:
        if self._ready:
            return
        async with self._init_lock:
            if not self._ready:
                await self.ensure_schema()

    def _serialize_account_row(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            'username': normalize_username(row.get('username')),
            'nickname': str(row.get('nickname') or '').strip(),
            'added_by': str(row.get('added_by') or '').strip(),
            'status': str(row.get('status') or '').strip(),
            'expire_time': serialize_time(row.get('expire_time')),
            'isolated': bool(row.get('is_active')),
            'isolated_by': str(row.get('isolated_by') or '').strip(),
            'isolated_by_role': str(row.get('isolated_by_role') or '').strip(),
            'reason': str(row.get('reason') or '').strip(),
            'isolation_source': str(row.get('isolation_source') or '').strip(),
            'umbrella_root': normalize_username(row.get('umbrella_root')),
            'can_umbrella_restore': bool(
                row.get('is_active')
                and normalize_username(row.get('umbrella_root'))
                and normalize_username(row.get('umbrella_root')) == normalize_username(row.get('username'))
            ),
            'isolated_at': serialize_time(row.get('isolated_at')),
            'updated_at': serialize_time(row.get('updated_at')),
        }

    def _build_account_list_result(self, rows) -> dict[str, Any]:
        if not rows:
            return {'total': 0, 'isolated_total': 0, 'rows': []}
        first = dict(rows[0])
        result_rows = []
        for row in rows:
            item = dict(row)
            if item.get('username') is not None:
                result_rows.append(self._serialize_account_row(item))
        return {
            'total': int(first.get('total') or 0),
            'isolated_total': int(first.get('isolated_total') or 0),
            'rows': result_rows,
        }

    async def list_accounts(self, added_by: str | None = None, search: str | None = None,
                            limit: int = 200, offset: int = 0) -> dict[str, Any]:
        await self.ensure_ready()
        conditions = ["aa.status = 'active'"]
        params: list[Any] = []
        idx = 1
        if added_by:
            conditions.append(f"aa.added_by = ${idx}")
            params.append(added_by)
            idx += 1
        if search:
            conditions.append(f"(aa.username ILIKE ${idx} OR COALESCE(aa.nickname, '') ILIKE ${idx} OR aa.added_by ILIKE ${idx})")
            params.append(f"%{search}%")
            idx += 1
        where = f" WHERE {' AND '.join(conditions)}"
        page_limit = max(1, min(int(limit or 200), 500))
        page_offset = max(0, int(offset or 0))
        pool = self.db._get_pool()
        async with pool.acquire() as conn:
            page_params = list(params)
            page_params.extend([page_limit, page_offset])
            rows = await conn.fetch(f'''
                WITH filtered AS (
                    SELECT aa.username, aa.nickname, aa.added_by, aa.status, aa.expire_time,
                           aa.created_at AS account_created_at,
                           COALESCE(ri.is_active, FALSE) AS is_active,
                           COALESCE(ri.isolated_by, '') AS isolated_by,
                           COALESCE(ri.isolated_by_role, '') AS isolated_by_role,
                           COALESCE(ri.reason, '') AS reason,
                           COALESCE(ri.isolation_source, '') AS isolation_source,
                           COALESCE(ri.umbrella_root, '') AS umbrella_root,
                           ri.created_at AS isolated_at,
                           ri.updated_at
                    FROM authorized_accounts aa
                    LEFT JOIN risk_isolations ri ON ri.username = aa.username AND ri.is_active = TRUE
                    {where}
                ),
                counts AS (
                    SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_active IS TRUE) AS isolated_total
                    FROM filtered
                ),
                page_rows AS (
                    SELECT *
                    FROM filtered
                    ORDER BY is_active DESC, account_created_at DESC
                    LIMIT ${idx} OFFSET ${idx + 1}
                )
                SELECT counts.total, counts.isolated_total, page_rows.*
                FROM counts
                LEFT JOIN page_rows ON TRUE
                ORDER BY page_rows.is_active DESC, page_rows.account_created_at DESC
            ''', *page_params)
        return self._build_account_list_result(rows)

    async def list_sub_admin_scopes(self) -> list[dict[str, Any]]:
        await self.ensure_ready()
        pool = self.db._get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch('''
                SELECT s.name,
                       COALESCE(b.account_username, '') AS bound_username,
                       COUNT(aa.username) FILTER (WHERE aa.status = 'active') AS active_count,
                       COUNT(ri.username) FILTER (WHERE aa.status = 'active' AND ri.is_active = TRUE) AS isolated_count
                FROM sub_admins s
                LEFT JOIN sub_admin_account_bindings b ON b.sub_name = s.name
                LEFT JOIN authorized_accounts aa ON aa.added_by = s.name
                LEFT JOIN risk_isolations ri ON ri.username = aa.username
                GROUP BY s.name, b.account_username
                ORDER BY s.name
            ''')
        return [{
            'name': str(row['name'] or '').strip(),
            'bound_username': normalize_username(row['bound_username']),
            'active_count': int(row['active_count'] or 0),
            'isolated_count': int(row['isolated_count'] or 0),
        } for row in rows]

    async def filter_allowed_usernames(self, usernames: list[str], added_by: str | None = None) -> list[str]:
        await self.ensure_ready()
        normalized = []
        for username in usernames or []:
            value = normalize_username(username)
            if value and value not in normalized:
                normalized.append(value)
        if not normalized:
            return []
        conditions = ["username = ANY($1::text[])", "status = 'active'"]
        params: list[Any] = [normalized]
        if added_by:
            conditions.append("added_by = $2")
            params.append(added_by)
        pool = self.db._get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(f'''
                SELECT username
                FROM authorized_accounts
                WHERE {' AND '.join(conditions)}
            ''', *params)
        return [normalize_username(row['username']) for row in rows]

    async def filter_known_usernames(self, usernames: list[str]) -> list[str]:
        await self.ensure_ready()
        normalized = []
        for username in usernames or []:
            value = normalize_username(username)
            if value and value not in normalized:
                normalized.append(value)
        if not normalized:
            return []
        pool = self.db._get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch('''
                SELECT username
                FROM user_stats
                WHERE username = ANY($1::text[])
            ''', normalized)
        existing = {normalize_username(row['username']) for row in rows}
        return [username for username in normalized if username in existing]

    async def usernames_by_added_by(self, added_by: str | None = None) -> list[str]:
        await self.ensure_ready()
        pool = self.db._get_pool()
        async with pool.acquire() as conn:
            if added_by:
                rows = await conn.fetch('''
                    SELECT username
                    FROM authorized_accounts
                    WHERE added_by = $1 AND status = 'active'
                ''', added_by)
            else:
                rows = await conn.fetch('''
                    SELECT username
                    FROM authorized_accounts
                    WHERE status = 'active'
                ''')
        return [normalize_username(row['username']) for row in rows]

    async def isolate_usernames(self, usernames: list[str], operator: str,
                                operator_role: str, reason: str = '',
                                isolation_source: str = 'manual',
                                umbrella_root: str = '') -> dict[str, Any]:
        await self.ensure_ready()
        normalized = []
        for username in usernames or []:
            value = normalize_username(username)
            if value and value not in normalized:
                normalized.append(value)
        if not normalized:
            return {'updated': 0, 'usernames': []}
        source = str(isolation_source or 'manual').strip()[:40] or 'manual'
        root = normalize_username(umbrella_root)
        pool = self.db._get_pool()
        async with pool.acquire() as conn:
            await conn.execute('''
                WITH input_usernames AS (
                    SELECT DISTINCT UNNEST($1::text[]) AS username
                )
                INSERT INTO risk_isolations (
                    username, isolated_by, isolated_by_role, reason,
                    isolation_source, umbrella_root, is_active,
                    created_at, updated_at, released_at
                )
                SELECT username, $2, $3, $4, $5, $6, TRUE, NOW(), NOW(), NULL
                FROM input_usernames
                ON CONFLICT(username) DO UPDATE SET
                    isolated_by = $2,
                    isolated_by_role = $3,
                    reason = $4,
                    isolation_source = $5,
                    umbrella_root = $6,
                    is_active = TRUE,
                    created_at = NOW(),
                    updated_at = NOW(),
                    released_at = NULL
            ''', normalized, operator, operator_role, str(reason or '').strip(), source, root)
        return {'updated': len(normalized), 'usernames': normalized}

    async def release_usernames(self, usernames: list[str], added_by: str | None = None) -> dict[str, Any]:
        await self.ensure_ready()
        normalized = []
        for username in usernames or []:
            value = normalize_username(username)
            if value and value not in normalized:
                normalized.append(value)
        if not normalized:
            return {'updated': 0, 'usernames': []}
        pool = self.db._get_pool()
        async with pool.acquire() as conn:
            if added_by:
                rows = await conn.fetch('''
                    UPDATE risk_isolations ri
                    SET is_active = FALSE, updated_at = NOW(), released_at = NOW()
                    FROM authorized_accounts aa
                    WHERE ri.username = aa.username
                      AND ri.username = ANY($1::text[])
                      AND aa.added_by = $2
                      AND ri.is_active = TRUE
                    RETURNING ri.username
                ''', normalized, added_by)
            else:
                rows = await conn.fetch('''
                    UPDATE risk_isolations
                    SET is_active = FALSE, updated_at = NOW(), released_at = NOW()
                    WHERE username = ANY($1::text[]) AND is_active = TRUE
                    RETURNING username
                ''', normalized)
        released = [normalize_username(row['username']) for row in rows]
        return {'updated': len(released), 'usernames': released}

    async def release_scope(self, added_by: str | None = None) -> dict[str, Any]:
        await self.ensure_ready()
        pool = self.db._get_pool()
        async with pool.acquire() as conn:
            if added_by:
                rows = await conn.fetch('''
                    UPDATE risk_isolations ri
                    SET is_active = FALSE, updated_at = NOW(), released_at = NOW()
                    FROM authorized_accounts aa
                    WHERE ri.username = aa.username
                      AND aa.added_by = $1
                      AND aa.status = 'active'
                      AND ri.is_active = TRUE
                    RETURNING ri.username
                ''', added_by)
            else:
                rows = await conn.fetch('''
                    UPDATE risk_isolations ri
                    SET is_active = FALSE, updated_at = NOW(), released_at = NOW()
                    FROM authorized_accounts aa
                    WHERE ri.username = aa.username
                      AND aa.status = 'active'
                      AND ri.is_active = TRUE
                    RETURNING ri.username
                ''')
        released = [normalize_username(row['username']) for row in rows]
        return {'updated': len(released), 'usernames': released}

    async def list_active_userkeys(self) -> list[dict[str, Any]]:
        await self.ensure_ready()
        pool = self.db._get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch('''
                SELECT userkey, username, user_id
                FROM risk_isolation_userkeys
                WHERE is_active = TRUE
                  AND COALESCE(userkey, '') <> ''
            ''')
        return [
            {
                'userkey': str(row['userkey'] or '').strip(),
                'username': normalize_username(row['username']),
                'user_id': str(row['user_id'] or '').strip(),
            }
            for row in rows
            if str(row['userkey'] or '').strip()
        ]

    async def list_active_isolated_usernames(self) -> list[str]:
        await self.ensure_ready()
        pool = self.db._get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch('''
                SELECT username
                FROM risk_isolations
                WHERE is_active = TRUE
            ''')
        return [normalize_username(row['username']) for row in rows if normalize_username(row['username'])]

    async def sync_userkeys_from_local_auth(self, usernames: list[str], source: str = 'local_auth_state') -> dict[str, Any]:
        await self.ensure_ready()
        normalized = []
        for username in usernames or []:
            value = normalize_username(username)
            if value and value not in normalized:
                normalized.append(value)
        if not normalized:
            return {'updated': 0, 'usernames': [], 'keys': []}
        pool = self.db._get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch('''
                SELECT username, ak_userkey, ak_login_payload
                FROM user_stats
                WHERE username = ANY($1::text[])
                  AND COALESCE(ak_userkey, '') <> ''
            ''', normalized)
            items = []
            for row in rows:
                username = normalize_username(row['username'])
                userkey = str(row['ak_userkey'] or '').strip()
                if not username or not userkey:
                    continue
                user_id = ''
                payload = row['ak_login_payload']
                if payload:
                    try:
                        data = json.loads(payload) if isinstance(payload, str) else {}
                        user_data = data.get('UserData') if isinstance(data, dict) else {}
                        if isinstance(user_data, dict):
                            user_id = str(user_data.get('Id') or user_data.get('ID') or user_data.get('UserID') or '').strip()
                    except Exception:
                        user_id = ''
                items.append((userkey, username, user_id, str(source or '').strip()))
            if items:
                await conn.executemany('''
                    INSERT INTO risk_isolation_userkeys (userkey, username, user_id, is_active, source, created_at, updated_at, released_at)
                    VALUES ($1, $2, $3, TRUE, $4, NOW(), NOW(), NULL)
                    ON CONFLICT(userkey) DO UPDATE SET
                        username = $2,
                        user_id = $3,
                        is_active = TRUE,
                        source = $4,
                        updated_at = NOW(),
                        released_at = NULL
                ''', items)
        return {
            'updated': len(items),
            'usernames': [item[1] for item in items],
            'keys': [{'userkey': item[0], 'username': item[1], 'user_id': item[2]} for item in items],
        }

    async def release_userkeys_by_usernames(self, usernames: list[str]) -> dict[str, Any]:
        await self.ensure_ready()
        normalized = []
        for username in usernames or []:
            value = normalize_username(username)
            if value and value not in normalized:
                normalized.append(value)
        if not normalized:
            return {'updated': 0, 'usernames': []}
        pool = self.db._get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch('''
                UPDATE risk_isolation_userkeys
                SET is_active = FALSE, updated_at = NOW(), released_at = NOW()
                WHERE username = ANY($1::text[])
                  AND is_active = TRUE
                RETURNING username
            ''', normalized)
        released = []
        for row in rows:
            username = normalize_username(row['username'])
            if username and username not in released:
                released.append(username)
        return {'updated': len(rows), 'usernames': released}

    async def is_isolated(self, username: str) -> bool:
        await self.ensure_ready()
        normalized = normalize_username(username)
        if not normalized:
            return False
        pool = self.db._get_pool()
        async with pool.acquire() as conn:
            value = await conn.fetchval(
                "SELECT TRUE FROM risk_isolations WHERE username = $1 AND is_active = TRUE",
                normalized,
            )
        return bool(value)
