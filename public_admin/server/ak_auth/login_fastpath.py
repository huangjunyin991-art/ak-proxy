import copy
import logging
import time
from datetime import datetime
from typing import Any, Awaitable, Callable
from urllib.parse import urlencode

from .models import AkLoginFastPathResult, AkUserKeyValidationResult

logger = logging.getLogger("TransparentProxy.AKAuth")

ForwardRequest = Callable[..., Awaitable[Any]]
LoadAuthState = Callable[[str], Awaitable[dict[str, Any] | None]]
SaveAuthState = Callable[..., Awaitable[Any]]


class AkUserKeyLoginFastPath:
    def __init__(
        self,
        *,
        load_auth_state: LoadAuthState,
        save_auth_state: SaveAuthState,
        forward_request: ForwardRequest,
        ttl_seconds: int,
    ):
        self.load_auth_state = load_auth_state
        self.save_auth_state = save_auth_state
        self.forward_request = forward_request
        self.ttl_seconds = int(ttl_seconds or 3600)

    async def try_login(
        self,
        *,
        username: str,
        password: str = '',
        headers: dict[str, str] | None = None,
        client_ip: str = '',
        selected_exit: Any = None,
        force_direct: bool = False,
    ) -> AkLoginFastPathResult:
        normalized_username = str(username or '').strip().lower()
        if not normalized_username or normalized_username == 'unknown':
            return AkLoginFastPathResult(success=False, reason='missing_username')
        try:
            persisted = await self.load_auth_state(normalized_username)
        except Exception as exc:
            logger.warning(f"[AKUserKeyFastPath] username={normalized_username} result=fallback reason=load_failed err={exc}")
            return AkLoginFastPathResult(success=False, reason='load_failed')
        if not persisted:
            return AkLoginFastPathResult(success=False, reason='missing_auth_state')
        login_payload = _ensure_dict(persisted.get('login_result') or persisted.get('login_payload'))
        cookies = _ensure_string_dict(persisted.get('cookies'))
        userkey = str(persisted.get('userkey') or _extract_login_result_userkey(login_payload) or '').strip()
        user_id = _extract_login_user_id(login_payload)
        if not userkey:
            return AkLoginFastPathResult(success=False, reason='missing_userkey')
        if not user_id:
            return AkLoginFastPathResult(success=False, reason='missing_user_id')
        validation = await self.validate_userkey(
            userkey=userkey,
            user_id=user_id,
            cookies=cookies,
            headers=headers or {},
            client_ip=client_ip,
            selected_exit=selected_exit,
            force_direct=force_direct,
        )
        if not validation.valid:
            logger.info(
                f"[AKUserKeyFastPath] username={normalized_username} user_id={user_id} key_tail={_tail(userkey)} "
                f"result=fallback reason={validation.reason} status={validation.status_code} elapsed={validation.elapsed_ms}ms"
            )
            return AkLoginFastPathResult(
                success=False,
                reason=validation.reason,
                userkey=userkey,
                user_id=user_id,
                username=normalized_username,
                validation=validation,
            )
        response_payload = _build_login_payload(login_payload, userkey, user_id)
        try:
            await self.save_auth_state(
                normalized_username,
                userkey=userkey,
                cookies=cookies,
                login_payload=response_payload,
                ttl_seconds=self.ttl_seconds,
            )
        except Exception as exc:
            logger.warning(f"[AKUserKeyFastPath] username={normalized_username} result=success persist_refresh_failed={exc}")
        logger.info(
            f"[AKUserKeyFastPath] username={normalized_username} user_id={user_id} key_tail={_tail(userkey)} "
            f"result=success elapsed={validation.elapsed_ms}ms"
        )
        return AkLoginFastPathResult(
            success=True,
            reason='validated',
            login_payload=response_payload,
            cookies=cookies,
            userkey=userkey,
            user_id=user_id,
            username=normalized_username,
            validation=validation,
        )

    async def validate_userkey(
        self,
        *,
        userkey: str,
        user_id: str,
        cookies: dict[str, str],
        headers: dict[str, str],
        client_ip: str,
        selected_exit: Any = None,
        force_direct: bool = False,
    ) -> AkUserKeyValidationResult:
        params = {
            'key': userkey,
            'UserID': user_id,
            'v': _make_rpc_v(),
            'lang': 'cn',
        }
        content_type = 'application/x-www-form-urlencoded; charset=UTF-8'
        request_headers = _build_validation_headers(headers, cookies)
        raw_body = urlencode(params).encode('utf-8')
        started_at = time.perf_counter()
        try:
            response = await self.forward_request(
                'POST',
                'public_IndexData',
                content_type,
                params,
                raw_body,
                request_headers,
                client_ip=client_ip,
                selected_exit=selected_exit,
                force_direct=force_direct,
            )
        except Exception as exc:
            return AkUserKeyValidationResult(valid=False, reason=f'request_failed:{type(exc).__name__}', elapsed_ms=_elapsed_ms(started_at))
        elapsed_ms = _elapsed_ms(started_at)
        status_code = int(getattr(response, 'status_code', 0) or 0)
        if status_code != 200:
            return AkUserKeyValidationResult(valid=False, reason=f'http_{status_code}', status_code=status_code, elapsed_ms=elapsed_ms)
        try:
            payload = response.json()
        except Exception:
            return AkUserKeyValidationResult(valid=False, reason='invalid_json', status_code=status_code, elapsed_ms=elapsed_ms)
        if not isinstance(payload, dict):
            return AkUserKeyValidationResult(valid=False, reason='invalid_payload', status_code=status_code, elapsed_ms=elapsed_ms)
        if payload.get('Error') is True:
            return AkUserKeyValidationResult(valid=False, reason=_extract_error_reason(payload), status_code=status_code, payload=payload, elapsed_ms=elapsed_ms)
        if _looks_like_auth_error(payload):
            return AkUserKeyValidationResult(valid=False, reason=_extract_error_reason(payload), status_code=status_code, payload=payload, elapsed_ms=elapsed_ms)
        if not payload:
            return AkUserKeyValidationResult(valid=False, reason='empty_payload', status_code=status_code, elapsed_ms=elapsed_ms)
        return AkUserKeyValidationResult(valid=True, reason='ok', status_code=status_code, payload=payload, elapsed_ms=elapsed_ms)


