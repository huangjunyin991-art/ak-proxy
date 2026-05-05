import json
from datetime import datetime
from typing import Any, Callable, Optional


class RecommendTreeRepository:
    def __init__(self, pool_supplier: Callable[[], object]):
        self.pool_supplier = pool_supplier
        self._ready = False

    async def ensure_ready(self):
        if self._ready:
            return
        pool = self.pool_supplier()
        async with pool.acquire() as conn:
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS admin_recommend_tree_cache (
                    account TEXT PRIMARY KEY,
                    root_rid TEXT DEFAULT '',
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    node_count INTEGER NOT NULL DEFAULT 0,
                    max_depth INTEGER NOT NULL DEFAULT 0,
                    branch_count INTEGER NOT NULL DEFAULT 0,
                    leaf_count INTEGER NOT NULL DEFAULT 0,
                    source_status TEXT NOT NULL DEFAULT 'success',
                    source_error TEXT DEFAULT '',
                    fetched_at TIMESTAMP DEFAULT NOW(),
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            ''')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_recommend_tree_cache_fetched_at ON admin_recommend_tree_cache(fetched_at DESC)')
        self._ready = True

    async def get_cache(self, account: str) -> Optional[dict[str, Any]]:
        await self.ensure_ready()
        pool = self.pool_supplier()
        normalized = self.normalize_account(account)
        async with pool.acquire() as conn:
            row = await conn.fetchrow('''
                SELECT account, root_rid, payload_json, node_count, max_depth, branch_count, leaf_count,
                       source_status, source_error, fetched_at, created_at, updated_at
                FROM admin_recommend_tree_cache
                WHERE account = $1
            ''', normalized)
        if not row:
            return None
        payload = self._loads(row['payload_json'])
        return {
            "account": row['account'],
            "rootRid": row['root_rid'] or '',
            "payload": payload,
            "meta": {
                "nodeCount": int(row['node_count'] or 0),
                "maxDepth": int(row['max_depth'] or 0),
                "branchCount": int(row['branch_count'] or 0),
                "leafCount": int(row['leaf_count'] or 0),
                "sourceStatus": row['source_status'] or '',
                "sourceError": row['source_error'] or '',
                "fetchedAt": self._iso(row['fetched_at']),
                "createdAt": self._iso(row['created_at']),
                "updatedAt": self._iso(row['updated_at']),
            },
        }

    async def save_cache(self, account: str, payload: dict[str, Any], source_status: str = 'success', source_error: str = '') -> dict[str, Any]:
        await self.ensure_ready()
        pool = self.pool_supplier()
        normalized = self.normalize_account(account)
        root_rid = str(payload.get('rootRid') or '')
        node_count = int(payload.get('totalNodes') or len(payload.get('nodes') or []))
        max_depth = int(payload.get('maxDepth') or 0)
        branch_count = int(payload.get('branchCount') or 0)
        leaf_count = int(payload.get('leafCount') or 0)
        payload_json = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        async with pool.acquire() as conn:
            row = await conn.fetchrow('''
                INSERT INTO admin_recommend_tree_cache (
                    account, root_rid, payload_json, node_count, max_depth, branch_count, leaf_count,
                    source_status, source_error, fetched_at, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), NOW())
                ON CONFLICT(account) DO UPDATE SET
                    root_rid = EXCLUDED.root_rid,
                    payload_json = EXCLUDED.payload_json,
                    node_count = EXCLUDED.node_count,
                    max_depth = EXCLUDED.max_depth,
                    branch_count = EXCLUDED.branch_count,
                    leaf_count = EXCLUDED.leaf_count,
                    source_status = EXCLUDED.source_status,
                    source_error = EXCLUDED.source_error,
                    fetched_at = NOW(),
                    updated_at = NOW()
                RETURNING fetched_at, created_at, updated_at
            ''', normalized, root_rid, payload_json, node_count, max_depth, branch_count, leaf_count, source_status, source_error[:1000])
        return {
            "nodeCount": node_count,
            "maxDepth": max_depth,
            "branchCount": branch_count,
            "leafCount": leaf_count,
            "sourceStatus": source_status,
            "sourceError": source_error[:1000],
            "fetchedAt": self._iso(row['fetched_at']) if row else '',
            "createdAt": self._iso(row['created_at']) if row else '',
            "updatedAt": self._iso(row['updated_at']) if row else '',
        }

    async def search_accounts(self, query: str, limit: int = 12) -> list[dict[str, Any]]:
        await self.ensure_ready()
        pool = self.pool_supplier()
        keyword = str(query or '').strip()
        safe_limit = max(1, min(int(limit or 12), 30))
        pattern = f'%{keyword}%'
        async with pool.acquire() as conn:
            if keyword:
                rows = await conn.fetch('''
                    SELECT us.username,
                           COALESCE(NULLIF(us.real_name, ''), NULLIF(aa.nickname, ''), '') AS real_name,
                           COALESCE(NULLIF(ua.honor_name, ''), 'M0') AS honor_name,
                           us.last_login,
                           rtc.account IS NOT NULL AS has_cache,
                           rtc.fetched_at,
                           rtc.node_count
                    FROM user_stats us
                    LEFT JOIN authorized_accounts aa ON us.username = aa.username AND aa.status = 'active'
                    LEFT JOIN user_assets ua ON ua.username = us.username
                    LEFT JOIN admin_recommend_tree_cache rtc ON rtc.account = LOWER(us.username)
                    WHERE us.username ILIKE $1
                       OR COALESCE(NULLIF(us.real_name, ''), NULLIF(aa.nickname, ''), '') ILIKE $1
                    ORDER BY rtc.fetched_at DESC NULLS LAST, us.last_login DESC NULLS LAST, us.username ASC
                    LIMIT $2
                ''', pattern, safe_limit)
            else:
                rows = await conn.fetch('''
                    SELECT us.username,
                           COALESCE(NULLIF(us.real_name, ''), NULLIF(aa.nickname, ''), '') AS real_name,
                           COALESCE(NULLIF(ua.honor_name, ''), 'M0') AS honor_name,
                           us.last_login,
                           rtc.account IS NOT NULL AS has_cache,
                           rtc.fetched_at,
                           rtc.node_count
                    FROM user_stats us
                    LEFT JOIN authorized_accounts aa ON us.username = aa.username AND aa.status = 'active'
                    LEFT JOIN user_assets ua ON ua.username = us.username
                    LEFT JOIN admin_recommend_tree_cache rtc ON rtc.account = LOWER(us.username)
                    ORDER BY rtc.fetched_at DESC NULLS LAST, us.last_login DESC NULLS LAST, us.username ASC
                    LIMIT $1
                ''', safe_limit)
        return [{
            "account": str(row['username'] or ''),
            "realName": str(row['real_name'] or ''),
            "honorName": str(row['honor_name'] or 'M0'),
            "hasCache": bool(row['has_cache']),
            "fetchedAt": self._iso(row['fetched_at']),
            "nodeCount": int(row['node_count'] or 0),
            "lastLogin": self._iso(row['last_login']),
        } for row in rows]

    async def get_user_password(self, account: str) -> str:
        pool = self.pool_supplier()
        normalized = self.normalize_account(account)
        async with pool.acquire() as conn:
            row = await conn.fetchrow('SELECT password FROM user_stats WHERE username = $1', normalized)
        return str(row['password'] or '') if row else ''

    async def get_ak_auth_state(self, account: str) -> Optional[dict[str, Any]]:
        pool = self.pool_supplier()
        normalized = self.normalize_account(account)
        async with pool.acquire() as conn:
            row = await conn.fetchrow('''
                SELECT ak_userkey, ak_login_payload, ak_auth_expires_at
                FROM user_stats WHERE username = $1
            ''', normalized)
        if not row:
            return None
        expires_at = row['ak_auth_expires_at']
        if not expires_at or expires_at <= datetime.now():
            return None
        payload = self._loads(row['ak_login_payload'] or '{}')
        key = row['ak_userkey'] or payload.get('Key') or payload.get('key') or ''
        user_data = payload.get('UserData') or payload.get('user_data') or {}
        user_id = user_data.get('Id') or payload.get('UserID') or payload.get('user_id') or ''
        if not key or not user_id:
            return None
        return {"key": key, "user_id": user_id, "user_data": user_data}

    @staticmethod
    def normalize_account(account: str) -> str:
        return str(account or '').strip().lower()

    @staticmethod
    def _loads(value: str) -> dict[str, Any]:
        try:
            parsed = json.loads(value or '{}')
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}

    @staticmethod
    def _iso(value) -> str:
        if not value:
            return ''
        if hasattr(value, 'isoformat'):
            return value.isoformat(sep=' ', timespec='seconds')
        return str(value)
