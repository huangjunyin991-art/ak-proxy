#!/usr/bin/env python3
"""Audit FastAPI write routes for backend authorization guards.

This is a static safety net for admin-facing write endpoints. It is intentionally
conservative: it does not prove an endpoint is secure, but it flags write routes
that do not match one of the known backend guard patterns.
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable


WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

DEFAULT_SCAN_GLOBS = (
    "public_admin/server/**/*.py",
    "public_admin/plugins/**/server/**/*.py",
)

SKIP_PARTS = {"__pycache__", ".git", "node_modules", "bin"}

PUBLIC_BUSINESS_PREFIXES = (
    "/RPC/",
    "/api/v1/",
    "/api/license/",
    "/api/check-update",
    "/api/v1/check-update",
)

PUBLIC_BUSINESS_EXACT = {
    "/admin/api/login",
    "/chat/api/ws-ticket",
    "/api/notify-center/status",
    "/api/notify-center/web-push/vapid-public-key",
    "/api/notify-center/web-push/subscriptions",
    "/api/notify-center/ntfy/binding",
    "/api/notify-center/ntfy/test",
}

BROWSE_SESSION_PREFIXES = (
    "/admin/ak-rpc/",
    "/admin/ak-site/",
    "/admin/ak-web/",
    "/ak-web/",
)

ADMIN_LIKE_PREFIXES = (
    "/admin/api/",
    "/api/dispatcher",
    "/api/db",
    "/api/ban",
    "/api/unban",
)


@dataclass
class RouteAudit:
    file: str
    line: int
    function: str
    methods: list[str]
    paths: list[str]
    guard: str
    severity: str
    reason: str
    evidence: list[str]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Audit FastAPI write routes for known backend auth guards.",
    )
    parser.add_argument("--root", default=".", help="Repository root. Default: current directory.")
    parser.add_argument(
        "--format",
        choices=("text", "json"),
        default="text",
        help="Output format. Default: text.",
    )
    parser.add_argument(
        "--fail-on",
        choices=("missing", "warn", "none"),
        default="missing",
        help="Exit non-zero when findings at or above this severity exist. Default: missing.",
    )
    parser.add_argument(
        "--include-public",
        action="store_true",
        help="Include documented public/business endpoints in text output.",
    )
    parser.add_argument(
        "--include-ok",
        action="store_true",
        help="Include OK routes in text output.",
    )
    return parser.parse_args()


def iter_python_files(root: Path) -> Iterable[Path]:
    seen: set[Path] = set()
    for pattern in DEFAULT_SCAN_GLOBS:
        for path in root.glob(pattern):
            if path in seen or not path.is_file():
                continue
            if any(part in SKIP_PARTS for part in path.parts):
                continue
            seen.add(path)
            yield path


def route_decorators(node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[tuple[str, list[str], int]]:
    routes: list[tuple[str, list[str], int]] = []
    for deco in node.decorator_list:
        if not isinstance(deco, ast.Call):
            continue
        method_name = _decorator_method_name(deco.func)
        if not method_name:
            continue
        paths = [value for value in (_literal_string(arg) for arg in deco.args[:1]) if value]
        if not paths:
            continue
        methods = _decorator_methods(method_name, deco)
        routes.append((paths[0], methods, getattr(deco, "lineno", node.lineno)))
    return routes


def _decorator_method_name(func: ast.AST) -> str:
    if isinstance(func, ast.Attribute) and func.attr in {"get", "post", "put", "patch", "delete", "api_route"}:
        return func.attr
    return ""


def _decorator_methods(method_name: str, deco: ast.Call) -> list[str]:
    if method_name != "api_route":
        return [method_name.upper()]
    for keyword in deco.keywords:
        if keyword.arg != "methods":
            continue
        values = _literal_string_list(keyword.value)
        if values:
            return sorted({value.upper() for value in values})
    return ["GET"]


def _literal_string(node: ast.AST) -> str:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return ""


def _literal_string_list(node: ast.AST) -> list[str]:
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return [value for value in (_literal_string(item) for item in node.elts) if value]
    return []


def operation_auth_scope_for(paths: list[str], methods: list[str]) -> str:
    resolver = _operation_scope_resolver()
    if resolver is None:
        return ""
    matched_scopes: set[str] = set()
    for path in paths:
        normalized_path = _normalize_route_path(path)
        for method in methods:
            normalized_method = str(method or "").upper()
            scope = str(resolver.resolve(normalized_method, normalized_path) or "")
            if scope:
                matched_scopes.add(scope)
    if not matched_scopes:
        return ""
    return ",".join(sorted(matched_scopes))


def _operation_scope_resolver():
    try:
        repo_root = Path(__file__).resolve().parents[2]
        repo_root_text = str(repo_root)
        if repo_root_text not in sys.path:
            sys.path.insert(0, repo_root_text)
        from public_admin.server.security.operation_auth.scope_resolver import OperationScopeResolver

        return OperationScopeResolver()
    except Exception:
        return None


def _normalize_route_path(path: str) -> str:
    normalized = str(path or "").split("?", 1)[0]
    if len(normalized) > 1:
        normalized = normalized.rstrip("/")
    return normalized or "/"


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def analyze_file(root: Path, path: Path) -> list[RouteAudit]:
    source = read_text(path)
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as exc:
        rel = path.relative_to(root).as_posix()
        return [
            RouteAudit(
                file=rel,
                line=getattr(exc, "lineno", 1) or 1,
                function="<parse>",
                methods=[],
                paths=[],
                guard="parse_error",
                severity="missing",
                reason=f"Python parse failed: {exc}",
                evidence=[],
            )
        ]
    rel = path.relative_to(root).as_posix()
    items: list[RouteAudit] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        routes = route_decorators(node)
        if not routes:
            continue
        write_routes = [(route_path, methods, line) for route_path, methods, line in routes if WRITE_METHODS.intersection(methods)]
        if not write_routes:
            continue
        paths = [route_path for route_path, _methods, _line in write_routes]
        methods = sorted({method for _route_path, route_methods, _line in write_routes for method in route_methods})
        body = ast.get_source_segment(source, node) or ""
        guard, severity, reason, evidence = classify_route(paths, methods, body, node.name)
        items.append(
            RouteAudit(
                file=rel,
                line=min(line for _route_path, _methods, line in write_routes),
                function=node.name,
                methods=methods,
                paths=paths,
                guard=guard,
                severity=severity,
                reason=reason,
                evidence=evidence,
            )
        )
    return items


def classify_route(paths: list[str], methods: list[str], body: str, function_name: str) -> tuple[str, str, str, list[str]]:
    evidence: list[str] = []
    if "verify_signature(" in body:
        evidence.append("verify_signature")
        return "internal_signature", "ok", "service-to-service signature guard", evidence
    if "_validate_im_switch_token(" in body or "_verify_im_switch_token(" in body:
        evidence.append("im_switch_token")
        return "signed_token", "ok", "one-time IM switch token guard", evidence
    if "resolve_admin_identity(request" in body and "validate_issue=" in body:
        evidence.append("ws_ticket_admin_identity")
        return "admin_session", "ok", "admin websocket ticket issue delegates identity and resource validation", evidence
    if "super_admin_only=True" in body or "require_super_admin(" in body:
        evidence.append("super_admin_only")
        return "super_admin", "ok", "super admin guard", evidence
    if _has_role_super_admin_gate(body):
        evidence.append("ROLE_SUPER_ADMIN")
        return "super_admin", "ok", "explicit super admin role guard", evidence
    if "_require_admin_account_scope(" in body or "require_admin_user_scope(" in body:
        evidence.append("account_scope")
        return "account_scope", "ok", "admin token plus account ownership guard", evidence
    if "require_license_admin(" in body:
        evidence.append("require_license_admin")
        return "permission_scope", "ok", "license permission guard", evidence
    if _has_permission_scoped_admin_guard(body):
        evidence.append("_require_admin_token(permission)")
        return "permission_scope", "ok", "admin permission-scope guard", evidence
    operation_scope = operation_auth_scope_for(paths, methods)
    if operation_scope:
        evidence.append(f"operation_auth:{operation_scope}")
        return "operation_auth_scope", "ok", "admin token plus operation lease guard", evidence
    if _issues_operation_auth_lease(body):
        evidence.append("operation_auth_totp")
        return "operation_auth_issue", "ok", "admin token plus TOTP code issues scoped operation lease", evidence
    if _uses_permission_helper(body):
        evidence.append("permission_helper")
        return "permission_scope", "ok", "route-local helper validates admin permission scope", evidence
    if "_resolve_meeting_admin_context(" in body:
        evidence.append("_resolve_meeting_admin_context")
        return "admin_session", "warn", "meeting helper validates admin token; review scope when changed", evidence
    if "resolve_context(" in body and "service.resolve_scope(" in body:
        evidence.append("resolve_context")
        evidence.append("service.resolve_scope")
        return "account_scope", "ok", "router helper validates admin token and service scope", evidence
    if (
        "require_admin_request(" in body
        or "verify_admin_token(" in body
        or "_require_admin_token(" in body
        or "require_admin(request)" in body
    ):
        evidence.append("admin_token")
        return "admin_session", "warn", "admin token guard without a specific permission scope", evidence
    if "_resolve_admin_identity(" in body or "resolve_admin_identity(request" in body:
        evidence.append("resolve_admin_identity")
        return "admin_session", "warn", "admin identity guard without a specific permission scope", evidence
    if all(is_public_business_path(path) for path in paths):
        evidence.append("documented_public_business")
        return "public_business_auth", "info", "documented public or user-business endpoint", evidence
    if all(is_browse_session_path(path) for path in paths):
        if "_resolve_browse_session(" in body or "session" in body:
            evidence.append("browse_session")
            return "browse_session", "info", "AK upstream browser proxy guarded by browse session", evidence
    if all(path.startswith("/internal/") for path in paths):
        return "missing_internal_signature", "missing", "internal write endpoint without detected signature guard", evidence
    if any(is_admin_like_path(path) for path in paths):
        return "missing_admin_guard", "missing", "admin-like write endpoint without detected backend guard", evidence
    return "unclassified", "warn", "write endpoint does not match known guard categories", evidence


def _has_permission_scoped_admin_guard(body: str) -> bool:
    marker = "_require_admin_token("
    start = 0
    while True:
        index = body.find(marker, start)
        if index < 0:
            return False
        line = body[index : body.find("\n", index) if "\n" in body[index:] else len(body)]
        if "'" in line or '"' in line:
            return True
        start = index + len(marker)


def _issues_operation_auth_lease(body: str) -> bool:
    return (
        "service.issue_lease(" in body
        and "resolve_admin_identity(request" in body
        and "code =" in body
        and "scope =" in body
    )


def _uses_permission_helper(body: str) -> bool:
    return "require_admin(request)" in body


def _has_role_super_admin_gate(body: str) -> bool:
    return (
        (
            "ROLE_SUPER_ADMIN" in body
            or "service.super_admin_role" in body
            or "super_admin_role" in body
        )
        and "status_code=403" in body
        and (
            "role != ROLE_SUPER_ADMIN" in body
            or "admin_role != ROLE_SUPER_ADMIN" in body
            or "get_token_role(token) != ROLE_SUPER_ADMIN" in body
            or "role != service.super_admin_role" in body
            or "role != super_admin_role" in body
        )
    )


def is_public_business_path(path: str) -> bool:
    if path in PUBLIC_BUSINESS_EXACT:
        return True
    return any(path.startswith(prefix) for prefix in PUBLIC_BUSINESS_PREFIXES)


def is_browse_session_path(path: str) -> bool:
    return any(path.startswith(prefix) for prefix in BROWSE_SESSION_PREFIXES)


def is_admin_like_path(path: str) -> bool:
    return any(path.startswith(prefix) for prefix in ADMIN_LIKE_PREFIXES)


def severity_rank(severity: str) -> int:
    return {"missing": 3, "warn": 2, "info": 1, "ok": 0}.get(severity, 2)


def print_text(items: list[RouteAudit], include_public: bool, include_ok: bool) -> None:
    visible = [
        item for item in items
        if item.severity in {"missing", "warn"}
        or (include_public and item.severity == "info")
        or (include_ok and item.severity == "ok")
    ]
    counts: dict[str, int] = {}
    for item in items:
        counts[item.severity] = counts.get(item.severity, 0) + 1
    print(
        "Admin write route audit: "
        f"total={len(items)} ok={counts.get('ok', 0)} warn={counts.get('warn', 0)} "
        f"missing={counts.get('missing', 0)} info={counts.get('info', 0)}"
    )
    print()
    for item in sorted(visible, key=lambda x: (-severity_rank(x.severity), x.file, x.line, x.function)):
        methods = ",".join(item.methods)
        paths = ", ".join(item.paths)
        evidence = f" evidence={','.join(item.evidence)}" if item.evidence else ""
        print(
            f"{item.severity.upper():7} {item.guard:26} {methods:18} {paths}\n"
            f"        {item.file}:{item.line} {item.function} - {item.reason}{evidence}"
        )


def main() -> int:
    args = parse_args()
    root = Path(args.root).resolve()
    items: list[RouteAudit] = []
    for path in sorted(iter_python_files(root)):
        items.extend(analyze_file(root, path))
    if args.format == "json":
        print(json.dumps([asdict(item) for item in items], ensure_ascii=False, indent=2))
    else:
        print_text(items, include_public=args.include_public, include_ok=args.include_ok)
    threshold = {"missing": 3, "warn": 2, "none": 99}[args.fail_on]
    return 1 if any(severity_rank(item.severity) >= threshold for item in items) else 0


if __name__ == "__main__":
    sys.exit(main())
