from __future__ import annotations

from decimal import Decimal
from datetime import date, datetime
from typing import Any

from .repository import AkDataRepository


class AkDataService:
    def __init__(self, repository: AkDataRepository):
        self.repository = repository

    def _json_value(self, value: Any) -> Any:
        if isinstance(value, Decimal):
            return float(value)
        if isinstance(value, (datetime, date)):
            return value.isoformat(sep=" ") if isinstance(value, datetime) else value.isoformat()
        return value

    def _json_row(self, row: dict[str, Any]) -> dict[str, Any]:
        return {key: self._json_value(value) for key, value in dict(row or {}).items()}

    async def get_status(self) -> dict[str, Any]:
        payload = await self.repository.get_status()
        payload["runtime"] = self._json_row(payload.get("runtime") or {})
        return self._json_row(payload)

    async def get_storage(self) -> dict[str, Any]:
        payload = await self.repository.get_storage()
        payload["rows"] = [self._json_row(row) for row in payload.get("rows") or []]
        payload["total_bytes"] = sum(int(row.get("total_bytes") or 0) for row in payload["rows"])
        return payload

    async def get_dashboard(self, days: int = 7) -> dict[str, Any]:
        payload = await self.repository.get_dashboard(days)
        payload["rows"] = [self._json_row(row) for row in payload.get("rows") or []]
        return payload

    async def get_recent_trades(self, limit: int = 50) -> dict[str, Any]:
        payload = await self.repository.get_recent_trades(limit)
        payload["rows"] = [self._json_row(row) for row in payload.get("rows") or []]
        return payload

    async def query_account_trades(self, query_type: str, account_id: str, limit: int = 500) -> dict[str, Any]:
        payload = await self.repository.query_account_trades(query_type, account_id, limit)
        payload["rows"] = [self._json_row(row) for row in payload.get("rows") or []]
        return payload

    async def get_trade_buyers(self, trade_id: int) -> dict[str, Any]:
        payload = await self.repository.get_trade_buyers(trade_id)
        payload["rows"] = [self._json_row(row) for row in payload.get("rows") or []]
        return payload
