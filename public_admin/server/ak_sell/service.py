from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import struct
from collections.abc import Mapping
from typing import Any
from urllib.parse import parse_qs, urlparse

from ..upstream_rpc_gate import RpcGateBusy
from .clock import AKSellClock
from .provider import AKSellProvider, AKSellUpstreamError


class AKSellInputError(ValueError):
    pass


class AKSellService:
    """Validates the fixed sell flow without retaining client credentials or jobs."""

    _OPERATIONS = frozenset({
        "login",
        "mnemonic",
        "balance",
        "subaccounts",
        "submit",
        "google-bind",
        "google-unbind",
    })

    def __init__(self, *, provider=None, clock: AKSellClock | None = None) -> None:
        self.provider = provider or AKSellProvider()
        self.clock = clock or AKSellClock()

    def server_time(self) -> dict[str, str | int]:
        return self.clock.snapshot()

    async def invoke(self, operation: str, payload: Mapping[str, Any] | None) -> dict[str, Any]:
        name = str(operation or "").strip().lower()
        if name not in self._OPERATIONS:
            raise AKSellInputError("unsupported sell operation")
        if name == "google-bind":
            return await self._bind_google_auth(payload or {})
        if name == "google-unbind":
            return await self._unbind_google_auth(payload or {})
        request_data, endpoint = self._build_request(name, payload or {})
        try:
            async with self.provider.build_client() as client:
                upstream = await self.provider.post_rpc(client, endpoint, request_data)
        except RpcGateBusy:
            return self._with_server_time({
                "success": False,
                "state": "waiting",
                "operation": name,
                "message": "请求正在排队，请稍后重试",
            })
        except AKSellUpstreamError as exc:
            return self._with_server_time(self._error_response(name, exc))

        success = not bool(upstream.get("Error"))
        return self._with_server_time({
            "success": success,
            "state": "completed" if success else "rejected",
            "operation": name,
            "payload": upstream,
        })

    async def _bind_google_auth(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        auth_data = self._build_auth_request(payload)
        secret_data = dict(auth_data)
        secret_data.update({
            "aCode": self._required_text(payload, "activationCode", aliases=("activation_code",), max_length=512),
            "pin": self._required_text(payload, "tradePassword", aliases=("trade_password",), max_length=512),
        })
        try:
            async with self.provider.build_client() as client:
                secret_reply = await self.provider.post_rpc_reply(
                    client,
                    "Google_Secret",
                    secret_data,
                    follow_redirects=False,
                    allow_non_json=True,
                )
                secret_payload = secret_reply.payload
                if bool(secret_payload.get("Error")):
                    return self._result("google-bind", secret_payload)
                secret = self._google_secret(secret_payload, secret_reply.headers, secret_reply.url)
                if not secret:
                    return self._with_server_time({
                        "success": False,
                        "state": "failed",
                        "operation": "google-bind",
                        "message": "upstream did not return a Google secret",
                    })
                bind_data = dict(auth_data)
                bind_data["gCode"] = self._google_code(secret)
                upstream = await self.provider.post_rpc(client, "Google_Bind", bind_data)
        except RpcGateBusy:
            return self._waiting("google-bind")
        except AKSellUpstreamError as exc:
            return self._with_server_time(self._error_response("google-bind", exc))

        result = self._result("google-bind", upstream)
        if result["success"]:
            result["google_secret"] = secret
        return result

    async def _unbind_google_auth(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        data = self._build_auth_request(payload)
        words = self._mnemonic_words(payload)
        trade_password = self._required_text(payload, "tradePassword", aliases=("trade_password",), max_length=512)
        try:
            async with self.provider.build_client() as client:
                challenge = await self.provider.post_rpc(client, "Mnemonic_Get03", data)
                if bool(challenge.get("Error")):
                    return self._result("google-unbind", challenge)
                indices = [int(challenge.get(f"mnemonicid{position}", 0) or 0) - 1 for position in range(1, 4)]
                if any(index < 0 or index >= len(words) or not words[index] for index in indices):
                    raise AKSellInputError("mnemonicWords does not contain the requested challenge words")
                unbind_data = dict(data)
                unbind_data.update({
                    "pin": trade_password,
                    "mnemonicid1": str(indices[0] + 1),
                    "mnemonicid2": str(indices[1] + 1),
                    "mnemonicid3": str(indices[2] + 1),
                    "mnemonicstr1": words[indices[0]],
                    "mnemonicstr2": words[indices[1]],
                    "mnemonicstr3": words[indices[2]],
                    "mnemonickey": self._required_text(challenge, "mnemonickey", max_length=512),
                })
                upstream = await self.provider.post_rpc(client, "Google_Unbind", unbind_data)
        except RpcGateBusy:
            return self._waiting("google-unbind")
        except AKSellUpstreamError as exc:
            return self._with_server_time(self._error_response("google-unbind", exc))

        if bool(upstream.get("Error")) and self._is_google_unbound(str(upstream.get("Msg") or "")):
            return self._with_server_time({
                "success": True,
                "state": "completed",
                "operation": "google-unbind",
                "payload": upstream,
            })
        return self._result("google-unbind", upstream)

    def _build_request(self, operation: str, payload: Mapping[str, Any]) -> tuple[dict[str, str], str]:
        if operation == "login":
            return self._build_login(payload), "Login"
        if operation == "mnemonic":
            return self._build_auth_request(payload), "Mnemonic_Get01"
        if operation == "balance":
            return self._build_auth_request(payload), "public_IndexData"
        if operation == "subaccounts":
            data = self._build_auth_request(payload)
            data["account"] = self._optional_text(payload, "account", max_length=128)
            data["p"] = self._positive_integer(payload, "p", maximum=1_000_000)
            data["pageSize"] = self._positive_integer(payload, "pageSize", maximum=100)
            return data, "My_Subaccount"
        return self._build_submit(payload)

    @classmethod
    def _build_login(cls, payload: Mapping[str, Any]) -> dict[str, str]:
        return {
            "account": cls._required_text(payload, "account", max_length=128),
            "password": cls._required_text(payload, "password", max_length=512),
            "client": "WEB",
        }

    def _build_auth_request(self, payload: Mapping[str, Any]) -> dict[str, str]:
        return {
            "key": self._required_text(payload, "key", max_length=512),
            "UserID": self._required_text(payload, "UserID", aliases=("userId", "user_id"), max_length=64),
            "v": str(self.server_time()["v"]),
            "lang": self._optional_text(payload, "lang", max_length=16) or "cn",
        }

    def _build_submit(self, payload: Mapping[str, Any]) -> tuple[dict[str, str], str]:
        data = self._build_auth_request(payload)
        son_id = self._optional_text(payload, "sonId", aliases=("son_id",), max_length=64)
        data.update(
            {
                "amount": "",
                "password": "",
                "sonId": son_id,
                "mnemonicid1": self._positive_integer(payload, "mnemonicid1", maximum=128),
                "mnemonickey": self._required_text(payload, "mnemonickey", max_length=512),
                "mnemonicstr1": self._required_text(payload, "mnemonicstr1", max_length=256),
                "gCode": self._required_text(payload, "gCode", aliases=("gcode",), max_length=32),
                "count": self._positive_integer(payload, "count", maximum=1_000_000_000),
            }
        )
        return data, "ACE_Sell_Son" if son_id else "ACE_Sell"

    def _waiting(self, operation: str) -> dict[str, Any]:
        return self._with_server_time({
            "success": False,
            "state": "waiting",
            "operation": operation,
            "message": "request is waiting for the shared upstream RPC lock",
        })

    def _result(self, operation: str, upstream: Mapping[str, Any]) -> dict[str, Any]:
        success = not bool(upstream.get("Error"))
        return self._with_server_time({
            "success": success,
            "state": "completed" if success else "rejected",
            "operation": operation,
            "payload": dict(upstream),
        })

    @classmethod
    def _mnemonic_words(cls, payload: Mapping[str, Any]) -> list[str]:
        raw_words = cls._value(payload, "mnemonicWords", ("mnemonic_words",))
        if not isinstance(raw_words, list) or not raw_words:
            raise AKSellInputError("missing required field: mnemonicWords")
        if len(raw_words) > 64:
            raise AKSellInputError("field too long: mnemonicWords")
        words = [str(word or "").strip() for word in raw_words]
        if any(len(word) > 256 for word in words):
            raise AKSellInputError("field too long: mnemonicWords")
        return words

    @staticmethod
    def _google_secret(payload: Mapping[str, Any], headers: Mapping[str, str], url: str) -> str:
        candidates = [str(payload.get("BindKey") or payload.get("ac") or "")]
        location = next(
            (str(value or "") for key, value in headers.items() if str(key).lower() == "location"),
            "",
        )
        candidates.extend(
            str((parse_qs(urlparse(str(value or "")).query).get("ac") or [""])[0])
            for value in (location, url)
        )
        for candidate in candidates:
            normalized = "".join(candidate.split()).upper().replace("0", "O").replace("1", "I")
            if normalized:
                return normalized
        return ""

    def _google_code(self, secret: str) -> str:
        normalized = "".join(str(secret or "").split()).upper().replace("0", "O").replace("1", "I")
        padding = "=" * (-len(normalized) % 8)
        try:
            key = base64.b32decode(normalized + padding, casefold=True)
        except (binascii.Error, ValueError) as exc:
            raise AKSellInputError("invalid Google secret returned by upstream") from exc
        timestamp = int(int(self.server_time()["epoch_ms"]) / 1000)
        digest = hmac.new(key, struct.pack(">Q", timestamp // 30), hashlib.sha1).digest()
        offset = digest[-1] & 0x0F
        number = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
        return f"{number % 1_000_000:06d}"

    @staticmethod
    def _is_google_unbound(message: str) -> bool:
        normalized = str(message or "").replace(" ", "").lower()
        return any(marker in normalized for marker in ("未绑定", "notbound"))

    def _with_server_time(self, result: dict[str, Any]) -> dict[str, Any]:
        return {**result, "server_time": self.server_time()}

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
