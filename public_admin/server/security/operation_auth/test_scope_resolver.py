import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from public_admin.server.security.operation_auth.scope_resolver import OperationScopeResolver


def test_admin_raw_sql_always_uses_write_scope():
    resolver = OperationScopeResolver()

    assert resolver.needs_body("POST", "/admin/api/db/sql") is False
    assert resolver.resolve("POST", "/admin/api/db/sql", body=b'{"sql":"select 1"}') == "db_write_ops"
    assert resolver.resolve("POST", "/admin/api/db/sql", body=b'{"sql":"delete from user_stats"}') == "db_write_ops"


def test_admin_embedded_ak_proxy_unsafe_methods_require_dispatcher_scope():
    resolver = OperationScopeResolver()

    assert resolver.resolve("POST", "/admin/ak-rpc/Login") == "dispatcher_ops"
    assert resolver.resolve("PUT", "/admin/ak-rpc/Login") == "dispatcher_ops"
    assert resolver.resolve("DELETE", "/admin/ak-web/RPC/Login") == "dispatcher_ops"
    assert resolver.resolve("PUT", "/admin/ak-site/RPC/Login") == "dispatcher_ops"
    assert resolver.resolve("POST", "/admin/ak-web") == "dispatcher_ops"


def test_ak_proxy_safe_and_native_paths_do_not_require_admin_scope():
    resolver = OperationScopeResolver()

    assert resolver.resolve("GET", "/admin/ak-web/RPC/Login") == ""
    assert resolver.resolve("OPTIONS", "/admin/ak-web/RPC/Login") == ""
    assert resolver.resolve("POST", "/ak-web/RPC/Login") == ""


def test_cdn_cgi_unsafe_methods_require_dispatcher_scope():
    resolver = OperationScopeResolver()

    assert resolver.resolve("POST", "/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1") == "dispatcher_ops"
    assert resolver.resolve("GET", "/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1") == ""
    assert resolver.resolve("OPTIONS", "/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1") == ""


def test_license_password_reset_requires_account_scope():
    resolver = OperationScopeResolver()

    assert resolver.resolve("POST", "/admin/api/license/reset-password") == "account_ops"


def test_risk_isolation_umbrella_requires_account_scope():
    resolver = OperationScopeResolver()

    assert resolver.resolve("POST", "/admin/api/risk-isolation/isolate_umbrella") == "account_ops"
    assert resolver.resolve("POST", "/admin/api/risk-isolation/release_umbrella") == "account_ops"


def test_recommend_tree_reads_do_not_require_operation_auth():
    resolver = OperationScopeResolver()

    assert resolver.resolve("GET", "/admin/api/recommend-tree/accounts") == ""
    assert resolver.resolve("GET", "/admin/api/recommend-tree/cache") == ""
    assert resolver.resolve("GET", "/admin/api/recommend-tree/promotion-policy") == ""


def test_recommend_tree_writes_require_operation_auth():
    resolver = OperationScopeResolver()

    assert resolver.resolve("POST", "/admin/api/recommend-tree/refresh") == "recommend_tree_ops"
    assert resolver.resolve("POST", "/admin/api/recommend-tree/promotion-policy") == "recommend_tree_ops"


def main():
    test_admin_raw_sql_always_uses_write_scope()
    test_admin_embedded_ak_proxy_unsafe_methods_require_dispatcher_scope()
    test_ak_proxy_safe_and_native_paths_do_not_require_admin_scope()
    test_cdn_cgi_unsafe_methods_require_dispatcher_scope()
    test_license_password_reset_requires_account_scope()
    test_risk_isolation_umbrella_requires_account_scope()
    test_recommend_tree_reads_do_not_require_operation_auth()
    test_recommend_tree_writes_require_operation_auth()


if __name__ == "__main__":
    main()
