from dataclasses import dataclass
from datetime import date
from typing import Any, Optional


POINT_HISTORY_TYPES = frozenset({'EP', 'SP', 'TP', 'RP'})


@dataclass(frozen=True)
class PointStatsQuery:
    username: str | None
    point_type: str | None
    start_date: str | None
    end_date: str | None
    base_filters: list[str]
    base_args: list[Any]
    filters: list[str]
    args: list[Any]
    base_where_clause: str
    where_clause: str


def normalize_point_type(point_type: str | None, required: bool = False) -> str | None:
    code = str(point_type or '').strip().upper()
    if not code:
        if required:
            raise ValueError(f'不支持的点数类型: {point_type}')
        return None
    if code not in POINT_HISTORY_TYPES:
        raise ValueError(f'不支持的点数类型: {point_type}')
    return code


def normalize_point_date(value) -> Optional[str]:
    text = str(value or '').strip()
    candidate = text[:10]
    if len(candidate) != 10 or candidate[4] != '-' or candidate[7] != '-':
        return None
    try:
        return date.fromisoformat(candidate).isoformat()
    except ValueError:
        return None


def normalize_date_range(start_date=None, end_date=None) -> tuple[str | None, str | None]:
    start = normalize_point_date(start_date)
    end = normalize_point_date(end_date)
    if start and end and start > end:
        start, end = end, start
    return start, end


def point_record_date_text_expr() -> str:
    return "COALESCE(record_date::text, NULLIF(substring(record_time FROM '^\\d{4}-\\d{2}-\\d{2}'), ''))"


def append_point_date_filters(filters: list[str], args: list[Any], start: Optional[str], end: Optional[str]) -> None:
    text_date_expr = "NULLIF(substring(record_time FROM '^\\d{4}-\\d{2}-\\d{2}'), '')"
    if start:
        args.extend([date.fromisoformat(start), start])
        date_index = len(args) - 1
        text_index = len(args)
        filters.append(f"(record_date >= ${date_index} OR (record_date IS NULL AND {text_date_expr} >= ${text_index}))")
    if end:
        args.extend([date.fromisoformat(end), end])
        date_index = len(args) - 1
        text_index = len(args)
        filters.append(f"(record_date <= ${date_index} OR (record_date IS NULL AND {text_date_expr} <= ${text_index}))")


def build_point_stats_query(username: str | None = None, point_type: str | None = None,
                            start_date=None, end_date=None,
                            require_username: bool = False,
                            require_point_type: bool = False) -> PointStatsQuery:
    normalized_username = str(username or '').strip().lower() or None
    if require_username and not normalized_username:
        raise ValueError('缺少账号')
    code = normalize_point_type(point_type, required=require_point_type)
    start, end = normalize_date_range(start_date, end_date)
    base_filters = []
    base_args = []
    if normalized_username:
        base_args.append(normalized_username)
        base_filters.append(f'username = ${len(base_args)}')
    if code:
        base_args.append(code)
        base_filters.append(f'point_type = ${len(base_args)}')
    filters = list(base_filters)
    args = list(base_args)
    append_point_date_filters(filters, args, start, end)
    return PointStatsQuery(
        username=normalized_username,
        point_type=code,
        start_date=start,
        end_date=end,
        base_filters=base_filters,
        base_args=base_args,
        filters=filters,
        args=args,
        base_where_clause=f"WHERE {' AND '.join(base_filters)}" if base_filters else '',
        where_clause=f"WHERE {' AND '.join(filters)}" if filters else '',
    )
