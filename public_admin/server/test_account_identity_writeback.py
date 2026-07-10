import asyncio

from public_admin.server.account_identity import PHASE_BY_KEY
from public_admin.server.account_identity.writeback import sync_account_id_spec_for_username


class FakeIdentityService:
    def __init__(self, account_id: int):
        self.account_id = int(account_id)
        self.calls = []

    async def ensure_identity(self, username: str, conn=None):
        self.calls.append({"username": username, "conn": conn})
        return {"account_id": self.account_id}


class FakeConn:
    def __init__(self, columns_by_table: dict[str, list[str]]):
        self.columns_by_table = columns_by_table
        self.execute_calls = []

    async def fetch(self, sql, *args):
        table_name = str(args[0] or "")
        return [{"column_name": value} for value in self.columns_by_table.get(table_name, [])]

    async def execute(self, sql, *args):
        self.execute_calls.append({"sql": sql, "args": args})
        return "UPDATE 1"


async def _test_sync_account_id_spec_for_username_updates_target_rows():
    spec = PHASE_BY_KEY["core"].specs[0]
    conn = FakeConn({"user_stats": ["username", "account_id"]})
    service = FakeIdentityService(42)

    changed = await sync_account_id_spec_for_username(conn, service, spec, " Alice ")

    assert changed == 1
    assert service.calls and service.calls[0]["username"] == "alice"
    assert len(conn.execute_calls) == 1
    assert conn.execute_calls[0]["args"] == (42, "alice")
    assert 'UPDATE "user_stats"' in conn.execute_calls[0]["sql"]


async def _test_sync_account_id_spec_for_username_skips_missing_account_id_column():
    spec = PHASE_BY_KEY["core"].specs[0]
    conn = FakeConn({"user_stats": ["username"]})
    service = FakeIdentityService(42)

    changed = await sync_account_id_spec_for_username(conn, service, spec, "alice")

    assert changed == 0
    assert service.calls == []
    assert conn.execute_calls == []


def test_sync_account_id_spec_for_username_updates_target_rows():
    asyncio.run(_test_sync_account_id_spec_for_username_updates_target_rows())


def test_sync_account_id_spec_for_username_skips_missing_account_id_column():
    asyncio.run(_test_sync_account_id_spec_for_username_skips_missing_account_id_column())


async def main():
    await _test_sync_account_id_spec_for_username_updates_target_rows()
    await _test_sync_account_id_spec_for_username_skips_missing_account_id_column()


if __name__ == "__main__":
    asyncio.run(main())
