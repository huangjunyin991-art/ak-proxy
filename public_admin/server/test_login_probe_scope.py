import pytest
from starlette.requests import Request


def _login_request(*, token: str = "", ui_header: str = "") -> Request:
    headers = []
    if ui_header:
        headers.append((b"x-ak-login-ui", ui_header.encode("ascii")))
    if token:
        headers.append((b"cookie", f"ak_login_ui={token}".encode("ascii")))
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/RPC/Login",
            "raw_path": b"/RPC/Login",
            "query_string": b"",
            "headers": headers,
            "client": ("192.0.2.10", 12345),
            "server": ("testserver", 443),
            "scheme": "https",
        }
    )


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
async def test_delayed_indexdata_followup_counts_only_unverified_api(monkeypatch):
    from . import proxy_server

    calls = []

    async def fake_is_banned(_ip):
        return False

    async def record_preban(*args, **kwargs):
        calls.append((args, kwargs))
        return {"count": 1, "is_banned": False}

    monkeypatch.setattr(proxy_server, "_is_ip_banned_for_penalty", fake_is_banned)
    monkeypatch.setattr(proxy_server.db, "record_ip_preban_event", record_preban)

    await proxy_server._record_missing_indexdata_followup("172.64.217.80", "zjy5302")

    assert len(calls) == 1


def test_login_success_followup_requires_verified_frontend(monkeypatch):
    from . import proxy_server

    calls = []
    monkeypatch.setattr(
        proxy_server,
        "_mark_indexdata_followup_seen",
        lambda *args: calls.append(("browser", args)),
    )
    monkeypatch.setattr(
        proxy_server,
        "_track_login_indexdata_followup",
        lambda *args: calls.append(("api", args)),
    )

    # Cached user-key authentication must still be classified as an API login
    # when the signed login-page proof is absent.
    proxy_server._register_login_success_followup(
        "192.0.2.10",
        "api-user",
        frontend_authenticated=False,
    )
    proxy_server._register_login_success_followup(
        "192.0.2.10",
        "browser-user",
        frontend_authenticated=True,
    )

    assert calls == [
        ("api", ("192.0.2.10", "api-user")),
        ("browser", ("192.0.2.10", "browser-user")),
    ]


def test_login_ui_proof_requires_signed_cookie_and_marker():
    from . import proxy_server

    token = proxy_server.login_ui_token_service.issue()

    assert proxy_server._is_verified_login_ui_request(
        _login_request(token=token, ui_header="1")
    )
    assert not proxy_server._is_verified_login_ui_request(
        _login_request(token=token)
    )
    assert not proxy_server._is_verified_login_ui_request(
        _login_request(token="tampered", ui_header="1")
    )
