import httpx
import pytest

from .probe import DEFAULT_SOURCE_PROBE_URL, SourceReachabilityProbe


class FakeClient:
    def __init__(self, response_or_error):
        self.response_or_error = response_or_error
        self.calls = []

    async def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if isinstance(self.response_or_error, Exception):
            raise self.response_or_error
        return self.response_or_error


@pytest.mark.anyio
async def test_probe_treats_unauthenticated_source_403_as_reachable():
    client = FakeClient(httpx.Response(403))
    probe = SourceReachabilityProbe()

    result = await probe.probe(client)

    assert result.reachable is True
    assert result.status_code == 403
    assert client.calls[0][0] == DEFAULT_SOURCE_PROBE_URL
    assert client.calls[0][1]["follow_redirects"] is True


@pytest.mark.anyio
async def test_probe_keeps_rate_limited_source_unavailable():
    result = await SourceReachabilityProbe().probe(FakeClient(httpx.Response(429)))

    assert result.reachable is False
    assert result.status_code == 429
    assert result.error == "HTTP 429"


@pytest.mark.anyio
async def test_probe_reports_transport_failure_without_status_code():
    result = await SourceReachabilityProbe().probe(FakeClient(httpx.ConnectTimeout("timed out")))

    assert result.reachable is False
    assert result.status_code is None
    assert result.error


@pytest.mark.anyio
async def test_probe_accepts_protocol_policy_timeout_overrides():
    client = FakeClient(httpx.Response(403))

    await SourceReachabilityProbe().probe(
        client,
        timeout_seconds=22,
        connect_timeout_seconds=10,
    )

    timeout = client.calls[0][1]["timeout"]
    assert timeout.read == 22
    assert timeout.connect == 10
