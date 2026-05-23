from typing import Any, Callable, Dict, Iterable, List, Tuple


CategoryResolver = Callable[[str, str, str], str]
DescriptionFormatter = Callable[[str, str], str]


def normalize_point_detail_page(page: int = 1, page_size: int = 50) -> Tuple[int, int]:
    current = int(page or 1)
    size = int(page_size or 50)
    if current < 1:
        current = 1
    if size < 1:
        size = 50
    return current, min(size, 200)


def build_point_record_item(row: Dict[str, Any], point_type: str, resolve_category: CategoryResolver, format_description: DescriptionFormatter) -> Tuple[str, Dict[str, Any], int, float]:
    item = dict(row)
    raw_type = str(item.get('type_name') or '').strip()
    description = str(item.get('description') or '').strip()
    op = int(item.get('operation_type') or 0)
    amount_value = float(item.get('amount') or 0)
    category = resolve_category(point_type or '', raw_type, description)
    item['time'] = item.get('record_time') or item.get('saved_at')
    item['direction'] = '收入' if op == 1 else '支出'
    item['category'] = category
    item['type_name_cn'] = item.get('type_name_cn') or category
    item['description_display'] = format_description(category, description)
    return category, item, op, abs(amount_value)


def build_point_categories(rows: Iterable[Dict[str, Any]], point_type: str, resolve_category: CategoryResolver, format_description: DescriptionFormatter, include_records: bool = False) -> List[Dict[str, Any]]:
    category_agg: Dict[str, Dict[str, Any]] = {}
    detail_by_category: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        category, item, op, abs_amount = build_point_record_item(dict(row), point_type, resolve_category, format_description)
        agg = category_agg.setdefault(category, {
            'name': category,
            'count': 0,
            'income': 0.0,
            'expense': 0.0,
            'net': 0.0,
        })
        agg['count'] += 1
        if op == 1:
            agg['income'] += abs_amount
            agg['net'] += abs_amount
        else:
            agg['expense'] += abs_amount
            agg['net'] -= abs_amount
        if include_records:
            detail_by_category.setdefault(category, []).append(item)
    categories = []
    for name, agg in sorted(category_agg.items(), key=lambda kv: kv[1]['count'], reverse=True):
        category = {
            'name': name,
            'count': agg['count'],
            'income': round(agg['income'], 2),
            'expense': round(agg['expense'], 2),
            'net': round(agg['net'], 2),
            'detail_paged': not include_records,
        }
        if include_records:
            category['records'] = detail_by_category.get(name, [])
        else:
            category['records'] = []
        categories.append(category)
    return categories


def paginate_point_category_records(rows: Iterable[Dict[str, Any]], point_type: str, category_name: str, page: int, page_size: int, resolve_category: CategoryResolver, format_description: DescriptionFormatter) -> Dict[str, Any]:
    current, size = normalize_point_detail_page(page, page_size)
    target = str(category_name or '').strip() or '未分类'
    matched_records = []
    for row in rows:
        category, item, _, _ = build_point_record_item(dict(row), point_type, resolve_category, format_description)
        if category != target:
            continue
        matched_records.append(item)
    total = len(matched_records)
    total_pages = max(1, (total + size - 1) // size)
    if current > total_pages:
        current = total_pages
    start = (current - 1) * size
    records = matched_records[start:start + size]
    return {
        'category': target,
        'page': current,
        'page_size': size,
        'total': total,
        'total_pages': total_pages,
        'records': records,
    }
