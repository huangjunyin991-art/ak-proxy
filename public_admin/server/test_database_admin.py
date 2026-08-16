from .database_pg import _sanitize_output_row, _sanitize_output_rows


def test_database_query_keeps_sensitive_values_hidden_by_default():
    row = _sanitize_output_row({'username': 'demo', 'password': 'secret', 'ak_userkey': 'key-1'})

    assert row['username'] == 'demo'
    assert row['password'] == '***'
    assert row['ak_userkey'] == '***'
    assert row['has_password'] is True
    assert row['has_ak_userkey'] is True


def test_database_query_can_reveal_sensitive_values_after_database_auth():
    rows = _sanitize_output_rows(
        [{'username': 'demo', 'password': 'secret', 'ak_userkey': 'key-1'}],
        reveal_sensitive=True,
    )

    assert rows == [{'username': 'demo', 'password': 'secret', 'ak_userkey': 'key-1'}]
