import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from public_admin.server.db.sql_policy import classify_admin_sql


def assert_policy(sql: str, *, readonly: bool, multi: bool = False, explain_analyze: bool = False):
    policy = classify_admin_sql(sql)
    assert policy.is_readonly is readonly
    assert policy.has_multiple_statements is multi
    assert policy.explain_analyze is explain_analyze


def test_readonly_sql_allows_basic_read_shapes():
    assert_policy("select * from user_stats limit 1", readonly=True)
    assert_policy("/* leading */ SELECT * FROM user_stats LIMIT 1", readonly=True)
    assert_policy("show server_version", readonly=True)
    assert_policy("explain select * from user_stats", readonly=True)


def test_sql_write_risks_are_not_readonly():
    assert_policy("update user_stats set login_count = 0", readonly=False)
    assert_policy("show server_version; delete from user_stats", readonly=False, multi=True)
    assert_policy("explain analyze update user_stats set login_count = 0", readonly=False, explain_analyze=True)
    assert_policy("explain /* comment */ analyze update user_stats set login_count = 0", readonly=False, explain_analyze=True)
    assert_policy("explain (analyze true) delete from user_stats where username = 'x'", readonly=False, explain_analyze=True)
    assert_policy("with x as (delete from user_stats returning *) select * from x", readonly=False)


def main():
    test_readonly_sql_allows_basic_read_shapes()
    test_sql_write_risks_are_not_readonly()


if __name__ == "__main__":
    main()
