from __future__ import annotations

from copy import deepcopy
from typing import Any


_CHANGE_USERNAME_RPC_NAMES = {"change_username"}
_USERNAME_PARAM_KEYS = ("MemberNo", "memberno", "memberNo")
_USERNAME_FIELDS = ("UserName", "username", "Account", "account")


def extract_changed_username(api_path: str, params: dict[str, Any] | None, result: dict[str, Any] | None) -> str:
    normalized_path = str(api_path or "").strip("/").lower()
    if normalized_path not in _CHANGE_USERNAME_RPC_NAMES:
        return ""
    if not isinstance(result, dict) or result.get("Error") is not False:
        return ""
    if not isinstance(params, dict):
        return ""
    for key in _USERNAME_PARAM_KEYS:
        value = params.get(key)
        username = str(value or "").strip().lower()
        if username:
            return username
    return ""


def patch_login_payload_username(login_payload: dict[str, Any] | None, username: str) -> dict[str, Any]:
    normalized_username = str(username or "").strip().lower()
    payload = deepcopy(login_payload) if isinstance(login_payload, dict) else {}
    if not normalized_username:
        return payload

    user_data = payload.get("UserData")
    if isinstance(user_data, dict):
        user_data = deepcopy(user_data)
    else:
        user_data = {}
    payload["UserData"] = user_data

    user_data["UserName"] = normalized_username
    for field in _USERNAME_FIELDS:
        if field in user_data:
            user_data[field] = normalized_username
        if field in payload:
            payload[field] = normalized_username
    payload.setdefault("UserName", normalized_username)
    return payload
