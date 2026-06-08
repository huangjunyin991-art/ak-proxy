from dataclasses import dataclass


READONLY_SQL_TOKENS = {'select', 'show', 'describe'}


@dataclass(frozen=True)
class SqlPolicy:
    sql: str
    first_token: str
    is_readonly: bool
    has_multiple_statements: bool = False
    explain_analyze: bool = False


def classify_admin_sql(sql: str) -> SqlPolicy:
    normalized = str(sql or '').strip()
    first_token = first_sql_token(normalized)
    has_multiple = has_multiple_statements(normalized)
    explain_analyze = first_token == 'explain' and _explain_uses_analyze(normalized)
    is_readonly = (
        not has_multiple
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
