import httpx
import pytest

from .login_fastpath import AkUserKeyLoginFastPath


@pytest.mark.anyio
async def test_fastpath_validation_uses_short_timeout_and_refreshes_auth():
    calls = []
    saved = []

    async def load_auth(_account):
        return {
            "userkey": "cached-key",
            "login_result": {"Error": False, "UserData": {"Id": 123}},
            "cookies": {"sid": "cookie"},
        }

    async def save_auth(*args, **kwargs):
        saved.append((args, kwargs))

    async def forward(*args, **kwargs):
        calls.append((args, kwargs))
        return httpx.Response(200, json={"Error": False, "Data": {"ACECount": 1}})

    service = AkUserKeyLoginFastPath(
        load_auth_state=load_auth,
        save_auth_state=save_auth,
        forward_request=forward,
        ttl_seconds=3600,
        validation_timeout_seconds=3,
    )

    result = await service.try_login(username="demo", password="secret")

    assert result.success is True
    assert calls[0][1]["request_timeout_seconds"] == 3.0
    assert saved


@pytest.mark.anyio
async def test_fastpath_timeout_is_clamped_to_five_seconds():
    async def load_auth(_account):
        return {"userkey": "cached-key", "login_result": {"UserData": {"Id": 123}}}

    async def save_auth(*_args, **_kwargs):
        return None

    observed = []

    async def forward(*_args, **kwargs):
        observed.append(kwargs["request_timeout_seconds"])
        raise TimeoutError("probe timeout")

    service = AkUserKeyLoginFastPath(
        load_auth_state=load_auth,
        save_auth_state=save_auth,
        forward_request=forward,
        ttl_seconds=3600,
        validation_timeout_seconds=99,
    )

    result = await service.try_login(username="demo")

    assert result.success is False
    assert observed == [5.0]
