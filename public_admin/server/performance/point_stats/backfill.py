import asyncio
import time
from datetime import date
from typing import Any, Callable, Dict, Optional

from .query_filters import normalize_point_date


DEFAULT_BACKFILL_BATCH_SIZE = 1000
MAX_BACKFILL_BATCH_SIZE = 5000
POINT_STATS_BACKFILL_POLL_SECONDS = 0.02

CategoryResolver = Callable[[str, str, str], str]

_BACKFILL_TASK: Optional[asyncio.Task] = None
_BACKFILL_STATE: Dict[str, Any] = {
    'status': 'idle',
    'message': '旧数据结构化状态未检查',
    'started_at': None,
    'finished_at': None,
    'batch_size': DEFAULT_BACKFILL_BATCH_SIZE,
    'max_batches': 0,
    'batches': 0,
    'processed': 0,
    'updated': 0,
    'last_id': 0,
    'stop_reason': '',
    'error': '',
}
_STRUCTURED_READY: Dict[str, Any] = {
    'record_date_complete': False,
    'resolved_category_complete': False,
    'checked_at': 0,
}


def is_record_date_backfill_complete() -> bool:
    return bool(_STRUCTURED_READY.get('record_date_complete'))


async def get_point_stats_backfill_status(pool, include_counts: bool = False) -> Dict[str, Any]:
    if include_counts:
        async with pool.acquire() as conn:
            counts = await _fetch_backfill_counts(conn)
        _apply_counts_to_ready_state(counts)
        _BACKFILL_STATE.update(counts)
        if _BACKFILL_STATE.get('status') != 'running':
            _BACKFILL_STATE['message'] = _message_for_counts(counts)
    return _snapshot_state()


async def start_point_stats_backfill(
    pool,
    resolve_category: CategoryResolver,
    batch_size: int = DEFAULT_BACKFILL_BATCH_SIZE,
    max_batches: int = 0,
) -> Dict[str, Any]:
    global _BACKFILL_TASK
    if _BACKFILL_TASK and not _BACKFILL_TASK.done():
        return _snapshot_state()

    safe_batch_size = _normalize_batch_size(batch_size)
    safe_max_batches = _normalize_max_batches(max_batches)
    _BACKFILL_STATE.clear()
    _BACKFILL_STATE.update({
        'status': 'running',
        'message': '旧点数记录结构化补齐已启动',
        'started_at': time.time(),
        'finished_at': None,
        'batch_size': safe_batch_size,
        'max_batches': safe_max_batches,
        'batches': 0,
        'processed': 0,
        'updated': 0,
        'last_id': 0,
        'stop_reason': '',
        'error': '',
    })
    _BACKFILL_TASK = asyncio.create_task(_run_backfill(pool, resolve_category, safe_batch_size, safe_max_batches))
    return _snapshot_state()


async def _run_backfill(pool, resolve_category: CategoryResolver, batch_size: int, max_batches: int) -> None:
    try:
        async with pool.acquire() as conn:
            initial_counts = await _fetch_backfill_counts(conn)
        _apply_counts_to_ready_state(initial_counts)
        _BACKFILL_STATE.update(initial_counts)
        if int(initial_counts.get('pending_total') or 0) <= 0:
            _BACKFILL_STATE.update({
                'status': 'finished',
                'finished_at': time.time(),
                'stop_reason': 'already_complete',
                'message': '旧点数记录结构化字段已完整',
            })
            return

        last_id = 0
        while True:
            if max_batches and int(_BACKFILL_STATE.get('batches') or 0) >= max_batches:
                _BACKFILL_STATE['stop_reason'] = 'max_batches'
                break
            async with pool.acquire() as conn:
                rows = await _fetch_backfill_batch(conn, last_id, batch_size)
                if not rows:
                    _BACKFILL_STATE['stop_reason'] = 'scan_complete'
                    break
                updates = []
                for row in rows:
                    item = dict(row)
                    last_id = max(last_id, int(item.get('id') or 0))
                    params = _build_update_params(item, resolve_category)
                    if params is not None:
                        updates.append(params)
                if updates:
                    async with conn.transaction():
                        await conn.executemany('''
                            UPDATE point_history_records
                            SET record_date = CASE WHEN record_date IS NULL THEN $2 ELSE record_date END,
                                resolved_category = CASE
                                    WHEN COALESCE(resolved_category, '') = '' THEN $3
                                    ELSE resolved_category
                                END
                            WHERE id = $1
                        ''', updates)
            _BACKFILL_STATE['batches'] = int(_BACKFILL_STATE.get('batches') or 0) + 1
            _BACKFILL_STATE['processed'] = int(_BACKFILL_STATE.get('processed') or 0) + len(rows)
            _BACKFILL_STATE['updated'] = int(_BACKFILL_STATE.get('updated') or 0) + len(updates)
            _BACKFILL_STATE['last_id'] = last_id
            _BACKFILL_STATE['message'] = (
                f"旧点数记录补齐中：已扫描 {_BACKFILL_STATE['processed']} 条，"
                f"更新 {_BACKFILL_STATE['updated']} 条"
            )
            await asyncio.sleep(POINT_STATS_BACKFILL_POLL_SECONDS)

        async with pool.acquire() as conn:
            final_counts = await _fetch_backfill_counts(conn)
        _apply_counts_to_ready_state(final_counts)
        _BACKFILL_STATE.update(final_counts)
        _BACKFILL_STATE.update({
            'status': 'finished',
            'finished_at': time.time(),
            'message': _message_for_counts(final_counts),
            'error': '',
        })
    except Exception as exc:
        _BACKFILL_STATE.update({
            'status': 'error',
            'finished_at': time.time(),
            'error': str(exc),
            'message': f'旧点数记录补齐失败：{exc}',
        })


