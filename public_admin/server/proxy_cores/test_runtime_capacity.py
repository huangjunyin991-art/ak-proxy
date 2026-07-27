import pytest

from public_admin.server.proxy_cores import runtime


class _FakeResource:
    RLIMIT_NOFILE = 7
    RLIM_INFINITY = -1

    def __init__(self, soft: int, hard: int):
        self.limit = (soft, hard)
        self.set_calls = []

    def getrlimit(self, resource_id):
        assert resource_id == self.RLIMIT_NOFILE
        return self.limit

    def setrlimit(self, resource_id, limit):
        assert resource_id == self.RLIMIT_NOFILE
        self.set_calls.append(limit)
        self.limit = limit


def test_file_descriptor_soft_limit_is_raised_for_large_generation(monkeypatch):
    resource = _FakeResource(soft=512, hard=65_536)
    monkeypatch.setattr(runtime, "_load_resource_module", lambda: resource)

    result = runtime.ensure_file_descriptor_capacity(528)

    assert resource.set_calls == [(4096, 65_536)]
    assert result == {"supported": True, "soft": 4096, "hard": 65_536, "required": 784}


def test_file_descriptor_hard_limit_reports_specific_capacity_error(monkeypatch):
    resource = _FakeResource(soft=512, hard=700)
    monkeypatch.setattr(runtime, "_load_resource_module", lambda: resource)

    with pytest.raises(RuntimeError, match="文件描述符上限不足.*至少需要 784"):
        runtime.ensure_file_descriptor_capacity(528)


def test_file_descriptor_capacity_is_optional_on_unsupported_platform(monkeypatch):
    monkeypatch.setattr(runtime, "_load_resource_module", lambda: None)

    assert runtime.ensure_file_descriptor_capacity(528)["supported"] is False


def test_empty_generation_needs_no_descriptor_headroom(monkeypatch):
    resource = _FakeResource(soft=128, hard=128)
    monkeypatch.setattr(runtime, "_load_resource_module", lambda: resource)

    result = runtime.ensure_file_descriptor_capacity(0)

    assert result["required"] == 0
