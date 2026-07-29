"""Normalize EP sell-list responses without retaining secrets in logs."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


_LIST_PATHS: tuple[tuple[str, ...], ...] = (
    ("Data", "List"),
    ("data", "list"),
    ("Data", "Rows"),
    ("data", "rows"),
    ("List",),
    ("list",),
)
_SID_KEYS = ("sId", "SId", "sid", "s_id", "eId", "EId", "eid", "id")
_SOKEY_KEYS = ("Sokey", "SoKey", "sokey", "so_key")
_SELLER_KEYS = ("Account", "account", "SellerAccount", "sellerAccount", "seller_account")
_AMOUNT_KEYS = ("EPAmount", "epAmount", "ep_amount", "Amount", "amount")


@dataclass(frozen=True)
class EPListing:
    sid: str
    sokey: str
    seller_account: str
    ep_amount: str


@dataclass(frozen=True)
class ListingPayloadInspection:
    list_path: str
    rows: list[dict[str, Any]]
    row_count: int
    first_row_keys: list[str]
    valid_count: int
    missing_sid_count: int
    missing_sokey_count: int

    def summary(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "top_level_keys": sorted(str(key) for key in payload.keys())[:80],
            "list_path": self.list_path,
            "row_count": self.row_count,
            "first_row_keys": self.first_row_keys,
            "valid_count": self.valid_count,
            "missing_sid_count": self.missing_sid_count,
            "missing_sokey_count": self.missing_sokey_count,
        }


def inspect_listing_payload(payload: Mapping[str, Any] | None) -> ListingPayloadInspection:
    source = dict(payload) if isinstance(payload, Mapping) else {}
    rows, list_path = _find_rows(source)
    first_row_keys = sorted(str(key) for key in rows[0].keys())[:80] if rows else []
    valid_count = 0
    missing_sid_count = 0
    missing_sokey_count = 0
    for row in rows:
        sid = _value(row, _SID_KEYS)
        sokey = _value(row, _SOKEY_KEYS)
        if sid and sokey:
            valid_count += 1
        if not sid:
            missing_sid_count += 1
        if not sokey:
            missing_sokey_count += 1
    return ListingPayloadInspection(
        list_path=list_path,
        rows=rows,
        row_count=len(rows),
        first_row_keys=first_row_keys,
        valid_count=valid_count,
        missing_sid_count=missing_sid_count,
        missing_sokey_count=missing_sokey_count,
    )


def parse_listing(row: Mapping[str, Any]) -> EPListing | None:
    sid = _value(row, _SID_KEYS)
    sokey = _value(row, _SOKEY_KEYS)
    if not sid or not sokey:
        return None
    return EPListing(
        sid=sid,
        sokey=sokey,
        seller_account=_value(row, _SELLER_KEYS),
        ep_amount=_value(row, _AMOUNT_KEYS),
    )


def _find_rows(payload: Mapping[str, Any]) -> tuple[list[dict[str, Any]], str]:
    for path in _LIST_PATHS:
        value: Any = payload
        for key in path:
            if not isinstance(value, Mapping):
                value = None
                break
            value = value.get(key)
        if isinstance(value, list):
            return ([dict(item) for item in value if isinstance(item, Mapping)], ".".join(path))
    return [], ""


def _value(row: Mapping[str, Any], names: tuple[str, ...]) -> str:
    for name in names:
        value = row.get(name)
        if value is not None and str(value).strip():
            return str(value).strip()
    normalized = {str(key).casefold(): value for key, value in row.items()}
    for name in names:
        value = normalized.get(name.casefold())
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""
