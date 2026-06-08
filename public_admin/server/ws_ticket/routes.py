from __future__ import annotations

import hashlib
import inspect
from typing import Any, Callable

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .service import WsTicketError


def create_ws_ticket_router(
    *,
    service,
    resolve_user_subject: Callable[..., Any],
    resolve_admin_identity: Callable[..., Any],
    validate_issue: Callable[..., Any],
    logger: Any = None,
) -> APIRouter:
    router = APIRouter()

    @router.post("/chat/api/ws-ticket")
    async def issue_user_ws_ticket(request: Request):
        data = await _read_json(request)
        audience = _normalize_audience(data.get("audience") or data.get("aud") or "chat")
        if audience not in {"chat", "assist", "voice"}:
            await _record_issue_reject(service, request, data, audience, "unsupported_audience", role="user")
            return _error("unsupported_audience", "unsupported websocket audience", 400)
        subject = await _maybe_await(resolve_user_subject(request, data, audience))
        if not subject and audience != "chat":
            await _record_issue_reject(service, request, data, audience, "missing_subject", role="user")
            return _error("missing_subject", "missing signed user identity", 401)
        subject = subject or _build_guest_subject(request, data)
        return await _issue(
            service=service,
            request=request,
            data=data,
            audience=audience,
            subject=subject,
            role="user",
            auth_context={"kind": "user"},
            validate_issue=validate_issue,
            logger=logger,
        )

    @router.post("/admin/api/ws-ticket")
    async def issue_admin_ws_ticket(request: Request):
        data = await _read_json(request)
        audience = _normalize_audience(data.get("audience") or data.get("aud") or "")
        if audience not in {"admin", "assist", "voice"}:
            await _record_issue_reject(service, request, data, audience, "unsupported_audience", role="admin")
            return _error("unsupported_audience", "unsupported admin websocket audience", 400)
        identity = await _maybe_await(resolve_admin_identity(request, data, audience))
        if not isinstance(identity, dict) or not identity.get("ok"):
            await _record_issue_reject(
                service,
                request,
                data,
                audience,
                str((identity or {}).get("code") or "unauthorized"),
                role="admin",
            )
            return _error(
                str((identity or {}).get("code") or "unauthorized"),
                str((identity or {}).get("message") or "unauthorized"),
                int((identity or {}).get("status") or 401),
            )
        return await _issue(
            service=service,
            request=request,
            data=data,
            audience=audience,
            subject=str(identity.get("subject") or ""),
            role="admin",
            auth_context=identity,
            validate_issue=validate_issue,
            logger=logger,
        )

    return router


async def _issue(*, service, request: Request, data: dict[str, Any], audience: str,
                 subject: str, role: str, auth_context: dict[str, Any],
                 validate_issue: Callable[..., Any], logger: Any = None):
    try:
        validation = await _maybe_await(
            validate_issue(request, data, audience, subject, role, auth_context)
        )
        if not isinstance(validation, dict):
            await _record_issue_reject(service, request, data, audience, "validation_failed", subject=subject, role=role)
            return _error("validation_failed", "websocket ticket validation failed", 403)
        if not validation.get("ok"):
            await _record_issue_reject(
                service,
                request,
                data,
                audience,
                str(validation.get("code") or "forbidden"),
                subject=subject,
                role=role,
                resource_type=str(validation.get("resource_type") or ""),
                resource_id=str(validation.get("resource_id") or ""),
                site=str(validation.get("site") or ""),
            )
            return _error(
                str(validation.get("code") or "forbidden"),
                str(validation.get("message") or "forbidden"),
                int(validation.get("status") or 403),
            )
        issue = await service.issue(
            audience=audience,
            subject=subject,
            role=role,
            resource_type=str(validation.get("resource_type") or ""),
            resource_id=str(validation.get("resource_id") or ""),
            site=str(validation.get("site") or ""),
            readonly=bool(validation.get("readonly", False)),
            claims=dict(validation.get("claims") or {}),
            client_ip=_client_ip(request),
            user_agent=request.headers.get("user-agent", ""),
        )
        response = JSONResponse(issue.to_response())
        response.headers["Cache-Control"] = "no-store"
        return response
    except WsTicketError as exc:
        await _record_issue_reject(service, request, data, audience, exc.code, subject=subject, role=role)
        return _error(exc.code, exc.message, 400)
    except Exception as exc:
        if logger is not None:
            try:
                logger.warning("[WsTicket] issue_failed audience=%s role=%s subject=%s: %s", audience, role, subject or "-", exc)
            except Exception:
                pass
        return _error("issue_failed", "websocket ticket issue failed", 500)


async def _record_issue_reject(
    service,
    request: Request,
    data: dict[str, Any],
    audience: str,
    code: str,
    *,
    subject: str = "",
    role: str = "",
    resource_type: str = "",
    resource_id: str = "",
    site: str = "",
) -> None:
    if not service or not hasattr(service, "record_event"):
        return
    if not resource_id:
        resource_id = str(
            (data or {}).get("resource_id")
            or (data or {}).get("session_id")
            or (data or {}).get("assist_session_id")
            or (data or {}).get("voice_session_id")
            or ""
        ).strip()
    try:
        await service.record_event(
            event_type="reject",
            code=code,
            audience=audience,
            subject=subject,
            role=role,
            resource_type=resource_type,
            resource_id=resource_id,
            site=site or str((data or {}).get("site") or "").strip(),
            consume_ip=_client_ip(request),
            user_agent=request.headers.get("user-agent", ""),
        )
    except Exception:
        pass


async def _read_json(request: Request) -> dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        data = {}
    return data if isinstance(data, dict) else {}


async def _maybe_await(value):
    if inspect.isawaitable(value):
        return await value
    return value


def _normalize_audience(value: Any) -> str:
    return str(value or "").strip().lower().replace("_", "-")


def _build_guest_subject(request: Request, data: dict[str, Any]) -> str:
    hint = str(data.get("username") or data.get("subject") or data.get("client_id") or "").strip().lower()
    if hint == "visitor" or hint.startswith("guest_"):
        return hint[:80]
    client = _client_ip(request) or "unknown"
    digest = hashlib.sha256(f"{client}|{request.headers.get('user-agent', '')}".encode("utf-8")).hexdigest()
    return "guest_" + digest[:14]


def _client_ip(request: Request) -> str:
    forwarded = str(request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    if forwarded:
        return forwarded
    real_ip = str(request.headers.get("x-real-ip") or "").strip()
    if real_ip:
        return real_ip
    client = getattr(request, "client", None)
    return str(getattr(client, "host", "") or "")


def _error(code: str, message: str, status_code: int) -> JSONResponse:
    response = JSONResponse(
        {"success": False, "code": code, "message": message},
        status_code=status_code,
    )
    response.headers["Cache-Control"] = "no-store"
    return response
