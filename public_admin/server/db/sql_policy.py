import re
from dataclasses import dataclass


READONLY_SQL_TOKENS = {'select', 'show', 'describe'}
BLOCKED_SQL_KEYWORDS = {'copy', 'vacuum', 'reindex', 'cluster'}
BLOCKED_SQL_FUNCTIONS = {
    'dblink',
    'dblink_connect',
    'dblink_exec',
    'lo_export',
    'lo_import',
    'pg_execute_server_program',
    'pg_ls_dir',
    'pg_read_binary_file',
    'pg_read_file',
    'pg_reload_conf',
    'pg_sleep',
    'pg_stat_file',
    'set_config',
}
SYSTEM_SCHEMA_RE = re.compile(
    r'\b(?:pg_catalog|information_schema)\s*\.|\b(?:from|join)\s+(?:pg_[a-z0-9_]*|information_schema)\b',
    re.IGNORECASE,
)
FUNCTION_CALL_RE = re.compile(r'\b([a-z_][a-z0-9_]*)\s*\(', re.IGNORECASE)


@dataclass(frozen=True)
class SqlPolicy:
    sql: str
    first_token: str
    is_readonly: bool
    has_multiple_statements: bool = False
    explain_analyze: bool = False
    blocked: bool = False
    block_code: str = ''
    block_message: str = ''


def classify_admin_sql(sql: str) -> SqlPolicy:
    normalized = str(sql or '').strip()
    first_token = first_sql_token(normalized)
    has_multiple = has_multiple_statements(normalized)
    explain_analyze = first_token == 'explain' and _explain_uses_analyze(normalized)
    block_code, block_message = sql_block_reason(normalized, first_token)
    is_readonly = (
        not has_multiple
        and not block_code
        and (
            first_token in READONLY_SQL_TOKENS
            or (first_token == 'explain' and not explain_analyze)
        )
    )
    return SqlPolicy(
        sql=normalized,
        first_token=first_token,
        is_readonly=is_readonly,
        has_multiple_statements=has_multiple,
        explain_analyze=explain_analyze,
        blocked=bool(block_code),
        block_code=block_code,
        block_message=block_message,
    )


def first_sql_token(sql: str) -> str:
    text = strip_leading_sql_comments(sql)
    return text.split(None, 1)[0].strip('(').lower() if text else ''


def strip_leading_sql_comments(sql: str) -> str:
    text = str(sql or '').lstrip()
    while text.startswith('--') or text.startswith('/*'):
        if text.startswith('--'):
            _, _, text = text.partition('\n')
            text = text.lstrip()
            continue
        end_index = text.find('*/')
        if end_index < 0:
            return ''
        text = text[end_index + 2:].lstrip()
    return text


def has_multiple_statements(sql: str) -> bool:
    parts = _split_sql_statements(sql)
    return len([part for part in parts if part.strip()]) > 1


def _split_sql_statements(sql: str) -> list[str]:
    text = str(sql or '')
    statements: list[str] = []
    start = 0
    quote = ''
    dollar_quote = ''
    in_line_comment = False
    in_block_comment = False
    i = 0
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ''
        if in_line_comment:
            if ch == '\n':
                in_line_comment = False
            i += 1
            continue
        if in_block_comment:
            if ch == '*' and nxt == '/':
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue
        if dollar_quote:
            if text.startswith(dollar_quote, i):
                i += len(dollar_quote)
                dollar_quote = ''
                continue
            i += 1
            continue
        if quote:
            if ch == quote:
                if quote == "'" and nxt == "'":
                    i += 2
                    continue
                quote = ''
            i += 1
            continue
        if ch == '-' and nxt == '-':
            in_line_comment = True
            i += 2
            continue
        if ch == '/' and nxt == '*':
            in_block_comment = True
            i += 2
            continue
        if ch in {"'", '"'}:
            quote = ch
            i += 1
            continue
        if ch == '$':
            tag_end = text.find('$', i + 1)
            if tag_end > i:
                tag = text[i:tag_end + 1]
                if tag == '$$' or tag[1:-1].replace('_', 'a').isalnum():
                    dollar_quote = tag
                    i += len(tag)
                    continue
        if ch == ';':
            statements.append(text[start:i])
            start = i + 1
        i += 1
    statements.append(text[start:])
    return statements


def _explain_uses_analyze(sql: str) -> bool:
    text = strip_leading_sql_comments(sql).lower()
    if not text.startswith('explain'):
        return False
    head = strip_leading_sql_comments(text[len('explain'):])
    if head.startswith('analyze') or head.startswith('analyse'):
        return True
    if head.startswith('('):
        end_index = head.find(')')
        options = head[1:end_index if end_index >= 0 else None]
        return 'analyze' in options or 'analyse' in options
    return False


def sql_block_reason(sql: str, first_token: str = '') -> tuple[str, str]:
    normalized = str(sql or '').strip()
    if not normalized:
        return '', ''
    first = first_token or first_sql_token(normalized)
    if first in BLOCKED_SQL_KEYWORDS:
        return 'blocked_sql_keyword', f'自定义 SQL 不允许执行 {first.upper()}'
    masked = normalize_sql_for_policy_scan(normalized)
    if SYSTEM_SCHEMA_RE.search(masked):
        return 'system_schema_blocked', '自定义 SQL 不允许直接访问系统 schema 或 PostgreSQL catalog'
    for match in FUNCTION_CALL_RE.finditer(masked):
        function_name = match.group(1).lower()
        if function_name in BLOCKED_SQL_FUNCTIONS:
            return 'blocked_sql_function', f'自定义 SQL 不允许调用危险函数 {function_name}'
    return '', ''


def normalize_sql_for_policy_scan(sql: str) -> str:
    masked = mask_sql_literals_and_comments(sql).lower()
    return re.sub(r'"([a-z_][a-z0-9_]*)"', r'\1', masked, flags=re.IGNORECASE)


def mask_sql_literals_and_comments(sql: str) -> str:
    text = str(sql or '')
    result: list[str] = []
    quote = ''
    dollar_quote = ''
    in_line_comment = False
    in_block_comment = False
    i = 0
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ''
        if in_line_comment:
            if ch == '\n':
                in_line_comment = False
                result.append(ch)
            else:
                result.append(' ')
            i += 1
            continue
        if in_block_comment:
            if ch == '*' and nxt == '/':
                result.extend('  ')
                in_block_comment = False
                i += 2
                continue
            result.append(' ')
            i += 1
            continue
        if dollar_quote:
            if text.startswith(dollar_quote, i):
                result.extend(' ' * len(dollar_quote))
                i += len(dollar_quote)
                dollar_quote = ''
                continue
            result.append(' ')
            i += 1
            continue
        if quote:
            if ch == quote:
                if quote == "'" and nxt == "'":
                    result.extend('  ')
                    i += 2
                    continue
                quote = ''
            result.append(' ')
            i += 1
            continue
        if ch == '-' and nxt == '-':
            result.extend('  ')
            in_line_comment = True
            i += 2
            continue
        if ch == '/' and nxt == '*':
            result.extend('  ')
            in_block_comment = True
            i += 2
            continue
        if ch == "'":
            quote = ch
            result.append(' ')
            i += 1
            continue
        if ch == '$':
            tag_end = text.find('$', i + 1)
            if tag_end > i:
                tag = text[i:tag_end + 1]
                if tag == '$$' or tag[1:-1].replace('_', 'a').isalnum():
                    dollar_quote = tag
                    result.extend(' ' * len(tag))
                    i += len(tag)
                    continue
        result.append(ch)
        i += 1
    return ''.join(result)
