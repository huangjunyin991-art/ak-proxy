from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any


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
    """Records confirmed browser RPC sales without coupling the public route to storage details."""

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
        endpoint = SALE_ENDPOINTS.get(str(normalized_path or "").strip().lower())
        if not endpoint:
            return False
        if payload.get("Error") is not False:
            self._logger.info(
                "[AKSellLedger] public sale skipped endpoint=%s reason=upstream_rejected error=%s",
                endpoint,
                _error_state(payload),
            )
            return False

        account = _account_from_cookies(cookies)
        identity_source = "cookie" if account else ""
        key = _key_from_params(params)
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
                return False
        if not account and not key:
            account = _account_from_params(params)
            identity_source = "params" if account else ""
        if not account:
            user_id = _text(params.get("UserID") or params.get("userId") or params.get("userid"))
            self._logger.warning(
                "[AKSellLedger] public sale skipped endpoint=%s reason=unresolved_account "
                "identity_source=none key_present=%s user_id=%s",
                endpoint,
                bool(key),
                user_id or "-",
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
        self._logger.info(
            "[AKSellLedger] public sale result=%s endpoint=%s account=%s identity_source=%s",
            "recorded" if recorded else "not_recorded",
            endpoint,
            account,
            identity_source,
        )
        return recorded


def _error_state(payload: Mapping[str, Any]) -> str:
    if "Error" not in payload:
        return "missing"
    value = payload.get("Error")
    if isinstance(value, bool):
        return str(value).lower()
    return f"{type(value).__name__}:{str(value)[:32]}"
