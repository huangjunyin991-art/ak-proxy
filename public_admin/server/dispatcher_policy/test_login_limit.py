import pytest

from .login_limit import (
    DEFAULT_MAX_LOGIN_PER_MIN,
    MAX_LOGIN_PER_MIN_CONFIG_KEY,
    load_max_login_per_min,
    normalize_max_login_per_min,
    save_max_login_per_min,
)


class FakeSystemConfig:
    def __init__(self, value=None, set_result=True):
        self.value = value
        self.set_result = set_result
        self.calls = []

    async def get(self, key, default=None):
        self.calls.append(("get", key, default))
        return self.value if self.value is not None else default

    async def set(self, key, value, description=""):
        self.calls.append(("set", key, value, description))
        if self.set_result:
            self.value = value
        return self.set_result


def test_normalize_invalid_value_uses_default():
    assert normalize_max_login_per_min("bad") == DEFAULT_MAX_LOGIN_PER_MIN
    assert normalize_max_login_per_min(0, 7) == 7
    assert normalize_max_login_per_min(12) == 12


@pytest.mark.asyncio
async def test_load_saved_limit_and_fallback_for_invalid_value():
    config = FakeSystemConfig(17)
    assert await load_max_login_per_min(config) == 17
    config.value = 0
    assert await load_max_login_per_min(config) == DEFAULT_MAX_LOGIN_PER_MIN


@pytest.mark.asyncio
async def test_save_valid_limit_and_reject_invalid_without_write():
    config = FakeSystemConfig(10)
    assert await save_max_login_per_min(config, 23)
    assert config.value == 23
    calls_before = len(config.calls)
    assert not await save_max_login_per_min(config, 0)
    assert len(config.calls) == calls_before
    assert config.calls[-1][1] == MAX_LOGIN_PER_MIN_CONFIG_KEY
