from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse


TRUTHY_VALUES = {"1", "true", "yes", "on", "enabled"}
OPERATION_AUTH_DISABLE_ENV = "ADMIN_ALLOW_OPERATION_AUTH_DISABLED"
UNSAFE_PROXY_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
ADMIN_EMBEDDED_AK_PROXY_PREFIXES = (
    "/admin/ak-rpc",
    "/admin/ak-site",
    "/admin/ak-web",
)
CDN_CGI_PROXY_PREFIX = "/cdn-cgi"


def env_flag(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    text = str(value).strip().lower()
    if not text:
        return default
    return text in TRUTHY_VALUES


@dataclass(frozen=True)
class OperationAuthProbe:
    method: str
    path: str
    expected_scope: str


@dataclass(frozen=True)
class OperationAuthSelfCheck:
    ok: bool
    issues: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        return asdict(self)


REQUIRED_SCOPE_PROBES = (
    OperationAuthProbe("POST", "/admin/api/db/sql", "db_write_ops"),
    OperationAuthProbe("POST", "/admin/api/db/insert/user_stats", "db_write_ops"),
    OperationAuthProbe("POST", "/admin/api/monitoring/static-cache/policy", "dispatcher_ops"),
    OperationAuthProbe("POST", "/admin/ak-rpc/Login", "dispatcher_ops"),
    OperationAuthProbe("PUT", "/admin/ak-rpc/Login", "dispatcher_ops"),
    OperationAuthProbe("POST", "/admin/ak-web/RPC/Login", "dispatcher_ops"),
    OperationAuthProbe("DELETE", "/admin/ak-web/RPC/Login", "dispatcher_ops"),
    OperationAuthProbe("PUT", "/admin/ak-site/RPC/Login", "dispatcher_ops"),
    OperationAuthProbe("POST", "/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1", "dispatcher_ops"),
    OperationAuthProbe("GET", "/admin/api/operation_auth/secrets", "totp_secret_ops"),
)


class FallbackOperationScopeResolver:
    """Minimal resolver used only when the real OperationAuth package is unavailable."""

    def __init__(self):
        self.exact = {
            ("POST", "/api/ban"): "ban_ops",
            ("POST", "/api/unban"): "ban_ops",
            ("POST", "/admin/api/ban/user"): "ban_ops",
            ("POST", "/admin/api/unban/user"): "ban_ops",
            ("POST", "/admin/api/ban/ip"): "ban_ops",
            ("POST", "/admin/api/unban/ip"): "ban_ops",
            ("POST", "/admin/api/db/sql"): "db_write_ops",
            ("GET", "/admin/api/db/tables"): "db_read_ops",
            ("POST", "/api/dispatcher/add"): "dispatcher_ops",
            ("POST", "/api/dispatcher/remove"): "dispatcher_ops",
            ("POST", "/api/dispatcher/detect_ips"): "dispatcher_ops",
            ("POST", "/api/dispatcher/probe_latency"): "dispatcher_ops",
            ("POST", "/api/dispatcher/rate_limit"): "dispatcher_ops",
            ("POST", "/api/dispatcher/policy"): "dispatcher_ops",
            ("POST", "/api/dispatcher/max_login"): "dispatcher_ops",
            ("POST", "/api/dispatcher/start_singbox"): "dispatcher_ops",
            ("POST", "/api/dispatcher/parse_sub"): "dispatcher_ops",
            ("POST", "/api/dispatcher/apply_sub"): "dispatcher_ops",
            ("POST", "/api/dispatcher/reload_singbox"): "dispatcher_ops",
            ("POST", "/admin/api/license/create"): "account_ops",
            ("POST", "/admin/api/license/revoke"): "account_ops",
            ("POST", "/admin/api/license/edit"): "account_ops",
            ("POST", "/admin/api/license/blacklist/add"): "account_ops",
            ("POST", "/admin/api/license/blacklist/remove"): "account_ops",
            ("POST", "/admin/api/license/disable-client"): "account_ops",
            ("POST", "/admin/api/license/enable-client"): "account_ops",
            ("POST", "/admin/api/credits/config"): "account_ops",
            ("POST", "/admin/api/credits/topup"): "account_ops",
            ("POST", "/admin/api/meeting/permissions"): "account_ops",
            ("POST", "/admin/api/meeting/sub_admin_toggle"): "account_ops",
            ("POST", "/admin/api/meeting/permissions/revoke"): "account_ops",
            ("POST", "/admin/api/whitelist/add"): "account_ops",
            ("POST", "/admin/api/whitelist/renew"): "account_ops",
            ("POST", "/admin/api/whitelist/delete"): "account_ops",
            ("POST", "/admin/api/whitelist/set_global"): "account_ops",
            ("POST", "/admin/api/risk-isolation/isolate"): "account_ops",
            ("POST", "/admin/api/risk-isolation/isolate_scope"): "account_ops",
            ("POST", "/admin/api/risk-isolation/release"): "account_ops",
            ("POST", "/admin/api/risk-isolation/release_scope"): "account_ops",
            ("POST", "/admin/api/risk-isolation/page_404"): "account_ops",
            ("POST", "/admin/api/sub_admin/set"): "account_ops",
            ("POST", "/admin/api/sub_admin/bind_account"): "account_ops",
            ("POST", "/admin/api/sub_admin/update_permissions"): "account_ops",
            ("POST", "/admin/api/sub_admin/delete"): "account_ops",
            ("POST", "/admin/api/sub_admin/kick"): "account_ops",
            ("POST", "/admin/api/sub_admin/set_monitoring"): "account_ops",
            ("POST", "/admin/api/ak_auth/clear"): "dispatcher_ops",
            ("POST", "/admin/api/browse_login"): "dispatcher_ops",
            ("POST", "/admin/api/notifications/meeting/resolve"): "moderate_ops",
            ("POST", "/admin/api/notify-center/ntfy/binding"): "account_ops",
            ("DELETE", "/admin/api/notify-center/ntfy/binding"): "account_ops",
            ("POST", "/admin/api/notify-center/ntfy/test"): "moderate_ops",
            ("POST", "/admin/api/notify-center/outbox/flush"): "dispatcher_ops",
            ("POST", "/admin/api/remote_assist/start"): "moderate_ops",
            ("POST", "/admin/api/remote_assist/close"): "moderate_ops",
            ("POST", "/admin/api/remote_voice/start"): "moderate_ops",
            ("POST", "/admin/api/remote_voice/close"): "moderate_ops",
            ("POST", "/admin/api/remote_voice/config"): "moderate_ops",
            ("POST", "/admin/api/im/groups/owner/transfer"): "im_admin_ops",
            ("POST", "/admin/api/im/groups/admins/replace"): "im_admin_ops",
            ("POST", "/admin/api/im/emoji_assets/import"): "im_admin_ops",
            ("POST", "/admin/api/im/emoji_assets/upload"): "im_admin_ops",
            ("POST", "/admin/api/im/file_assets/config"): "im_admin_ops",
            ("POST", "/admin/api/im/image_upload/config"): "im_admin_ops",
            ("POST", "/admin/api/performance/index-plan/run"): "db_write_ops",
            ("POST", "/admin/api/monitoring/runtime-hygiene/config"): "dispatcher_ops",
            ("POST", "/admin/api/monitoring/runtime-hygiene/run-once"): "dispatcher_ops",
            ("POST", "/admin/api/monitoring/snapshot-policy"): "dispatcher_ops",
            ("POST", "/admin/api/monitoring/ws-tickets/policy"): "dispatcher_ops",
            ("POST", "/admin/api/monitoring/request-metrics/policy"): "dispatcher_ops",
            ("POST", "/admin/api/monitoring/request-metrics/clear"): "dispatcher_ops",
            ("POST", "/admin/api/monitoring/blocking-pools/policy"): "dispatcher_ops",
            ("POST", "/admin/api/monitoring/static-cache/policy"): "dispatcher_ops",
            ("POST", "/admin/api/monitoring/static-cache/refresh-upstream"): "dispatcher_ops",
            ("POST", "/admin/api/monitoring/static-cache/prewarm"): "dispatcher_ops",
            ("POST", "/admin/api/active-defense/policy"): "ban_ops",
            ("POST", "/admin/api/active-defense/runtime/clear"): "ban_ops",
            ("POST", "/admin/api/rate-ban/policy"): "ban_ops",
            ("POST", "/admin/api/rate-ban/runtime/clear"): "ban_ops",
            ("POST", "/admin/api/operation_auth/lease"): "admin_sensitive_ops",
            ("GET", "/admin/api/operation_auth/secrets"): "totp_secret_ops",
            ("POST", "/admin/api/operation_auth/secrets/reset"): "totp_secret_ops",
            ("POST", "/admin/api/point-stats/sync"): "point_stats_ops",
            ("POST", "/admin/api/point-stats/backfill/run"): "point_stats_ops",
            ("GET", "/admin/api/point-stats"): "point_stats_ops",
            ("GET", "/admin/api/point-stats/backfill/status"): "point_stats_ops",
        }
        self.prefixes = (
            ("POST", "/admin/api/db/insert/", "db_write_ops"),
            ("PUT", "/admin/api/db/update/", "db_write_ops"),
            ("DELETE", "/admin/api/db/delete/", "db_write_ops"),
            ("GET", "/admin/api/db/schema/", "db_read_ops"),
            ("GET", "/admin/api/db/query/", "db_read_ops"),
            ("DELETE", "/admin/api/credits/config/", "account_ops"),
            ("DELETE", "/admin/api/subscription_groups/", "dispatcher_ops"),
            ("POST", "/admin/api/subscription_groups/", "dispatcher_ops"),
            ("PATCH", "/admin/api/subscription_groups/", "dispatcher_ops"),
            ("POST", "/admin/api/monitoring/chat/file-assets/", "im_admin_ops"),
            ("GET", "/admin/api/recommend-tree/", "recommend_tree_ops"),
            ("POST", "/admin/api/recommend-tree/", "recommend_tree_ops"),
        )

    def resolve(self, method: str, path: str, body: bytes | None = None) -> str:
        normalized_method = str(method or "").upper()
        normalized_path = self._normalize_path(path)
        scope = self.exact.get((normalized_method, normalized_path))
        if scope:
            return scope
        if self._is_unsafe_ak_proxy_write(normalized_method, normalized_path):
            return "dispatcher_ops"
        for prefix_method, prefix, prefix_scope in self.prefixes:
            if normalized_method == prefix_method and normalized_path.startswith(prefix):
                return prefix_scope
        return ""

    def needs_body(self, method: str, path: str) -> bool:
        return False

    def _normalize_path(self, path: str) -> str:
        normalized = str(path or "").split("?", 1)[0]
        if len(normalized) > 1:
            normalized = normalized.rstrip("/")
        return normalized or "/"

    def _is_unsafe_ak_proxy_write(self, method: str, path: str) -> bool:
        if method not in UNSAFE_PROXY_METHODS:
            return False
        if any(self._path_is_under(path, prefix) for prefix in ADMIN_EMBEDDED_AK_PROXY_PREFIXES):
            return True
        return self._path_is_under(path, CDN_CGI_PROXY_PREFIX)

    def _path_is_under(self, path: str, prefix: str) -> bool:
        base = str(prefix or "").rstrip("/") or "/"
        return path == base or path.startswith(base + "/")


class OperationAuthUnavailableMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, *, resolver, reason: str = ""):
        super().__init__(app)
        self.resolver = resolver or FallbackOperationScopeResolver()
        self.reason = str(reason or "operation_auth_unavailable")

    async def dispatch(self, request, call_next):
        scope = self.resolver.resolve(request.method, request.url.path)
        if not scope:
            return await call_next(request)
        return JSONResponse(
            status_code=503,
            content={
                "error": True,
                "success": False,
                "code": "OPERATION_AUTH_UNAVAILABLE",
                "message": "操作二次授权不可用，敏感操作已保护性关闭",
                "scope": scope,
                "reason": self.reason,
                "allow_env": OPERATION_AUTH_DISABLE_ENV,
            },
        )


def run_operation_auth_self_check(resolver) -> OperationAuthSelfCheck:
    issues: list[str] = []
    if resolver is None:
        return OperationAuthSelfCheck(False, ("scope resolver is missing",))
    for probe in REQUIRED_SCOPE_PROBES:
        try:
            actual = resolver.resolve(probe.method, probe.path)
        except Exception as exc:
            issues.append(f"{probe.method} {probe.path}: resolver raised {exc}")
            continue
        if actual != probe.expected_scope:
            issues.append(
                f"{probe.method} {probe.path}: expected {probe.expected_scope}, got {actual or '-'}"
            )
    return OperationAuthSelfCheck(not issues, tuple(issues))
