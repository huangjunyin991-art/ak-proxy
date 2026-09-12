"""Account grouping rules used by login-abuse protection only."""

from __future__ import annotations

import re


_SUB_ACCOUNT_SUFFIX = re.compile(r"^(?P<base>.+\d)-(?P<index>\d+)$")


def normalize_account_group_key(value: object) -> str:
    """Return the main-account key for distinct-account protection counters.

    The upstream naming convention uses a numeric ``-N`` suffix for subaccounts.
    Only that exact suffix is removed; ordinary hyphenated usernames remain intact.
    This key must never be used as an authentication or database username.
    """
    username = str(value or "").strip().lower()
    if not username or username == "unknown":
        return username
    match = _SUB_ACCOUNT_SUFFIX.fullmatch(username)
    if match and match.group("base"):
        return match.group("base")
    return username
