import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[4]))

from public_admin.server.security.operation_auth.scope_resolver import OperationScopeResolver


def test_admin_raw_sql_always_uses_write_scope():
    resolver = OperationScopeResolver()

    assert resolver.needs_body("POST", "/admin/api/db/sql") is False
    assert resolver.resolve("POST", "/admin/api/db/sql", body=b'{"sql":"select 1"}') == "db_write_ops"
    assert resolver.resolve("POST", "/admin/api/db/sql", body=b'{"sql":"delete from user_stats"}') == "db_write_ops"


def main():
    test_admin_raw_sql_always_uses_write_scope()


if __name__ == "__main__":
    main()
