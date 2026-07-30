from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..upstream_rpc_gate import RpcGateBusy
from .provider import AKSellProvider, AKSellUpstreamError


class AKSellInputError(ValueError):
    pass


class AKSellService:
    """Validates the fixed sell flow without retaining client credentials or jobs."""

    _OPERATIONS = frozenset({"login", "mnemonic", "balance", "subaccounts", "submit"})

    def __init__(self, *, provider=None) -> None:
        self.provider = provider or AKSellProvider()

    async def invoke(self, operation: str, payload: Mapping[str, Any] | None) -> dict[str, Any]:
        name = str(operation or "").strip().lower()
        if name not in self._OPERATIONS:
            raise AKSellInputError("unsupported sell operation")
        request_data, endpoint = self._build_request(name, payload or {})
        try:
            async with self.provider.build_client() as client:
                upstream = await self.provider.post_rpc(client, endpoint, request_data)
        except RpcGateBusy:
            return {
                "success": False,
                "state": "waiting",
                "operation": name,
                "message": "请求正在排队，请稍后重试",
            }
        except AKSellUpstreamError as exc:
            return self._error_response(name, exc)

        success = not bool(upstream.get("Error"))
        return {
            "success": success,
            "state": "completed" if success else "rejected",
            "operation": name,
            "payload": upstream,
        }

    @classmethod
    def _build_request(cls, operation: str, payload: Mapping[str, Any]) -> tuple[dict[str, str], str]:
        if operation == "login":
            return cls._build_login(payload), "Login"
        if operation == "mnemonic":
            return cls._build_auth_request(payload), "Mnemonic_Get01"
        if operation == "balance":
            return cls._build_auth_request(payload), "public_IndexData"
        if operation == "subaccounts":
            data = cls._build_auth_request(payload)
            data["account"] = cls._optional_text(payload, "account", max_length=128)
            data["p"] = cls._positive_integer(payload, "p", maximum=1_000_000)
            data["pageSize"] = cls._positive_integer(payload, "pageSize", maximum=100)
            return data, "My_Subaccount"
        return cls._build_submit(payload)

    @classmethod
    def _build_login(cls, payload: Mapping[str, Any]) -> dict[str, str]:
        return {
            "account": cls._required_text(payload, "account", max_length=128),
            "password": cls._required_text(payload, "password", max_length=512),
            "client": "WEB",
        }

    @classmethod
    def _build_auth_request(cls, payload: Mapping[str, Any]) -> dict[str, str]:
        return {
            "key": cls._required_text(payload, "key", max_length=512),
            "UserID": cls._required_text(payload, "UserID", aliases=("userId", "user_id"), max_length=64),
            "v": cls._required_text(payload, "v", max_length=32),
            "lang": cls._optional_text(payload, "lang", max_length=16) or "cn",
        }

    @classmethod
    def _build_submit(cls, payload: Mapping[str, Any]) -> tuple[dict[str, str], str]:
        data = cls._build_auth_request(payload)
        son_id = cls._optional_text(payload, "sonId", aliases=("son_id",), max_length=64)
        data.update(
            {
                "amount": "",
                "password": "",
                "sonId": son_id,
                "mnemonicid1": cls._positive_integer(payload, "mnemonicid1", maximum=128),
                "mnemonickey": cls._required_text(payload, "mnemonickey", max_length=512),
                "mnemonicstr1": cls._required_text(payload, "mnemonicstr1", max_length=256),
                "gCode": cls._required_text(payload, "gCode", aliases=("gcode",), max_length=32),
                "count": cls._positive_integer(payload, "count", maximum=1_000_000_000),
            }
        )
        return data, "ACE_Sell_Son" if son_id else "ACE_Sell"

    @classmethod
    def _required_text(
        cls,
        payload: Mapping[str, Any],
        field: str,
        *,
        aliases: tuple[str, ...] = (),
        max_length: int,
    ) -> str:
        value = cls._value(payload, field, aliases)
        text = str(value or "").strip()
        if not text:
            raise AKSellInputError(f"missing required field: {field}")
        if len(text) > max_length:
            raise AKSellInputError(f"field too long: {field}")
        return text

    @classmethod
    def _optional_text(
        cls,
        payload: Mapping[str, Any],
        field: str,
        *,
        aliases: tuple[str, ...] = (),
        max_length: int,
    ) -> str:
        value = cls._value(payload, field, aliases)
        text = str(value or "").strip()
        if len(text) > max_length:
            raise AKSellInputError(f"field too long: {field}")
        return text

    @classmethod
    def _positive_integer(cls, payload: Mapping[str, Any], field: str, *, maximum: int) -> str:
        text = cls._required_text(payload, field, max_length=32)
        try:
            value = int(text)
        except (TypeError, ValueError) as exc:
            raise AKSellInputError(f"field must be a positive integer: {field}") from exc
        if value < 1 or value > maximum:
            raise AKSellInputError(f"field is out of range: {field}")
        return str(value)

    @staticmethod
    def _value(payload: Mapping[str, Any], field: str, aliases: tuple[str, ...] = ()) -> Any:
        for candidate in (field, *aliases):
            if candidate in payload:
                return payload[candidate]
        return ""

    @staticmethod
    def _error_response(operation: str, exc: AKSellUpstreamError) -> dict[str, Any]:
        if operation == "submit" and exc.is_read_timeout:
            return {
                "success": False,
                "state": "unknown",
                "operation": operation,
                "message": "提交读取超时，结果未知，请勿自动重发",
            }
        if exc.is_read_timeout:
            message = "上游读取超时，可稍后重试"
        elif exc.is_rate_limited:
            message = "上游请求过于频繁，请稍后重试"
        else:
            message = "上游请求失败"
        return {
            "success": False,
            "state": "failed",
            "operation": operation,
            "message": message,
            "status_code": exc.status_code,
        }
