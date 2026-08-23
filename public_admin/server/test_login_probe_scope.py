import pytest


@pytest.mark.anyio
@pytest.mark.parametrize("anyio_backend", ["asyncio"])
async def test_login_probe_failure_count_is_scoped_to_account(monkeypatch):
    from . import proxy_server

    captured = {}

    async def fake_count(username, hours=24):
        captured.update(username=username, hours=hours)
        return 5

    monkeypatch.setattr(
        proxy_server.db,
        "count_recent_login_password_failures_for_account",
        fake_count,
    )

    result = await proxy_server._count_recent_password_failures_for_login_guard(
        "104.23.172.93",
        "LGMY4139",
    )

    assert result == 5
    assert captured == {"username": "lgmy4139", "hours": 24}


@pytest.mark.anyio
@pytest.mark.parametrize("anyio_backend", ["asyncio"])
async def test_delayed_indexdata_followup_is_diagnostic_only(monkeypatch):
    from . import proxy_server

    calls = []

    async def fake_is_banned(_ip):
        return False

    async def forbidden_preban(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("delayed browser asset loading must not enter the pre-ban counter")

    monkeypatch.setattr(proxy_server, "_is_ip_banned_for_penalty", fake_is_banned)
    monkeypatch.setattr(proxy_server.db, "record_ip_preban_event", forbidden_preban)

    await proxy_server._record_missing_indexdata_followup("172.64.217.80", "zjy5302")

    assert calls == []