def _build_validation_headers(headers: dict[str, str], cookies: dict[str, str]) -> dict[str, str]:
    normalized = dict(headers or {})
    normalized.setdefault('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
    normalized.setdefault('accept', 'application/json, text/javascript, */*; q=0.01')
    normalized.setdefault('x-requested-with', 'XMLHttpRequest')
    normalized.setdefault('origin', 'https://www.akapi1.com')
    normalized.setdefault('referer', 'https://www.akapi1.com/')
    cookie_header = _build_cookie_header(cookies)
    if cookie_header:
        normalized['cookie'] = cookie_header
    return normalized


def _build_cookie_header(cookies: dict[str, str]) -> str:
    return '; '.join(f'{key}={value}' for key, value in (cookies or {}).items() if str(key or '').strip())


def _build_login_payload(login_payload: dict[str, Any], userkey: str, user_id: str) -> dict[str, Any]:
    payload = copy.deepcopy(login_payload) if isinstance(login_payload, dict) else {}
    if payload.get('Error') is None:
        payload['Error'] = False
    payload['Key'] = userkey
    user_data = payload.get('UserData')
    if not isinstance(user_data, dict):
        user_data = {}
        payload['UserData'] = user_data
    user_data.setdefault('Id', user_id)
    return payload


def _extract_login_result_userkey(login_result: dict[str, Any]) -> str:
    if not isinstance(login_result, dict):
        return ''
    result_key = login_result.get('Key')
    if result_key not in (None, ''):
        return str(result_key)
    user_data = login_result.get('UserData')
    if not isinstance(user_data, dict):
        return ''
    for key in ('Key', 'key', 'UserKey', 'userkey', 'ukey'):
        value = user_data.get(key)
        if value not in (None, ''):
            return str(value)
    return ''


def _extract_login_user_id(login_result: dict[str, Any]) -> str:
    if not isinstance(login_result, dict):
        return ''
    user_data = login_result.get('UserData')
    containers = [user_data, login_result] if isinstance(user_data, dict) else [login_result]
    for container in containers:
        if not isinstance(container, dict):
            continue
        for key in ('Id', 'ID', 'UserID', 'userid'):
            value = container.get(key)
            if value not in (None, ''):
                return str(value)
    return ''


def _ensure_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _ensure_string_dict(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(key): str(item) for key, item in value.items() if str(key or '').strip()}


def _extract_error_reason(payload: dict[str, Any]) -> str:
    message = str(payload.get('Msg') or payload.get('Message') or payload.get('message') or '').strip()
    return f'auth_error:{message[:80]}' if message else 'auth_error'


def _looks_like_auth_error(payload: dict[str, Any]) -> bool:
    text = ' '.join(str(payload.get(key) or '') for key in ('Msg', 'Message', 'message', 'Code', 'code'))
    lowered = text.lower()
    markers = ('key', 'login', '登录', '登錄', '未登', '失效', '过期', '過期', 'invalid', 'expired')
    return any(marker in lowered for marker in markers)


def _tail(value: str, length: int = 4) -> str:
    text = str(value or '')
    return text[-length:] if text else '-'


def _make_rpc_v() -> str:
    now = datetime.now()
    return str(now.year + now.month + now.day + now.hour + now.minute)


def _elapsed_ms(started_at: float) -> int:
    return max(0, int((time.perf_counter() - started_at) * 1000))
