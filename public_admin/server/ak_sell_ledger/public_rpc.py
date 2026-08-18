from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from .parser import parse_success_payload


SALE_ENDPOINTS = {
    "ace_sell": "ACE_Sell",
    "ace_sell_son": "ACE_Sell_Son",
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _account_from_params(params: Mapping[str, Any]) -> str:
    for field in ("account", "Account", "username", "UserName", "user_name"):
        value = params.get(field)
        if isinstance(value, (list, tuple)):
            value = value[0] if value else ""
        account = _text(value).lower()
        if account:
            return account
    return ""


def _account_from_cookies(cookies: Mapping[str, Any]) -> str:
    for field in ("ak_username", "ak_im_username"):
        account = _text(cookies.get(field)).lower()
        if account:
            return account
    return ""


def _key_from_params(params: Mapping[str, Any]) -> str:
    for field in ("key", "Key", "userkey", "UserKey"):
        value = params.get(field)
        if isinstance(value, (list, tuple)):
            value = value[0] if value else ""
        userkey = _text(value)
        if userkey:
            return userkey
    return ""


class PublicRpcSaleRecorder:
    """Records browser sale responses and confirmed sales without coupling the route to storage."""

    def __init__(
        self,
        ledger_service,
        resolve_account_by_key: Callable[[str], Awaitable[str]],
        logger,
    ) -> None:
        self._ledger_service = ledger_service
        self._resolve_account_by_key = resolve_account_by_key
        self._logger = logger

    async def record_if_success(
        self,
        *,
        normalized_path: str,
        params: Mapping[str, Any],
        payload: Mapping[str, Any],
        cookies: Mapping[str, Any],
        request_id: str = "",
    ) -> bool:
        """Backward-compatible wrapper for callers that only have a JSON response."""
        return await self.record_response(
            normalized_path=normalized_path,
            params=params,
            payload=payload,
            cookies=cookies,
            request_id=request_id,
            status_code=200,
        )

    async def record_response(
        self,
        *,
        normalized_path: str,
        params: Mapping[str, Any],
        payload: Mapping[str, Any],
        cookies: Mapping[str, Any],
        request_id: str = "",
        status_code: int = 200,
        exit_name: str = "",
        upstream_ms: int | None = None,
        response_bytes: int | None = None,
    ) -> bool:
        """Persist every sale response while only creating a ledger row on success.

        HTTP failures and upstream timeouts are diagnostic attempts, not confirmed
        sales.  Keeping them here makes the ledger an accurate request audit trail
        instead of silently dropping all gateway failures.
        """
        endpoint = SALE_ENDPOINTS.get(str(normalized_path or "").strip().lower())
        if not endpoint:
            return False

        try:
            status_code = int(status_code or 0)
        except (TypeError, ValueError):
            status_code = 0
        success, message = parse_success_payload(payload)
        account = _account_from_cookies(cookies) or _account_from_params(params)
        key = _key_from_params(params)
        identity_source = "cookie_or_params" if account else ""
        if not account and key:
            try:
                account = _text(await self._resolve_account_by_key(key)).lower()
                identity_source = "key" if account else ""
            except Exception as exc:
                self._logger.warning(
                    "[AKSellLedger] public RPC account resolution failed endpoint=%s error=%s",
                    endpoint,
                    str(exc)[:200],
                )
                identity_source = "key_error"

        if status_code >= 500:
            state = "unknown"
            response_message = message or (
                "上游响应超时，结果未知" if status_code in {504, 598, 599}
                else "网关未取得上游结果"
            )
        elif status_code >= 400 or not success:
            state = "rejected"
            response_message = message or "上游拒绝"
        else:
            state = "success"
            response_message = message or "出售成功"

        diagnostics = {
            "http_status": status_code,
            "identity_source": identity_source,
            "exit_name": _text(exit_name),
        }
        if state != "success":
            await self._record_attempt(
                account=account,
                endpoint=endpoint,
                params=params,
                payload=payload,
                state=state,
                message=response_message,
                request_id=request_id,
                status_code=status_code,
                exit_name=exit_name,
                upstream_ms=upstream_ms,
                response_bytes=response_bytes,
                diagnostics=diagnostics,
            )
            self._logger.info(
                "[AKSellLedger] public sale skipped endpoint=%s reason=%s status=%s exit=%s",
                endpoint,
                "upstream_timeout" if state == "unknown" else "upstream_rejected",
                status_code,
                _text(exit_name) or "-",
            )
            return False

        if not account:
            user_id = _text(params.get("UserID") or params.get("userId") or params.get("userid"))
            self._logger.warning(
                "[AKSellLedger] public sale skipped endpoint=%s reason=unresolved_account "
                "identity_source=none key_present=%s user_id=%s",
                endpoint,
                bool(key),
                user_id or "-",
            )
            await self._record_attempt(
                account="",
                endpoint=endpoint,
                params=params,
                payload=payload,
                state="success_unresolved_account",
                message="挂卖成功但无法解析账号",
                request_id=request_id,
                status_code=status_code,
                exit_name=exit_name,
                upstream_ms=upstream_ms,
                response_bytes=response_bytes,
                diagnostics={"user_id": user_id or ""},
            )
            return False

        recorded = await self._ledger_service.record_success(
            account=account,
            endpoint=endpoint,
            request_data=params,
            payload=payload,
            source="public_rpc",
            request_id=_text(request_id),
        )
        await self._record_attempt(
            account=account,
            endpoint=endpoint,
            params=params,
            payload=payload,
            state="success",
            message=response_message,
            request_id=request_id,
            confirmation_method="upstream_response",
            status_code=status_code,
            exit_name=exit_name,
            upstream_ms=upstream_ms,
            response_bytes=response_bytes,
            diagnostics=diagnostics,
        )
        self._logger.info(
            "[AKSellLedger] public sale result=%s endpoint=%s account=%s identity_source=%s",
            "recorded" if recorded else "not_recorded",
            endpoint,
            account,
            identity_source,
        )
        return recorded

    async def _record_attempt(
        self,
        *,
        account: str,
        endpoint: str,
        params: Mapping[str, Any],
        payload: Mapping[str, Any],
        state: str,
        message: str,
        request_id: str = "",
        confirmation_method: str = "",
        status_code: int | None = None,
        exit_name: str = "",
        upstream_ms: int | None = None,
        response_bytes: int | None = None,
        diagnostics: Mapping[str, Any] | None = None,
    ) -> None:
        recorder = getattr(self._ledger_service, "record_attempt", None)
        if not callable(recorder):
            return
        try:
            await recorder(
                account=account,
                endpoint=endpoint,
                request_data=params,
                payload=payload,
                source="public_rpc",
                state=state,
                message=message,
                request_id=_text(request_id),
                confirmation_method=confirmation_method or ("upstream_response" if state == "success" else ""),
                status_code=status_code,
                exit_name=exit_name,
                upstream_ms=upstream_ms,
                response_bytes=response_bytes,
                last_stage="public_rpc_response",
                diagnostics=diagnostics or {},
            )
        except Exception as exc:
            self._logger.warning("[AKSellLedger] public attempt record failed endpoint=%s error=%s", endpoint, str(exc)[:200])