async def _fetch_backfill_counts(conn) -> Dict[str, int]:
    row = await conn.fetchrow('''
        SELECT COUNT(*) AS total_records,
               COUNT(*) FILTER (WHERE record_date IS NULL) AS pending_record_date,
               COUNT(*) FILTER (WHERE COALESCE(resolved_category, '') = '') AS pending_category,
               COUNT(*) FILTER (
                   WHERE record_date IS NULL OR COALESCE(resolved_category, '') = ''
               ) AS pending_total
        FROM point_history_records
    ''')
    if not row:
        return {
            'total_records': 0,
            'pending_record_date': 0,
            'pending_category': 0,
            'pending_total': 0,
        }
    return {
        'total_records': int(row['total_records'] or 0),
        'pending_record_date': int(row['pending_record_date'] or 0),
        'pending_category': int(row['pending_category'] or 0),
        'pending_total': int(row['pending_total'] or 0),
    }


async def _fetch_backfill_batch(conn, last_id: int, batch_size: int):
    return await conn.fetch('''
        SELECT id, point_type, record_time, record_date, resolved_category, type_name, description
        FROM point_history_records
        WHERE id > $1
          AND (record_date IS NULL OR COALESCE(resolved_category, '') = '')
        ORDER BY id ASC
        LIMIT $2
    ''', int(last_id or 0), int(batch_size or DEFAULT_BACKFILL_BATCH_SIZE))


def _build_update_params(row: Dict[str, Any], resolve_category: CategoryResolver):
    record_id = int(row.get('id') or 0)
    if record_id <= 0:
        return None
    current_date = row.get('record_date')
    next_date = current_date
    if current_date is None:
        normalized = normalize_point_date(row.get('record_time'))
        next_date = date.fromisoformat(normalized) if normalized else None

    current_category = str(row.get('resolved_category') or '').strip()
    next_category = current_category
    if not current_category:
        next_category = _resolve_category(row, resolve_category)

    date_will_change = current_date is None and next_date is not None
    category_will_change = not current_category and bool(next_category)
    if not date_will_change and not category_will_change:
        return None
    return record_id, next_date, next_category


def _resolve_category(row: Dict[str, Any], resolve_category: CategoryResolver) -> str:
    try:
        value = resolve_category(
            str(row.get('point_type') or ''),
            str(row.get('type_name') or ''),
            str(row.get('description') or ''),
        )
    except Exception:
        value = ''
    return str(value or '未分类').strip() or '未分类'


def _normalize_batch_size(value: int) -> int:
    try:
        size = int(value or DEFAULT_BACKFILL_BATCH_SIZE)
    except (TypeError, ValueError):
        size = DEFAULT_BACKFILL_BATCH_SIZE
    return max(50, min(size, MAX_BACKFILL_BATCH_SIZE))


def _normalize_max_batches(value: int) -> int:
    try:
        batches = int(value or 0)
    except (TypeError, ValueError):
        batches = 0
    return max(0, min(batches, 100000))


def _apply_counts_to_ready_state(counts: Dict[str, int]) -> None:
    _STRUCTURED_READY.update({
        'record_date_complete': int(counts.get('pending_record_date') or 0) == 0,
        'resolved_category_complete': int(counts.get('pending_category') or 0) == 0,
        'checked_at': time.time(),
    })


def _message_for_counts(counts: Dict[str, int]) -> str:
    pending_total = int(counts.get('pending_total') or 0)
    if pending_total <= 0:
        return '旧点数记录结构化字段已完整'
    pending_date = int(counts.get('pending_record_date') or 0)
    pending_category = int(counts.get('pending_category') or 0)
    return f'仍有 {pending_total} 条待补齐：日期 {pending_date} 条，分类 {pending_category} 条'


def _snapshot_state() -> Dict[str, Any]:
    state = dict(_BACKFILL_STATE)
    state['structured_ready'] = dict(_STRUCTURED_READY)
    return state
