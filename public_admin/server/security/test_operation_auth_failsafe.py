import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from public_admin.server.security.operation_auth_failsafe import (
    FallbackOperationScopeResolver,
    run_operation_auth_self_check,
)


def test_fallback_resolver_covers_sensitive_operation_auth_paths():
    resolver = FallbackOperationScopeResolver()

    assert resolver.resolve("POST", "/admin/api/db/sql") == "db_write_ops"
    assert resolver.resolve("POST", "/admin/api/db/insert/user_stats") == "db_write_ops"
    assert resolver.resolve("POST", "/admin/api/monitoring/static-cache/policy") == "dispatcher_ops"
    assert resolver.resolve("POST", "/admin/ak-rpc/Login") == "dispatcher_ops"
    assert resolver.resolve("PUT", "/admin/ak-rpc/Login") == "dispatcher_ops"
    assert resolver.resolve("POST", "/admin/ak-web/RPC/Login") == "dispatcher_ops"
    assert resolver.resolve("DELETE", "/admin/ak-web/RPC/Login") == "dispatcher_ops"
    assert resolver.resolve("PUT", "/admin/ak-site/RPC/Login") == "dispatcher_ops"
    assert resolver.resolve("POST", "/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1") == "dispatcher_ops"
    assert resolver.resolve("GET", "/admin/ak-web/RPC/Login") == ""
    assert resolver.resolve("OPTIONS", "/admin/ak-web/RPC/Login") == ""
    assert resolver.resolve("POST", "/ak-web/RPC/Login") == ""
    assert resolver.resolve("POST", "/admin/api/operation_auth/lease") == "admin_sensitive_ops"
    assert resolver.resolve("GET", "/admin/api/operation_auth/secrets") == "totp_secret_ops"


def test_operation_auth_self_check_passes_for_fallback_resolver():
    result = run_operation_auth_self_check(FallbackOperationScopeResolver())

    assert result.ok is True
    assert result.issues == ()


def test_operation_auth_self_check_reports_missing_scope():
    class EmptyResolver:
        def resolve(self, method, path, body=None):
            return ""

    result = run_operation_auth_self_check(EmptyResolver())

    assert result.ok is False
    assert result.issues


def main():
    test_fallback_resolver_covers_sensitive_operation_auth_paths()
    test_operation_auth_self_check_passes_for_fallback_resolver()
    test_operation_auth_self_check_reports_missing_scope()


if __name__ == "__main__":
    main()
