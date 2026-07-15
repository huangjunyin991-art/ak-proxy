import json
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from .products import list_products as list_registered_products


class LicenseCenterRepository:
    def __init__(self, pool_supplier: Callable[[], object]):
        self.pool_supplier = pool_supplier

    def _pool(self):
        return self.pool_supplier()

    async def ensure_schema(self) -> None:
        pool = self._pool()
        async with pool.acquire() as conn:
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS license_center_products (
                    product_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL DEFAULT '',
                    description TEXT DEFAULT '',
                    current_version TEXT DEFAULT '0.0.0',
                    default_channel TEXT DEFAULT 'stable',
                    enabled BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW()
                )
            ''')
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS license_center_keys (
                    license_key TEXT PRIMARY KEY,
                    product_id TEXT NOT NULL,
                    billing_mode TEXT NOT NULL DEFAULT 'unlimited',
                    status TEXT NOT NULL DEFAULT 'inactive',
                    max_devices INTEGER NOT NULL DEFAULT 1,
                    max_uses INTEGER,
                    remaining_uses INTEGER,
                    usage_time INTEGER,
                    expiry_date TIMESTAMP,
                    created_by TEXT DEFAULT 'admin',
                    activated_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    metadata JSONB DEFAULT '{}'::jsonb
                )
            ''')
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS license_center_devices (
                    id BIGSERIAL PRIMARY KEY,
                    license_key TEXT NOT NULL REFERENCES license_center_keys(license_key) ON DELETE CASCADE,
                    product_id TEXT NOT NULL,
                    machine_id TEXT NOT NULL,
                    hardware_fingerprint JSONB DEFAULT '{}'::jsonb,
                    account_name TEXT DEFAULT '',
                    client_version TEXT DEFAULT '',
                    ip_address TEXT DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'active',
                    first_activated_at TIMESTAMP DEFAULT NOW(),
                    last_verified_at TIMESTAMP DEFAULT NOW(),
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(license_key, machine_id)
                )
            ''')
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS license_center_blacklist (
                    id BIGSERIAL PRIMARY KEY,
                    target_type TEXT NOT NULL,
                    target_value TEXT NOT NULL,
                    reason TEXT DEFAULT '',
                    created_by TEXT DEFAULT 'admin',
                    expires_at TIMESTAMP,
                    active BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(target_type, target_value)
                )
            ''')
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS license_center_verification_logs (
                    id BIGSERIAL PRIMARY KEY,
                    license_key TEXT DEFAULT '',
                    product_id TEXT DEFAULT '',
                    machine_id TEXT DEFAULT '',
                    account_name TEXT DEFAULT '',
                    client_version TEXT DEFAULT '',
                    ip_address TEXT DEFAULT '',
                    action TEXT DEFAULT '',
                    result TEXT DEFAULT '',
                    message TEXT DEFAULT '',
                    raw_payload JSONB DEFAULT '{}'::jsonb,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            ''')
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS license_center_releases (
                    id BIGSERIAL PRIMARY KEY,
                    product_id TEXT NOT NULL,
                    version TEXT NOT NULL,
                    channel TEXT DEFAULT 'stable',
                    update_type TEXT DEFAULT 'recommended',
                    is_mandatory BOOLEAN DEFAULT FALSE,
                    can_skip BOOLEAN DEFAULT TRUE,
                    download_url TEXT DEFAULT '',
                    file_size BIGINT DEFAULT 0,
                    file_hash TEXT DEFAULT '',
                    announcement TEXT DEFAULT '',
                    announcement_content TEXT DEFAULT '',
                    release_notes TEXT DEFAULT '',
                    published BOOLEAN DEFAULT FALSE,
                    created_by TEXT DEFAULT 'admin',
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    UNIQUE(product_id, version, channel)
                )
            ''')
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS license_center_credentials (
                    license_key TEXT NOT NULL REFERENCES license_center_keys(license_key) ON DELETE CASCADE,
                    machine_id TEXT NOT NULL,
                    login_password_hash TEXT DEFAULT '',
                    verify_password_hash TEXT DEFAULT '',
                    google_secret TEXT DEFAULT '',
                    google_enabled BOOLEAN DEFAULT FALSE,
                    email TEXT DEFAULT '',
                    phone TEXT DEFAULT '',
                    login_count INTEGER DEFAULT 0,
                    failed_attempts INTEGER DEFAULT 0,
                    locked_until TIMESTAMP,
                    last_login_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT NOW(),
                    updated_at TIMESTAMP DEFAULT NOW(),
                    PRIMARY KEY(license_key, machine_id)
                )
            ''')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_lc_keys_product_status ON license_center_keys(product_id, status)')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_lc_devices_machine ON license_center_devices(machine_id)')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_lc_logs_created ON license_center_verification_logs(created_at DESC)')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_lc_blacklist_target ON license_center_blacklist(target_type, target_value, active)')
            await conn.execute('CREATE INDEX IF NOT EXISTS idx_lc_credentials_machine ON license_center_credentials(machine_id)')
            for product in list_registered_products():
                await conn.execute('''
                    INSERT INTO license_center_products(product_id, name, description, current_version, enabled)
                    VALUES ($1, $2, $3, $4, TRUE)
                    ON CONFLICT(product_id) DO UPDATE SET
                        name = EXCLUDED.name,
                        description = EXCLUDED.description,
                        current_version = EXCLUDED.current_version,
                        enabled = TRUE,
                        updated_at = NOW()
                ''', product.product_id, product.name, product.description, product.current_version)

    async def create_license(self, row: Dict[str, Any]) -> Dict[str, Any]:
        pool = self._pool()
        async with pool.acquire() as conn:
            record = await conn.fetchrow('''
                INSERT INTO license_center_keys(
                    license_key, product_id, billing_mode, status, max_devices,
                    max_uses, remaining_uses, usage_time, expiry_date, created_by, metadata
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
                RETURNING *
            ''', row['license_key'], row['product_id'], row['billing_mode'], row['status'], row['max_devices'], row.get('max_uses'), row.get('remaining_uses'), row.get('usage_time'), row.get('expiry_date'), row.get('created_by', 'admin'), json.dumps(row.get('metadata') or {}, ensure_ascii=False))
            await conn.execute('''
                INSERT INTO license_logs (action, license_key, product_id, billing_mode, detail, operator)
                VALUES ($1, $2, $3, $4, $5, $6)
            ''', 'create', row['license_key'], row['product_id'], row['billing_mode'], row.get('detail', ''), row.get('created_by', 'admin'))
            return dict(record)

    async def get_license(self, license_key: str) -> Optional[Dict[str, Any]]:
        pool = self._pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow('SELECT * FROM license_center_keys WHERE license_key = $1', license_key)
            return dict(row) if row else None

    async def find_license_by_machine(self, machine_id: str, product_id: str = '') -> Optional[Dict[str, Any]]:
        pool = self._pool()
        async with pool.acquire() as conn:
            if product_id:
                row = await conn.fetchrow('''
                    SELECT k.* FROM license_center_keys k
                    JOIN license_center_devices d ON d.license_key = k.license_key
                    WHERE d.machine_id = $1 AND k.product_id = $2 AND d.status = 'active'
                    ORDER BY d.last_verified_at DESC LIMIT 1
                ''', machine_id, product_id)
            else:
                row = await conn.fetchrow('''
                    SELECT k.* FROM license_center_keys k
                    JOIN license_center_devices d ON d.license_key = k.license_key
                    WHERE d.machine_id = $1 AND d.status = 'active'
                    ORDER BY d.last_verified_at DESC LIMIT 1
                ''', machine_id)
            return dict(row) if row else None

    async def list_licenses(self, limit: int, offset: int) -> Dict[str, Any]:
        pool = self._pool()
        async with pool.acquire() as conn:
            total = await conn.fetchval('SELECT COUNT(*) FROM license_center_keys')
            rows = await conn.fetch('''
                SELECT k.*, d.machine_id
                FROM license_center_keys k
                LEFT JOIN LATERAL (
                    SELECT machine_id FROM license_center_devices d
                    WHERE d.license_key = k.license_key
                    ORDER BY d.last_verified_at DESC LIMIT 1
                ) d ON TRUE
                ORDER BY k.created_at DESC
                LIMIT $1 OFFSET $2
            ''', limit, offset)
            return {'total': int(total or 0), 'items': [dict(r) for r in rows]}

    async def update_license(self, license_key: str, fields: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        allowed = ['product_id', 'billing_mode', 'status', 'max_devices', 'max_uses', 'remaining_uses', 'usage_time', 'expiry_date', 'activated_at', 'metadata']
        assignments = []
        values = []
        for key in allowed:
            if key in fields:
                values.append(json.dumps(fields[key], ensure_ascii=False) if key == 'metadata' else fields[key])
                cast = '::jsonb' if key == 'metadata' else ''
                assignments.append(f'{key} = ${len(values)}{cast}')
        if not assignments:
            return await self.get_license(license_key)
        values.append(license_key)
        pool = self._pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(f'''
                UPDATE license_center_keys
                SET {', '.join(assignments)}, updated_at = NOW()
                WHERE license_key = ${len(values)}
                RETURNING *
            ''', *values)
            return dict(row) if row else None

    async def count_devices(self, license_key: str) -> int:
        pool = self._pool()
        async with pool.acquire() as conn:
            value = await conn.fetchval('SELECT COUNT(*) FROM license_center_devices WHERE license_key = $1 AND status = $2', license_key, 'active')
            return int(value or 0)

    async def upsert_device(self, license_key: str, product_id: str, machine_id: str, hardware: Dict[str, Any], account_name: str, client_version: str, ip_address: str) -> Dict[str, Any]:
        pool = self._pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow('''
                INSERT INTO license_center_devices(
                    license_key, product_id, machine_id, hardware_fingerprint,
                    account_name, client_version, ip_address, status
                ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,'active')
                ON CONFLICT(license_key, machine_id) DO UPDATE SET
                    hardware_fingerprint = EXCLUDED.hardware_fingerprint,
                    account_name = EXCLUDED.account_name,
                    client_version = EXCLUDED.client_version,
                    ip_address = EXCLUDED.ip_address,
                    last_verified_at = NOW(),
                    updated_at = NOW()
                RETURNING *
            ''', license_key, product_id, machine_id, json.dumps(hardware or {}, ensure_ascii=False), account_name or '', client_version or '', ip_address or '')
            return dict(row)

    async def list_devices(self, limit: int, offset: int) -> Dict[str, Any]:
        pool = self._pool()
        async with pool.acquire() as conn:
            total = await conn.fetchval('SELECT COUNT(*) FROM license_center_devices')
            rows = await conn.fetch('''
                SELECT d.*, k.billing_mode, k.status AS license_status
                FROM license_center_devices d
                LEFT JOIN license_center_keys k ON k.license_key = d.license_key
                ORDER BY d.last_verified_at DESC
                LIMIT $1 OFFSET $2
            ''', limit, offset)
            return {'total': int(total or 0), 'items': [dict(r) for r in rows]}

    async def get_device(self, device_id: str) -> Optional[Dict[str, Any]]:
        pool = self._pool()
        async with pool.acquire() as conn:
            row = None
            if str(device_id or '').isdigit():
                row = await conn.fetchrow('SELECT * FROM license_center_devices WHERE id = $1', int(device_id))
            if row is None:
                row = await conn.fetchrow('SELECT * FROM license_center_devices WHERE machine_id = $1 ORDER BY last_verified_at DESC LIMIT 1', str(device_id or ''))
            return dict(row) if row else None

    async def get_license_device(self, license_key: str, machine_id: str) -> Optional[Dict[str, Any]]:
        pool = self._pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow('''
                SELECT * FROM license_center_devices
                WHERE license_key = $1 AND machine_id = $2
                LIMIT 1
            ''', license_key, machine_id)
            return dict(row) if row else None

    async def get_credentials(self, license_key: str, machine_id: str) -> Optional[Dict[str, Any]]:
        pool = self._pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow('''
                SELECT * FROM license_center_credentials
                WHERE license_key = $1 AND machine_id = $2
                LIMIT 1
            ''', license_key, machine_id)
            return dict(row) if row else None

    async def upsert_credentials(self, row: Dict[str, Any]) -> Dict[str, Any]:
        pool = self._pool()
        async with pool.acquire() as conn:
            record = await conn.fetchrow('''
                INSERT INTO license_center_credentials(
                    license_key, machine_id, login_password_hash, verify_password_hash,
                    google_secret, google_enabled, email, phone
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                ON CONFLICT(license_key, machine_id) DO UPDATE SET
                    login_password_hash = EXCLUDED.login_password_hash,
                    verify_password_hash = EXCLUDED.verify_password_hash,
                    google_secret = CASE WHEN $9 THEN EXCLUDED.google_secret ELSE license_center_credentials.google_secret END,
                    google_enabled = CASE WHEN $10 THEN EXCLUDED.google_enabled ELSE license_center_credentials.google_enabled END,
                    email = EXCLUDED.email,
                    phone = EXCLUDED.phone,
                    updated_at = NOW()
                RETURNING *
            ''',
                row['license_key'],
                row['machine_id'],
                row.get('login_password_hash') or '',
                row.get('verify_password_hash') or '',
                row.get('google_secret') or '',
                bool(row.get('google_enabled')),
                row.get('email') or '',
                row.get('phone') or '',
                'google_secret' in row,
                'google_enabled' in row,
            )
            return dict(record)

    async def update_credentials(self, license_key: str, machine_id: str, fields: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        allowed = [
            'login_password_hash', 'verify_password_hash', 'google_secret', 'google_enabled',
            'email', 'phone', 'login_count', 'failed_attempts', 'locked_until', 'last_login_at'
        ]
        assignments = []
        values = []
        for key in allowed:
            if key in fields:
                values.append(fields[key])
                assignments.append(f'{key} = ${len(values)}')
        if not assignments:
            return await self.get_credentials(license_key, machine_id)
        values.extend([license_key, machine_id])
        pool = self._pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(f'''
                UPDATE license_center_credentials
                SET {', '.join(assignments)}, updated_at = NOW()
                WHERE license_key = ${len(values) - 1} AND machine_id = ${len(values)}
                RETURNING *
            ''', *values)
            return dict(row) if row else None

    async def set_device_status(self, device_id: str, status: str) -> Optional[Dict[str, Any]]:
        pool = self._pool()
        async with pool.acquire() as conn:
            row = None
            if str(device_id or '').isdigit():
                row = await conn.fetchrow('''
                    UPDATE license_center_devices SET status = $1, updated_at = NOW()
                    WHERE id = $2 RETURNING *
                ''', status, int(device_id))
            if row is None:
                row = await conn.fetchrow('''
                    UPDATE license_center_devices SET status = $1, updated_at = NOW()
                    WHERE machine_id = $2 RETURNING *
                ''', status, str(device_id or ''))
            return dict(row) if row else None

    async def is_blacklisted(self, target_type: str, target_value: str) -> Optional[Dict[str, Any]]:
        if not target_value:
            return None
        pool = self._pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow('''
                SELECT * FROM license_center_blacklist
                WHERE target_type = $1 AND target_value = $2 AND active = TRUE
                  AND (expires_at IS NULL OR expires_at > NOW())
                LIMIT 1
            ''', target_type, target_value)
            return dict(row) if row else None

    async def add_blacklist(self, target_type: str, target_value: str, reason: str, operator: str) -> Dict[str, Any]:
        pool = self._pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow('''
                INSERT INTO license_center_blacklist(target_type, target_value, reason, created_by, active)
                VALUES ($1,$2,$3,$4,TRUE)
                ON CONFLICT(target_type, target_value) DO UPDATE SET
                    reason = EXCLUDED.reason,
                    created_by = EXCLUDED.created_by,
                    active = TRUE,
                    created_at = NOW()
                RETURNING *
            ''', target_type, target_value, reason or '', operator or 'admin')
            await conn.execute('''
                INSERT INTO license_logs (action, license_key, product_id, billing_mode, detail, operator)
                VALUES ($1, $2, $3, $4, $5, $6)
            ''', 'blacklist_add', target_value, None, None, f'{target_type}: {reason or ""}', operator or 'admin')
            return dict(row)

    async def remove_blacklist(self, target_type: str, target_value: str, operator: str) -> bool:
        pool = self._pool()
        async with pool.acquire() as conn:
            result = await conn.execute('''
                UPDATE license_center_blacklist SET active = FALSE
                WHERE target_type = $1 AND target_value = $2
            ''', target_type, target_value)
            await conn.execute('''
                INSERT INTO license_logs (action, license_key, product_id, billing_mode, detail, operator)
                VALUES ($1, $2, $3, $4, $5, $6)
            ''', 'blacklist_remove', target_value, None, None, target_type, operator or 'admin')
            return int(result.split()[-1]) > 0

    async def list_blacklist(self) -> List[Dict[str, Any]]:
        pool = self._pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch('SELECT * FROM license_center_blacklist WHERE active = TRUE ORDER BY created_at DESC')
            return [dict(r) for r in rows]

    async def statistics(self) -> Dict[str, Any]:
        pool = self._pool()
        async with pool.acquire() as conn:
            total = await conn.fetchval('SELECT COUNT(*) FROM license_center_keys')
            active = await conn.fetchval("SELECT COUNT(*) FROM license_center_keys WHERE status = 'active'")
            clients = await conn.fetchval("SELECT COUNT(*) FROM license_center_devices WHERE status = 'active'")
            blacklist = await conn.fetchval('SELECT COUNT(*) FROM license_center_blacklist WHERE active = TRUE')
            return {
                'total_licenses': int(total or 0),
                'active_licenses': int(active or 0),
                'active_clients': int(clients or 0),
                'blacklist_count': int(blacklist or 0),
            }

    async def add_verification_log(self, payload: Dict[str, Any]) -> None:
        pool = self._pool()
        async with pool.acquire() as conn:
            await conn.execute('''
                INSERT INTO license_center_verification_logs(
                    license_key, product_id, machine_id, account_name, client_version,
                    ip_address, action, result, message, raw_payload
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
            ''', payload.get('license_key') or '', payload.get('product_id') or '', payload.get('machine_id') or '', payload.get('account_name') or '', payload.get('client_version') or '', payload.get('ip_address') or '', payload.get('action') or '', payload.get('result') or '', payload.get('message') or '', json.dumps(payload.get('raw_payload') or {}, ensure_ascii=False))

    async def list_verification_logs(self, limit: int, offset: int) -> Dict[str, Any]:
        pool = self._pool()
        async with pool.acquire() as conn:
            total = await conn.fetchval('SELECT COUNT(*) FROM license_center_verification_logs')
            rows = await conn.fetch('''
                SELECT created_at, license_key, action, message, machine_id, ip_address, result
                FROM license_center_verification_logs
                ORDER BY created_at DESC LIMIT $1 OFFSET $2
            ''', limit, offset)
            items = []
            for row in rows:
                item = dict(row)
                item['timestamp'] = item.get('created_at')
                item['details'] = item.get('message') or item.get('machine_id') or item.get('result') or ''
                item['client_ip'] = item.get('ip_address') or ''
                items.append(item)
            return {'total': int(total or 0), 'items': items}

    async def add_legacy_log(self, action: str, license_key: Optional[str], product_id: Optional[str], billing_mode: Optional[str], detail: Optional[str], operator: str) -> None:
        pool = self._pool()
        async with pool.acquire() as conn:
            await conn.execute('''
                INSERT INTO license_logs (action, license_key, product_id, billing_mode, detail, operator)
                VALUES ($1, $2, $3, $4, $5, $6)
            ''', action, license_key, product_id, billing_mode, detail, operator or 'admin')

    async def list_products(self) -> List[Dict[str, Any]]:
        pool = self._pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch('''
                SELECT * FROM license_center_products
                WHERE enabled = TRUE
                ORDER BY created_at ASC, product_id ASC
            ''')
            return [dict(r) for r in rows]

    async def get_latest_release(self, product_id: str, channel: str = 'stable') -> Optional[Dict[str, Any]]:
        pool = self._pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow('''
                SELECT * FROM license_center_releases
                WHERE product_id = $1 AND channel = $2 AND published = TRUE
                ORDER BY created_at DESC LIMIT 1
            ''', product_id, channel or 'stable')
            return dict(row) if row else None

    async def upsert_release(self, row: Dict[str, Any]) -> Dict[str, Any]:
        pool = self._pool()
        async with pool.acquire() as conn:
            record = await conn.fetchrow('''
                INSERT INTO license_center_releases(
                    product_id, version, channel, update_type, is_mandatory,
                    can_skip, download_url, file_size, file_hash, announcement,
                    announcement_content, release_notes, published, created_by
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                ON CONFLICT(product_id, version, channel) DO UPDATE SET
                    update_type = EXCLUDED.update_type,
                    is_mandatory = EXCLUDED.is_mandatory,
                    can_skip = EXCLUDED.can_skip,
                    download_url = EXCLUDED.download_url,
                    file_size = EXCLUDED.file_size,
                    file_hash = EXCLUDED.file_hash,
                    announcement = EXCLUDED.announcement,
                    announcement_content = EXCLUDED.announcement_content,
                    release_notes = EXCLUDED.release_notes,
                    published = EXCLUDED.published,
                    created_by = EXCLUDED.created_by,
                    updated_at = NOW()
                RETURNING *
            ''',
                row['product_id'],
                row['version'],
                row.get('channel') or 'stable',
                row.get('update_type') or 'recommended',
                bool(row.get('is_mandatory')),
                bool(row.get('can_skip', True)),
                row.get('download_url') or '',
                int(row.get('file_size') or 0),
                row.get('file_hash') or '',
                row.get('announcement') or '',
                row.get('announcement_content') or '',
                row.get('release_notes') or '',
                bool(row.get('published', True)),
                row.get('created_by') or 'admin',
            )
            await conn.execute('''
                UPDATE license_center_products
                SET current_version = $1, updated_at = NOW()
                WHERE product_id = $2
            ''', row['version'], row['product_id'])
            return dict(record)

    async def list_releases(self, product_id: str = '', channel: str = '', limit: int = 50, offset: int = 0) -> Dict[str, Any]:
        pool = self._pool()
        conditions = []
        values = []
        if product_id:
            values.append(product_id)
            conditions.append(f'product_id = ${len(values)}')
        if channel:
            values.append(channel)
            conditions.append(f'channel = ${len(values)}')
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ''
        values_for_count = list(values)
        values.extend([limit, offset])
        async with pool.acquire() as conn:
            total = await conn.fetchval(f'SELECT COUNT(*) FROM license_center_releases {where}', *values_for_count)
            rows = await conn.fetch(f'''
                SELECT * FROM license_center_releases
                {where}
                ORDER BY created_at DESC
                LIMIT ${len(values) - 1} OFFSET ${len(values)}
            ''', *values)
            return {'total': int(total or 0), 'items': [dict(r) for r in rows]}
