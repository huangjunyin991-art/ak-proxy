"""Shared main-account grouping rules for statistics and protection counters."""

from __future__ import annotations

import re


_SUB_ACCOUNT_SUFFIX = re.compile(r"^(?P<base>.+\d)-(?P<index>\d+)$")

# PostgreSQL expression kept in one place so historical SQL aggregations mirror
# the runtime grouping rule without changing stored usernames.
ACCOUNT_GROUP_SQL_TEMPLATE = (
    "CASE WHEN lower(btrim(COALESCE({column}, ''))) ~ '^.+[0-9]-[0-9]+$' "
    "THEN regexp_replace(lower(btrim(COALESCE({column}, ''))), '-[0-9]+$', '') "
    "ELSE lower(btrim(COALESCE({column}, ''))) END"
)


def normalize_account_group_key(value: object) -> str:
    """Return the main-account key for a numeric ``-N`` subaccount suffix."""
    username = str(value or "").strip().lower()
    if not username or username == "unknown":
        return username
    match = _SUB_ACCOUNT_SUFFIX.fullmatch(username)
    return match.group("base") if match and match.group("base") else username


def account_group_sql(column: str) -> str:
    """Build the fixed SQL expression for a username column or qualified field."""
    return ACCOUNT_GROUP_SQL_TEMPLATE.format(column=column)
