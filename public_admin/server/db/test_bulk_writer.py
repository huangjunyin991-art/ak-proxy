import asyncio
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from public_admin.server import database_pg
from public_admin.server.db.bulk_writer import execute_bulk_unnest, get_bulk_writer_snapshot, rows_to_columns


class FakeConnection:
    def __init__(self):
        self.calls = []

    async def execute(self, sql, *args):
        self.calls.append({"sql": sql, "args": args})
        return f"INSERT 0 {len(args[0]) if args else 0}"


async def test_rows_to_columns_transposes_without_string_parsing():
    assert rows_to_columns([(1, "a"), (2, "b")], 2) == [[1, 2], ["a", "b"]]


async def test_execute_bulk_unnest_records_metrics():
    conn = FakeConnection()
    await execute_bulk_unnest(conn, "SELECT * FROM UNNEST($1::int[])", [[1, 2, 3]], operation="test.bulk", row_count=3)
    snapshot = get_bulk_writer_snapshot()
    assert snapshot["operations"]["test.bulk"]["rows"] >= 3
    assert conn.calls[0]["args"] == ([1, 2, 3],)


async def test_point_history_bulk_helper_uses_single_unnest_statement():
    conn = FakeConnection()
    saved_at = datetime(2026, 6, 8, 12, 0, 0)
    row = (
        "alice",
        "sp",
        "key-1",
        "2026-06-08 12:00:00",
        date(2026, 6, 8),
        "bonus",
        1,
        10.5,
        None,
        "Bonus",
        "bonus-cn",
        "daily bonus",
        '{"ok":true}',
        saved_at,
    )
    await database_pg._upsert_point_history_records_bulk(conn, [row], "test.point")
    assert len(conn.calls) == 1
    assert "FROM UNNEST" in conn.calls[0]["sql"]
    assert len(conn.calls[0]["args"]) == 14
    assert conn.calls[0]["args"][0] == ["alice"]
    assert conn.calls[0]["args"][13] == [saved_at]


async def test_notification_delivery_bulk_helper_normalizes_usernames():
    conn = FakeConnection()
    sent_at = datetime(2026, 6, 8, 12, 0, 0)
    await database_pg._insert_notification_deliveries_bulk(conn, 42, ["Alice", " Bob "], sent_at)
    assert len(conn.calls) == 1
    assert "notification_deliveries" in conn.calls[0]["sql"]
    assert conn.calls[0]["args"][0] == [42, 42]
    assert conn.calls[0]["args"][1] == ["alice", "bob"]
    assert conn.calls[0]["args"][2] == [sent_at, sent_at]


async def main():
    await test_rows_to_columns_transposes_without_string_parsing()
    await test_execute_bulk_unnest_records_metrics()
    await test_point_history_bulk_helper_uses_single_unnest_statement()
    await test_notification_delivery_bulk_helper_normalizes_usernames()


if __name__ == "__main__":
    asyncio.run(main())
