from __future__ import annotations

from decimal import Decimal
from datetime import date, datetime
from typing import Any

from .config import normalize_config
from .repository import AkDataRepository
from .worker import AkDataWorker


class AkDataService:
    def __init__(self, repository: AkDataRepository, worker: AkDataWorker | None = None):
        self.repository = repository
        self.worker = worker or AkDataWorker(repository)

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
        payload["backfill"] = self.worker.snapshot()
        return self._json_row(payload)

    async def get_config(self) -> dict[str, Any]:
        config = normalize_config(await self.repository.load_config())
        return {"success": True, "item": config.to_dict()}

    async def save_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        config = normalize_config(payload)
        saved = normalize_config(await self.repository.save_config(config.to_dict()))
        return {"success": True, "item": saved.to_dict(), "message": "AK 数据配置已保存"}

    async def get_storage(self) -> dict[str, Any]:
        payload = await self.repository.get_storage()
        payload["rows"] = [self._json_row(row) for row in payload.get("rows") or []]
        payload["total_bytes"] = sum(int(row.get("total_bytes") or 0) for row in payload["rows"])
        return payload

    async def get_dashboard(self, days: int = 7) -> dict[str, Any]:
        payload = await self.repository.get_dashboard(days)
        payload["rows"] = [self._json_row(row) for row in payload.get("rows") or []]
        return payload

    async def get_market_value(self, days: int = 7) -> dict[str, Any]:
        payload = await self.repository.get_market_value(days)
        payload["rows"] = [self._json_row(row) for row in payload.get("rows") or []]
        return payload

    async def get_recent_trades(self, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        payload = await self.repository.get_recent_trades(limit, offset)
        payload["rows"] = [self._json_row(row) for row in payload.get("rows") or []]
        return payload

    async def query_account_trades(self, query_type: str, account_id: str, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        payload = await self.repository.query_account_trades(query_type, account_id, limit, offset)
        payload["rows"] = [self._json_row(row) for row in payload.get("rows") or []]
        return payload

    async def get_trade_buyers(self, trade_id: int) -> dict[str, Any]:
        payload = await self.repository.get_trade_buyers(trade_id)
        payload["rows"] = [self._json_row(row) for row in payload.get("rows") or []]
        return payload

    async def get_backfill_status(self) -> dict[str, Any]:
        status = await self.repository.get_status()
        item = self._json_row(self.worker.snapshot())
        item["local_min_trade_id"] = int(status.get("local_min_trade_id") or 0)
        item["local_max_trade_id"] = int(status.get("local_max_trade_id") or 0)
        item["order_count"] = int(status.get("order_count") or 0)
        item["first_trade_time"] = self._json_value(status.get("first_trade_time"))
        runtime = status.get("runtime") or {}
        if runtime:
            item["current_account"] = str(runtime.get("current_account_username") or item.get("current_account") or "")
        return {"success": True, "item": item}

    async def start_backfill(self, payload: dict[str, Any]) -> dict[str, Any]:
        state = await self.worker.start_backfill(payload or {})
        return {"success": state.get("status") != "error", "item": self._json_row(state), "message": state.get("message") or ""}

    async def start_probe(self, payload: dict[str, Any]) -> dict[str, Any]:
        state = await self.worker.start_probe(payload or {})
        return {"success": state.get("status") != "error", "item": self._json_row(state), "message": state.get("message") or ""}

    async def pause_backfill(self) -> dict[str, Any]:
        state = await self.worker.pause()
        return {"success": True, "item": self._json_row(state), "message": state.get("message") or ""}

    async def cleanup(self) -> dict[str, Any]:
        return await self.worker.cleanup()
