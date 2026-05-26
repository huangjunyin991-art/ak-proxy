import asyncio
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
                    is_active BOOLEAN NOT NULL DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    released_at TIMESTAMP
                )
            ''')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_risk_isolations_active ON risk_isolations(is_active)')
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
            'isolated_at': serialize_time(row.get('isolated_at')),
            'updated_at': serialize_time(row.get('updated_at')),
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
            total = await conn.fetchval(f"SELECT COUNT(*) FROM authorized_accounts aa{where}", *params)
            isolated_total = await conn.fetchval(f'''
                SELECT COUNT(*)
                FROM authorized_accounts aa
                JOIN risk_isolations ri ON ri.username = aa.username AND ri.is_active = TRUE
                {where}
            ''', *params)
            page_params = list(params)
            page_params.extend([page_limit, page_offset])
            rows = await conn.fetch(f'''
                SELECT aa.username, aa.nickname, aa.added_by, aa.status, aa.expire_time,
                       COALESCE(ri.is_active, FALSE) AS is_active,
                       COALESCE(ri.isolated_by, '') AS isolated_by,
                       COALESCE(ri.isolated_by_role, '') AS isolated_by_role,
                       COALESCE(ri.reason, '') AS reason,
                       ri.created_at AS isolated_at,
                       ri.updated_at
                FROM authorized_accounts aa
                LEFT JOIN risk_isolations ri ON ri.username = aa.username AND ri.is_active = TRUE
                {where}
                ORDER BY COALESCE(ri.is_active, FALSE) DESC, aa.created_at DESC
                LIMIT ${idx} OFFSET ${idx + 1}
            ''', *page_params)
        return {
            'total': int(total or 0),
            'isolated_total': int(isolated_total or 0),
            'rows': [self._serialize_account_row(dict(row)) for row in rows],
        }

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
                                operator_role: str, reason: str = '') -> dict[str, Any]:
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
            await conn.executemany('''
                INSERT INTO risk_isolations (username, isolated_by, isolated_by_role, reason, is_active, created_at, updated_at, released_at)
                VALUES ($1, $2, $3, $4, TRUE, NOW(), NOW(), NULL)
                ON CONFLICT(username) DO UPDATE SET
                    isolated_by = $2,
                    isolated_by_role = $3,
                    reason = $4,
                    is_active = TRUE,
                    created_at = NOW(),
                    updated_at = NOW(),
                    released_at = NULL
            ''', [(username, operator, operator_role, str(reason or '').strip()) for username in normalized])
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
