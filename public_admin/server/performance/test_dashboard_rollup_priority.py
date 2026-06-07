import asyncio
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from public_admin.server.performance.admin_summary.repository import fetch_admin_summary_row
from public_admin.server.performance.dashboard_stats.repository import fetch_traffic_dashboard_row


class RollupOnlyConnection:
    def __init__(self, row):
        self.row = row
        self.fetchval_calls = 0

    async def fetchrow(self, query, *args):
        return dict(self.row)

    async def fetchval(self, query, *args):
        self.fetchval_calls += 1
        raise AssertionError("legacy checks should not run when rollup already has data")


async def test_dashboard_prefers_populated_rollup_before_backfill_ready():
    conn = RollupOnlyConnection({
        "total": 8,
        "success": 7,
        "active_users": 3,
        "peak_rpm": 2,
        "hourly_data_json": "[]",
        "top_users_json": "[]",
        "top_ips_json": "[]",
    })
    row = await fetch_traffic_dashboard_row(conn, date(2026, 6, 8), date(2026, 6, 9))
    assert row["total"] == 8
    assert conn.fetchval_calls == 0


async def test_admin_summary_prefers_populated_rollup_before_backfill_ready():
    conn = RollupOnlyConnection({
        "total_users": 10,
        "total_ips": 4,
        "today_logins": 8,
        "banned_count": 1,
        "total_logins": 200,
        "total_ace": 0,
        "total_ep": 0,
        "total_sp": 0,
        "total_rp": 0,
        "total_tp": 0,
    })
    row = await fetch_admin_summary_row(conn, date(2026, 6, 8), date(2026, 6, 9))
    assert row["total_logins"] == 200
    assert conn.fetchval_calls == 0


async def main():
    await test_dashboard_prefers_populated_rollup_before_backfill_ready()
    await test_admin_summary_prefers_populated_rollup_before_backfill_ready()


if __name__ == "__main__":
    asyncio.run(main())
