from typing import Any

from .admin_index_plan import ADMIN_INDEX_PLAN, AdminIndexDefinition


_INDEX_BY_NAME = {item.name: item for item in ADMIN_INDEX_PLAN}


def get_index_definition(name: str) -> AdminIndexDefinition | None:
    return _INDEX_BY_NAME.get(str(name or '').strip())


def _index_status(row: dict | None) -> str:
    if not row:
        return 'missing'
    if not row.get('is_ready'):
        return 'building'
    if not row.get('is_valid'):
        return 'invalid'
    return 'ready'


async def get_admin_index_status(pool: Any) -> list[dict[str, Any]]:
    names = [item.name for item in ADMIN_INDEX_PLAN]
    async with pool.acquire() as conn:
        rows = await conn.fetch('''
            SELECT c.relname AS index_name,
                   t.relname AS table_name,
                   i.indisready AS is_ready,
                   i.indisvalid AS is_valid,
                   pg_get_indexdef(i.indexrelid) AS index_def
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indexrelid
            JOIN pg_class t ON t.oid = i.indrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname = ANY($1::text[])
        ''', names)
    by_name = {row['index_name']: dict(row) for row in rows}
    result: list[dict[str, Any]] = []
    for item in ADMIN_INDEX_PLAN:
        row = by_name.get(item.name)
        result.append({
            'name': item.name,
            'sql': item.sql,
            'purpose': item.purpose,
            'risk': item.risk,
            'exists': bool(row),
            'ready': bool(row and row.get('is_ready')),
            'valid': bool(row and row.get('is_valid')),
            'status': _index_status(row),
            'table_name': str(row.get('table_name') or '') if row else '',
            'index_def': str(row.get('index_def') or '') if row else '',
        })
    return result


async def create_admin_index(pool: Any, name: str) -> dict[str, Any]:
    definition = get_index_definition(name)
    if definition is None:
        raise ValueError('未知索引计划')
    async with pool.acquire() as conn:
        before = await conn.fetchrow('''
            SELECT c.relname AS index_name,
                   t.relname AS table_name,
                   i.indisready AS is_ready,
                   i.indisvalid AS is_valid,
                   pg_get_indexdef(i.indexrelid) AS index_def
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indexrelid
            JOIN pg_class t ON t.oid = i.indrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname = $1
        ''', definition.name)
        before_status = _index_status(dict(before) if before else None)
        if before_status == 'ready':
            row = dict(before)
            return {
                'name': definition.name,
                'status': before_status,
                'before_status': before_status,
                'exists': True,
                'ready': True,
                'valid': True,
                'table_name': str(row.get('table_name') or ''),
                'index_def': str(row.get('index_def') or ''),
            }
        if before_status != 'missing':
            raise ValueError(f'索引当前状态为 {before_status}，不能通过创建操作修复')
        await conn.execute(definition.sql, timeout=3600)
        after = await conn.fetchrow('''
            SELECT c.relname AS index_name,
                   t.relname AS table_name,
                   i.indisready AS is_ready,
                   i.indisvalid AS is_valid,
                   pg_get_indexdef(i.indexrelid) AS index_def
            FROM pg_index i
            JOIN pg_class c ON c.oid = i.indexrelid
            JOIN pg_class t ON t.oid = i.indrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname = $1
        ''', definition.name)
    row = dict(after) if after else None
    return {
        'name': definition.name,
        'status': _index_status(row),
        'before_status': before_status,
        'exists': bool(row),
        'ready': bool(row and row.get('is_ready')),
        'valid': bool(row and row.get('is_valid')),
        'table_name': str(row.get('table_name') or '') if row else '',
        'index_def': str(row.get('index_def') or '') if row else '',
    }
