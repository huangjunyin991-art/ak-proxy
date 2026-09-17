import asyncio

from .service import ExitRequestStatsService


class _Conn:
    def __init__(self):
        self.executed = []

    async def execute(self, sql, *args):
        self.executed.append((sql, args))
        return "DELETE 0"

    async def fetch(self, sql, *args):
        return []


class _Acquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *args):
        return False


class _Pool:
    def __init__(self):
        self.conn = _Conn()

    def acquire(self):
        return _Acquire(self.conn)


def test_record_aggregates_statuses_without_io():
    pool = _Pool()
    service = ExitRequestStatsService(lambda: pool)
    service.record(identity="node-1", name="Node 1", exit_ip="1.2.3.4", status_code=200)
    service.record(identity="node-1", name="Node 1", exit_ip="1.2.3.4", status_code=403)
    service.record(identity="node-1", name="Node 1", exit_ip="1.2.3.4", status_code=429)
    row = service.snapshot("node-1")["node-1"]
    assert row["total_requests"] == 3
    assert row["success_requests"] == 1
    assert row["error_requests"] == 2
    assert row["status_403"] == 1
    assert row["status_429"] == 1
    assert pool.conn.executed == []


def test_cleanup_keeps_only_current_and_previous_six_days():
    pool = _Pool()
    service = ExitRequestStatsService(lambda: pool)
    assert asyncio.run(service.cleanup()) == 0
    sql, args = pool.conn.executed[-1]
    assert "CURRENT_DATE - 6" in sql
    assert args == ()
