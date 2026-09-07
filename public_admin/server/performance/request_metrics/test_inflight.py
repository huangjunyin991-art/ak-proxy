import time

from .inflight import InFlightRequestRegistry


def test_inflight_registry_tracks_stage_and_age():
    registry = InFlightRequestRegistry(max_records=100)
    request_id = registry.begin("post", "/api/transparent_proxy/ACE_Sell")
    assert registry.update(request_id, "request_send_started", exit_name="node-a")

    rows = registry.snapshot()
    assert len(rows) == 1
    assert rows[0]["request_id"] == request_id
    assert rows[0]["method"] == "POST"
    assert rows[0]["stage"] == "request_send_started"
    assert rows[0]["exit_name"] == "node-a"
    assert rows[0]["age_ms"] >= 0
    assert rows[0]["idle_ms"] >= 0

    time.sleep(0.005)
    assert registry.snapshot(stale_after_ms=1)[0]["request_id"] == request_id
    assert registry.finish(request_id)
    assert registry.count() == 0


def test_inflight_registry_evicts_oldest_when_full():
    registry = InFlightRequestRegistry(max_records=100)
    registry.max_records = 1
    first = registry.begin("GET", "/first")
    time.sleep(0.001)
    second = registry.begin("GET", "/second")

    assert registry.count() == 1
    assert registry.snapshot()[0]["request_id"] == second
    assert not registry.finish(first)
    assert registry.finish(second)
