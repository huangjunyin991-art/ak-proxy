from __future__ import annotations

import uuid
from collections.abc import Mapping
from datetime import datetime
from typing import Any

from .parser import build_record
from .repository import AKSellLedgerRepository, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS


class AKSellLedgerService:
    def __init__(self, repository: AKSellLedgerRepository, logger=None) -> None:
        self.repository = repository
        self.logger = logger

    async def record_success(
        self,
        *,
        account: str,
        endpoint: str,
        request_data: Mapping[str, Any],
        payload: Mapping[str, Any],
        source: str,
        request_id: str = "",
        confirmation_method: str = "upstream_response",
        event_id: str = "",
    ) -> bool:
        record = build_record(
            account=account,
            endpoint=endpoint,
            request_data=request_data,
            payload=payload,
            source=source,
            request_id=request_id,
            confirmation_method=confirmation_method,
        )
        if record is None:
            return False
        record["event_id"] = event_id.strip() or request_id.strip() or f"ak-sell:{uuid.uuid4().hex}"
        try:
            return await self.repository.record(record)
        except Exception as exc:
            if self.logger:
                self.logger.warning("[AKSellLedger] record failed: %s", str(exc)[:300])
            return False

    async def dashboard(self, account: str = "", source: str = "", page: int = 1, page_size: int = 50) -> dict[str, Any]:
        return {"success": True, **await self.repository.dashboard(account=account, source=source, page=page, page_size=page_size)}

    async def config(self) -> dict[str, Any]:
        return {"success": True, "config": await self.repository.get_config()}

    async def save_config(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        days = int(payload.get("retention_days") or 0)
        if days < MIN_RETENTION_DAYS or days > MAX_RETENTION_DAYS:
            raise ValueError(f"retention_days must be between {MIN_RETENTION_DAYS} and {MAX_RETENTION_DAYS}")
        return {"success": True, "config": await self.repository.save_config(days)}

    async def cleanup(self) -> dict[str, Any]:
        result = await self.repository.cleanup()
        result["success"] = True
        if isinstance(result.get("cutoff"), datetime):
            result["cutoff"] = result["cutoff"].isoformat(sep=" ", timespec="seconds")
        return result
