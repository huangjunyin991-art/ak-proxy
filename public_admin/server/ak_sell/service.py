from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import logging
import uuid
import struct
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlparse

from ..upstream_rpc_gate import RpcGateBusy
from .account_state import CachedAKAccountAuth
from .clock import AKSellClock
from .internal_rpc import create_internal_rpc_token, is_trusted_internal_rpc_request
from .provider import AKSellProvider, AKSellUpstreamError
from . import trace as ak_sell_trace


class AKSellInputError(ValueError):
    pass


class AKSellCachedLoginRejected(RuntimeError):
    def __init__(self, payload: Mapping[str, Any]) -> None:
        super().__init__("cached account login was rejected")
        self.payload = dict(payload)


@dataclass(frozen=True)
class ResolvedAKAuth:
    userkey: str
    user_id: str
    account: str = ""
    from_cache: bool = False


class AKSellService:
    """Validates the fixed sell flow and records confirmed sell summaries."""

    _OPERATIONS = frozenset({
        "login",
        "mnemonic",
        "balance",
        "subaccounts",
        "submit",
        "google-bind",
        "google-unbind",
    })

    def __init__(
        self,
        *,
        provider=None,
        clock: AKSellClock | None = None,
        account_state=None,
        ledger_recorder=None,
        confirmation_recorder=None,
        logger=None,
    ) -> None:
        self._internal_rpc_token = create_internal_rpc_token()
        self.logger = logger or logging.getLogger("TransparentProxy")
        self.provider = provider or AKSellProvider(internal_token=self._internal_rpc_token, logger=self.logger)
        self.clock = clock or AKSellClock()
        self.account_state = account_state
        self.ledger_recorder = ledger_recorder
        self.confirmation_recorder = confirmation_recorder
        self._refresh_locks: dict[str, asyncio.Lock] = {}

    def is_internal_rpc_request(self, request) -> bool:
        client = getattr(request, "client", None)
        return is_trusted_internal_rpc_request(
            request.headers,
            str(getattr(client, "host", "") or ""),
            self._internal_rpc_token,
        )

    def server_time(self) -> dict[str, str | int]:
        return self.clock.snapshot()

    async def submit_status(self, request_id: str) -> dict[str, Any]:
        normalized = str(request_id or "").strip()
        if not normalized or len(normalized) > 128:
            raise AKSellInputError("missing or invalid request_id")
        lookup = getattr(self.ledger_recorder, "submit_status", None)
        if not callable(lookup):
            return self._with_server_time({
                "success": False,
                "state": "unavailable",
                "message": "挂卖结果确认服务暂不可用",
            })
        try:
            status = await lookup(normalized)
        except Exception as exc:
            self.logger.warning("[AKSellLedger] submit status lookup failed: %s", str(exc)[:300])
            return self._with_server_time({
                "success": False,
                "state": "unavailable",
                "message": "挂卖结果确认服务暂不可用",
            })
        state = str(status.get("state") or "unknown")
        return self._with_server_time({
            "success": state == "success",
            "state": state,
            "message": str(status.get("message") or ""),
            "confirmation_method": str(status.get("confirmation_method") or ""),
            "found": bool(status.get("found")),
            "updated_at": str(status.get("updated_at") or ""),
        })

    async def invoke(self, operation: str, payload: Mapping[str, Any] | None) -> dict[str, Any]:
        name = str(operation or "").strip().lower()
        if name not in self._OPERATIONS:
            raise AKSellInputError("unsupported sell operation")
        payload = payload or {}
        trace_id = ak_sell_trace.create_trace_id_if_needed()
        self._trace_received(name, payload, trace_id)
        if name == "login":
            return await self._invoke_login(payload, trace_id=trace_id)
        if name == "google-bind":
            return await self._bind_google_auth(payload, trace_id=trace_id)
        if name == "google-unbind":
            return await self._unbind_google_auth(payload, trace_id=trace_id)

        auth: ResolvedAKAuth | None = None
        request_data: dict[str, str] | None = None
        endpoint = ""
        submit_dispatched = False
        submit_event_id = self._attempt_event_id(payload, trace_id) if name == "submit" else ""
        if name == "submit" and not submit_event_id:
            submit_event_id = f"ak-sell-attempt:{uuid.uuid4().hex}"
        try:
            async with self._build_provider_client(name, trace_id) as client:
                auth = await self._resolve_auth(client, payload, trace_id=trace_id)
                request_data, endpoint = self._build_request(name, payload, auth)
                submit_dispatched = name == "submit" and endpoint in {"ACE_Sell", "ACE_Sell_Son"}
                ak_sell_trace.emit_trace(
                    self.logger,
                    "submit_dispatch" if name == "submit" else "rpc_dispatch",
                    trace_id,
                    operation=name,
                    endpoint=endpoint,
                    account=auth.account or self._optional_text(payload, "account", max_length=128),
                    is_subaccount=bool(request_data.get("sonId")) if request_data else False,
                    count=(request_data or {}).get("count") or "",
                )
                upstream = await self.provider.post_rpc(client, endpoint, request_data)
                if auth.from_cache and self._is_auth_rejected(upstream):
                    await self._invalidate_cached_auth(auth.account)
                    if name in {"mnemonic", "balance", "subaccounts"}:
                        auth = await self._resolve_auth(client, payload, force_refresh=True, trace_id=trace_id)
                        request_data, endpoint = self._build_request(name, payload, auth)
                        upstream = await self.provider.post_rpc(client, endpoint, request_data)
                    else:
                        ak_sell_trace.emit_trace(
                            self.logger,
                            "auth_expired",
                            trace_id,
                            operation=name,
                            endpoint=endpoint,
                            account=auth.account,
                        )
                        if name == "submit":
                            await self._record_submit_attempt(
                                payload=payload,
                                auth=auth,
                                endpoint=endpoint,
                                request_data=request_data,
                                upstream=upstream,
                                state="auth_expired",
                                message="账号登录态已失效",
                                trace_id=trace_id,
                                event_id=submit_event_id,
                                last_stage="auth_expired",
                            )
                        return self._with_server_time({
                            "success": False,
                            "state": "auth_expired",
                            "operation": name,
                            "message": "账号登录态已失效，已清除缓存；请再次提交操作",
                            "payload": upstream,
                        }, trace_id=trace_id)
        except RpcGateBusy:
            ak_sell_trace.emit_trace(self.logger, "rpc_gate_busy", trace_id, operation=name)
            return self._with_server_time({
                "success": False,
                "state": "waiting",
                "operation": name,
                "message": "请求正在排队，请稍后重试",
            }, trace_id=trace_id)
        except AKSellCachedLoginRejected as exc:
            ak_sell_trace.emit_trace(
                self.logger,
                "auth_refresh_rejected",
                trace_id,
                operation=name,
                payload_msg=str(exc.payload.get("Msg") or exc.payload.get("Message") or ""),
            )
            return self._result(name, exc.payload, trace_id=trace_id)
        except AKSellUpstreamError as exc:
            ak_sell_trace.emit_trace(
                self.logger,
                "operation_error",
                trace_id,
                operation=name,
                endpoint=endpoint,
                submit_dispatched=submit_dispatched,
                error=exc.__class__.__name__,
                message=str(exc),
                status_code=exc.status_code or "",
            )
            error_result = self._error_response(name, exc, submit_dispatched=submit_dispatched)
            if name == "submit" and request_data is not None:
                await self._record_submit_attempt(
                    payload=payload,
                    auth=auth,
                    endpoint=endpoint,
                    request_data=request_data,
                    upstream={},
                    state=str(error_result.get("state") or "failed"),
                    message=str(error_result.get("message") or str(exc)),
                    trace_id=trace_id,
                    event_id=submit_event_id,
                    status_code=exc.status_code,
                    last_stage="operation_error",
                    diagnostics={
                        "error": exc.__class__.__name__,
                        "submit_dispatched": submit_dispatched,
                    },
                )
            return self._with_server_time(error_result, trace_id=trace_id)

        success = self._is_upstream_success_payload(upstream)
        if name == "submit":
            if success and self.ledger_recorder is not None:
                values = {
                    "account": auth.account or str(payload.get("account") or ""),
                    "endpoint": endpoint,
                    "request_data": self._ledger_request_data(request_data, payload),
                    "payload": upstream,
                    "source": "ak_sell_api",
                    "request_id": str(payload.get("request_id") or payload.get("requestId") or ""),
                }
                enqueue_success = getattr(self.ledger_recorder, "enqueue_success", None)
                if callable(enqueue_success):
                    enqueue_success(**values)
                else:
                    await self.ledger_recorder.record_success(**values)
            await self._record_submit_attempt(
                    payload=payload,
                    auth=auth,
                    endpoint=endpoint,
                    request_data=request_data,
                    upstream=upstream,
                    state="success" if success else "rejected",
                    message=str(upstream.get("Msg") or upstream.get("Message") or ""),
                    trace_id=trace_id,
                    last_stage="operation_completed",
                    confirmation_method="upstream_response" if success else "",
                    event_id=submit_event_id,
                )
        ak_sell_trace.emit_trace(
            self.logger,
            "operation_completed",
            trace_id,
            operation=name,
            endpoint=endpoint,
            account=auth.account if auth is not None else "",
            success=success,
            state="completed" if success else "rejected",
            payload_msg=str(upstream.get("Msg") or upstream.get("Message") or ""),
        )
        return self._with_server_time({
            "success": success,
            "state": "completed" if success else "rejected",
            "operation": name,
            "payload": upstream,
        }, trace_id=trace_id)

    async def _invoke_login(self, payload: Mapping[str, Any], *, trace_id: str = "") -> dict[str, Any]:
        request_data = self._build_login(payload)
        cached = await self._cached_login(request_data["account"])
        if cached is not None:
            ak_sell_trace.emit_trace(self.logger, "login_cache_hit", trace_id, account=request_data["account"])
            return self._result("login", cached, trace_id=trace_id)
        try:
            ak_sell_trace.emit_trace(self.logger, "login_forward_start", trace_id, account=request_data["account"])
            async with self._build_provider_client("login", trace_id) as client:
                upstream = await self.provider.post_rpc(client, "Login", request_data)
        except RpcGateBusy:
            return self._waiting("login", trace_id=trace_id)
        except AKSellUpstreamError as exc:
            return self._with_server_time(self._error_response("login", exc), trace_id=trace_id)
        return self._result("login", upstream, trace_id=trace_id)

    async def _bind_google_auth(self, payload: Mapping[str, Any], *, trace_id: str = "") -> dict[str, Any]:
        try:
            async with self._build_provider_client("google-bind", trace_id) as client:
                auth = await self._resolve_auth(client, payload, trace_id=trace_id)
                auth_data = self._build_auth_request(payload, auth)
                secret_data = dict(auth_data)
                secret_data.update({
                    "aCode": self._required_text(payload, "activationCode", aliases=("activation_code",), max_length=512),
                    "pin": self._required_text(payload, "tradePassword", aliases=("trade_password",), max_length=512),
                })
                secret_reply = await self.provider.post_rpc_reply(
                    client,
                    "Google_Secret",
                    secret_data,
                    follow_redirects=False,
                    allow_non_json=True,
                )
                secret_payload = secret_reply.payload
                if bool(secret_payload.get("Error")):
                    if auth.from_cache and self._is_auth_rejected(secret_payload):
                        return await self._cached_auth_expired("google-bind", auth, secret_payload, trace_id=trace_id)
                    return self._result("google-bind", secret_payload, trace_id=trace_id)
                secret = self._google_secret(secret_payload, secret_reply.headers, secret_reply.url)
                if not secret:
                    secret_reply = await self.provider.post_rpc_reply(
                        client,
                        "Google_Secret",
                        secret_data,
                        follow_redirects=True,
                        allow_non_json=True,
                    )
                    secret_payload = secret_reply.payload
                    if bool(secret_payload.get("Error")):
                        if auth.from_cache and self._is_auth_rejected(secret_payload):
                            return await self._cached_auth_expired("google-bind", auth, secret_payload, trace_id=trace_id)
                        return self._result("google-bind", secret_payload, trace_id=trace_id)
                    secret = self._google_secret(secret_payload, secret_reply.headers, secret_reply.url)
                if not secret:
                    return self._with_server_time({
                        "success": False,
                        "state": "failed",
                        "operation": "google-bind",
                        "message": "upstream did not return a Google secret",
                    }, trace_id=trace_id)
                bind_data = dict(auth_data)
                bind_data["gCode"] = self._google_code(secret)
                upstream = await self.provider.post_rpc(client, "Google_Bind", bind_data)
        except RpcGateBusy:
            return self._waiting("google-bind", trace_id=trace_id)
        except AKSellCachedLoginRejected as exc:
            return self._result("google-bind", exc.payload, trace_id=trace_id)
        except AKSellUpstreamError as exc:
            return self._with_server_time(self._error_response("google-bind", exc), trace_id=trace_id)

        if auth.from_cache and self._is_auth_rejected(upstream):
            return await self._cached_auth_expired("google-bind", auth, upstream, trace_id=trace_id)
        result = self._result("google-bind", upstream, trace_id=trace_id)
        if result["success"]:
            result["google_secret"] = secret
        return result

    async def _unbind_google_auth(self, payload: Mapping[str, Any], *, trace_id: str = "") -> dict[str, Any]:
        words = self._mnemonic_words(payload)
        trade_password = self._required_text(payload, "tradePassword", aliases=("trade_password",), max_length=512)
        try:
            async with self._build_provider_client("google-unbind", trace_id) as client:
                auth = await self._resolve_auth(client, payload, trace_id=trace_id)
                data = self._build_auth_request(payload, auth)
                challenge = await self.provider.post_rpc(client, "Mnemonic_Get03", data)
                if bool(challenge.get("Error")):
                    if auth.from_cache and self._is_auth_rejected(challenge):
                        return await self._cached_auth_expired("google-unbind", auth, challenge, trace_id=trace_id)
                    return self._result("google-unbind", challenge, trace_id=trace_id)
                try:
                    indices = [int(challenge.get(f"mnemonicid{position}", 0) or 0) - 1 for position in range(1, 4)]
                except (TypeError, ValueError) as exc:
                    raise AKSellInputError("upstream mnemonic challenge is invalid") from exc
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
            return self._waiting("google-unbind", trace_id=trace_id)
        except AKSellCachedLoginRejected as exc:
            return self._result("google-unbind", exc.payload, trace_id=trace_id)
        except AKSellUpstreamError as exc:
            return self._with_server_time(self._error_response("google-unbind", exc), trace_id=trace_id)

        if auth.from_cache and self._is_auth_rejected(upstream):
            return await self._cached_auth_expired("google-unbind", auth, upstream, trace_id=trace_id)
        if bool(upstream.get("Error")) and self._is_google_unbound(str(upstream.get("Msg") or "")):
            return self._with_server_time({
                "success": True,
                "state": "completed",
                "operation": "google-unbind",
                "payload": upstream,
            }, trace_id=trace_id)
        return self._result("google-unbind", upstream, trace_id=trace_id)

    async def _resolve_auth(
        self,
        client,
        payload: Mapping[str, Any],
        *,
        force_refresh: bool = False,
        trace_id: str = "",
    ) -> ResolvedAKAuth:
        explicit_key = self._optional_text(payload, "key", max_length=512)
        explicit_user_id = self._optional_text(payload, "UserID", aliases=("userId", "user_id"), max_length=64)
        if explicit_key and explicit_user_id:
            ak_sell_trace.emit_trace(self.logger, "auth_explicit", trace_id, user_id=explicit_user_id)
            return ResolvedAKAuth(userkey=explicit_key, user_id=explicit_user_id)

        account = self._optional_text(payload, "account", max_length=128).lower()
        if not account:
            if explicit_key or explicit_user_id:
                raise AKSellInputError("key and UserID must be provided together")
            raise AKSellInputError("missing required field: account or key/UserID")
        if self.account_state is None:
            raise AKSellInputError("server account-state cache is unavailable")

        if not force_refresh:
            cached = await self.account_state.get_auth(account)
            if cached is not None:
                ak_sell_trace.emit_trace(self.logger, "auth_cache_hit", trace_id, account=account)
                return self._cached_auth(cached)
            ak_sell_trace.emit_trace(self.logger, "auth_cache_miss", trace_id, account=account)

        lock = self._refresh_locks.setdefault(account, asyncio.Lock())
        async with lock:
            if not force_refresh:
                cached = await self.account_state.get_auth(account)
                if cached is not None:
                    ak_sell_trace.emit_trace(self.logger, "auth_cache_hit_after_lock", trace_id, account=account)
                    return self._cached_auth(cached)
            password = await self.account_state.get_password(account)
            if not password:
                ak_sell_trace.emit_trace(self.logger, "auth_refresh_no_password", trace_id, account=account)
                raise AKSellInputError("该账号没有已保存密码，请先调用 login")
            ak_sell_trace.emit_trace(self.logger, "auth_refresh_start", trace_id, account=account, force_refresh=force_refresh)
            login_payload = await self.provider.post_rpc(
                client,
                "Login",
                {"account": account, "password": password, "client": "WEB"},
            )
            if bool(login_payload.get("Error")):
                ak_sell_trace.emit_trace(
                    self.logger,
                    "auth_refresh_rejected",
                    trace_id,
                    account=account,
                    payload_msg=str(login_payload.get("Msg") or login_payload.get("Message") or ""),
                )
                raise AKSellCachedLoginRejected(login_payload)
            refreshed = await self.account_state.get_auth(account)
            if refreshed is None:
                ak_sell_trace.emit_trace(self.logger, "auth_refresh_missing_cache", trace_id, account=account)
                raise AKSellInputError("登录成功但未写入可用登录态")
            ak_sell_trace.emit_trace(self.logger, "auth_refresh_success", trace_id, account=account)
            return self._cached_auth(refreshed)

    @staticmethod
    def _cached_auth(cached: CachedAKAccountAuth) -> ResolvedAKAuth:
        return ResolvedAKAuth(
            userkey=cached.userkey,
            user_id=cached.user_id,
            account=cached.account,
            from_cache=True,
        )

    async def _invalidate_cached_auth(self, account: str) -> None:
        if self.account_state is not None and account:
            await self.account_state.invalidate_auth(account)

    async def _cached_login(self, account: str) -> dict[str, Any] | None:
        if self.account_state is None:
            return None
        cached = await self.account_state.get_auth(account)
        if cached is None:
            return None
        return {
            "Error": False,
            "Key": cached.userkey,
            "UserID": cached.user_id,
            "UserData": {"Id": cached.user_id},
        }

    async def _cached_auth_expired(
        self,
        operation: str,
        auth: ResolvedAKAuth,
        payload: Mapping[str, Any],
        *,
        trace_id: str = "",
    ) -> dict[str, Any]:
        await self._invalidate_cached_auth(auth.account)
        ak_sell_trace.emit_trace(
            self.logger,
            "auth_expired",
            trace_id,
            operation=operation,
            account=auth.account,
            payload_msg=str(payload.get("Msg") or payload.get("Message") or ""),
        )
        return self._with_server_time({
            "success": False,
            "state": "auth_expired",
            "operation": operation,
            "message": "账号登录态已失效，已清除缓存；请再次提交操作",
            "payload": dict(payload),
        }, trace_id=trace_id)

    def _build_request(
        self,
        operation: str,
        payload: Mapping[str, Any],
        auth: ResolvedAKAuth,
    ) -> tuple[dict[str, str], str]:
        if operation == "mnemonic":
            return self._build_auth_request(payload, auth), "Mnemonic_Get01"
        if operation == "balance":
            return self._build_auth_request(payload, auth), "public_IndexData"
        if operation == "subaccounts":
            data = self._build_auth_request(payload, auth)
            data["account"] = self._optional_text(payload, "account", max_length=128)
            data["p"] = self._positive_integer(payload, "p", maximum=1_000_000)
            data["pageSize"] = self._positive_integer(payload, "pageSize", maximum=100)
            return data, "My_Subaccount"
        return self._build_submit(payload, auth)

    @classmethod
    def _build_login(cls, payload: Mapping[str, Any]) -> dict[str, str]:
        return {
            "account": cls._required_text(payload, "account", max_length=128),
            "password": cls._required_text(payload, "password", max_length=512),
            "client": "WEB",
        }

    def _build_auth_request(
        self,
        payload: Mapping[str, Any],
        auth: ResolvedAKAuth | None = None,
    ) -> dict[str, str]:
        return {
            "key": auth.userkey if auth is not None else self._required_text(payload, "key", max_length=512),
            "UserID": auth.user_id if auth is not None else self._required_text(payload, "UserID", aliases=("userId", "user_id"), max_length=64),
            "v": str(self.server_time()["v"]),
            "lang": self._optional_text(payload, "lang", max_length=16) or "cn",
        }

    def _build_submit(self, payload: Mapping[str, Any], auth: ResolvedAKAuth) -> tuple[dict[str, str], str]:
        data = self._build_auth_request(payload, auth)
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

    def _waiting(self, operation: str, *, trace_id: str = "") -> dict[str, Any]:
        return self._with_server_time({
            "success": False,
            "state": "waiting",
            "operation": operation,
            "message": "request is waiting for the shared upstream RPC lock",
        }, trace_id=trace_id)

    def _result(self, operation: str, upstream: Mapping[str, Any], *, trace_id: str = "") -> dict[str, Any]:
        success = not bool(upstream.get("Error"))
        return self._with_server_time({
            "success": success,
            "state": "completed" if success else "rejected",
            "operation": operation,
            "payload": dict(upstream),
        }, trace_id=trace_id)

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

    @staticmethod
    def _is_auth_rejected(payload: Mapping[str, Any]) -> bool:
        if not bool(payload.get("Error")):
            return False
        message = " ".join(
            str(payload.get(name) or "")
            for name in ("Msg", "Message", "Code")
        ).replace(" ", "").lower()
        return any(marker in message for marker in (
            "用户未登录",
            "用戶未登錄",
            "请先登录",
            "請先登錄",
            "登录已过期",
            "登入已過期",
        ))

    def _build_provider_client(self, operation: str, trace_id: str = ""):
        try:
            return self.provider.build_client(operation, trace_id=trace_id)
        except TypeError:
            return self.provider.build_client(operation)

    async def _record_submit_attempt(
        self,
        *,
        payload: Mapping[str, Any],
        auth: ResolvedAKAuth | None,
        endpoint: str,
        request_data: Mapping[str, Any] | None,
        upstream: Mapping[str, Any] | None,
        state: str,
        message: str,
        trace_id: str,
        confirmation_method: str = "",
        status_code: int | None = None,
        last_stage: str = "",
        diagnostics: Mapping[str, Any] | None = None,
        event_id: str = "",
    ) -> None:
        recorder = getattr(self.ledger_recorder, "record_attempt", None)
        enqueue_recorder = getattr(self.ledger_recorder, "enqueue_attempt", None)
        if not callable(recorder) and not callable(enqueue_recorder):
            return
        values = {
            "account": (auth.account if auth is not None else "") or self._optional_text(payload, "account", max_length=128),
            "endpoint": endpoint,
            "request_data": self._ledger_request_data(request_data, payload),
            "payload": upstream or {},
            "source": "ak_sell_api",
            "state": state,
            "message": message,
            "trace_id": trace_id,
            "request_id": self._request_id(payload),
            "confirmation_method": confirmation_method,
            "status_code": status_code,
            "last_stage": last_stage,
            "diagnostics": diagnostics or {},
            "event_id": event_id or self._attempt_event_id(payload, trace_id),
        }
        try:
            if callable(enqueue_recorder):
                enqueue_recorder(**values)
            else:
                await recorder(**values)
        except Exception as exc:
            self.logger.warning("[AKSellLedger] submit attempt callback failed: %s", str(exc)[:300])

    def _ledger_request_data(
        self,
        request_data: Mapping[str, Any] | None,
        payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        data = dict(request_data or {})
        sub_name = self._optional_text(
            payload,
            "subAccountName",
            aliases=("sub_account_name", "sonName", "son_name"),
            max_length=128,
        )
        if sub_name:
            data["subAccountName"] = sub_name
        return data

    def _request_id(self, payload: Mapping[str, Any]) -> str:
        return self._optional_text(payload, "request_id", aliases=("requestId",), max_length=128)

    def _attempt_event_id(self, payload: Mapping[str, Any], trace_id: str) -> str:
        trace_id = ak_sell_trace.normalize_trace_id(trace_id)
        if trace_id:
            return f"ak-sell-trace:{trace_id}"
        request_id = self._request_id(payload)
        if request_id:
            return f"ak-sell-request:{request_id}"
        return ""

    @staticmethod
    def _is_upstream_success_payload(payload: Mapping[str, Any]) -> bool:
        folded = {str(key).casefold(): value for key, value in payload.items()}
        has_error = "error" in folded
        has_success = "success" in folded
        error = folded.get("error", None)
        if error is False:
            return True
        if isinstance(error, str) and error.strip().casefold() in {"false", "0", "no"}:
            return True
        if has_error:
            return False
        success = folded.get("success", None)
        if success is True:
            return True
        if isinstance(success, str) and success.strip().casefold() in {"true", "1", "yes"}:
            return True
        if has_success:
            return False
        return not bool(payload.get("Error"))

    def _trace_received(self, operation: str, payload: Mapping[str, Any], trace_id: str) -> None:
        ak_sell_trace.emit_trace(
            self.logger,
            "operation_received",
            trace_id,
            operation=operation,
            account=self._optional_text(payload, "account", max_length=128),
            is_subaccount=bool(self._optional_text(payload, "sonId", aliases=("son_id",), max_length=64)),
            count=self._optional_text(payload, "count", max_length=32),
            request_id=self._optional_text(payload, "request_id", aliases=("requestId",), max_length=128),
        )

    def _with_server_time(self, result: dict[str, Any], *, trace_id: str = "") -> dict[str, Any]:
        data = {**result, "server_time": self.server_time()}
        trace_id = ak_sell_trace.normalize_trace_id(trace_id)
        if trace_id:
            data["trace_id"] = trace_id
        return data

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
    def _error_response(
        operation: str,
        exc: AKSellUpstreamError,
        *,
        submit_dispatched: bool = False,
    ) -> dict[str, Any]:
        if operation == "submit" and submit_dispatched and (
            exc.is_read_timeout or exc.status_code in {502, 504}
        ):
            return {
                "success": False,
                "state": "unknown",
                "operation": operation,
                "message": "写入操作未获得上游结果，结果未知，请勿自动重发",
                "status_code": exc.status_code,
            }
        if operation in {"google-bind", "google-unbind"} and exc.is_read_timeout:
            return {
                "success": False,
                "state": "unknown",
                "operation": operation,
                "message": "写入操作未获得上游结果，结果未知，请勿自动重发",
                "status_code": exc.status_code,
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
