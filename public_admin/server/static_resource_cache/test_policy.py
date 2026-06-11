import asyncio
from pathlib import Path

from .config import StaticResourceCacheConfig
from .models import StaticResourcePayload, StaticResourceRequest
from .policy import StaticResourceCachePolicy
from .service import create_static_resource_cache_service


def _policy() -> StaticResourceCachePolicy:
    return StaticResourceCachePolicy(
        StaticResourceCacheConfig(
            root_dir=Path("unused"),
            cacheable_html_paths={"/pages/subpages/notice.html"},
        )
    )


def test_cacheable_html_whitelist_can_read_and_store():
    request = StaticResourceRequest(
        method="GET",
        namespace="/public-static-v2",
        url="https://k937.com/pages/subpages/notice.html",
        path="pages/subpages/notice.html",
    )
    payload = StaticResourcePayload(
        status_code=200,
        headers={},
        policy_headers={"content-type": "text/html; charset=utf-8"},
        content_type="text/html; charset=utf-8",
        body=b"<html></html>",
    )

    policy = _policy()

    assert policy.can_read(request)
    assert policy.can_store(request, payload)


def test_non_whitelisted_html_stays_uncacheable():
    request = StaticResourceRequest(
        method="GET",
        namespace="/public-static-v2",
        url="https://k937.com/pages/account/login.html",
        path="pages/account/login.html",
    )
    payload = StaticResourcePayload(
        status_code=200,
        headers={},
        policy_headers={"content-type": "text/html; charset=utf-8"},
        content_type="text/html; charset=utf-8",
        body=b"<html></html>",
    )

    policy = _policy()

    assert not policy.can_read(request)
    assert not policy.can_store(request, payload)


def test_cacheable_html_still_rejects_sensitive_query():
    request = StaticResourceRequest(
        method="GET",
        namespace="/public-static-v2",
        url="https://k937.com/pages/subpages/notice.html?userkey=secret",
        path="pages/subpages/notice.html",
    )

    assert not _policy().can_read(request)


def test_hydrate_memory_from_disk_restores_cached_asset(tmp_path):
    service = create_static_resource_cache_service(
        StaticResourceCacheConfig(
            root_dir=tmp_path,
            memory_max_entries=8,
            memory_max_bytes=1024 * 1024,
            memory_max_body_bytes=128 * 1024,
        )
    )
    request = StaticResourceRequest(
        method="GET",
        namespace="/public-static-v2",
        url="https://k937.com/assets/images/center/icon6.svg",
        path="/assets/images/center/icon6.svg",
    )
    payload = StaticResourcePayload(
        status_code=200,
        headers={"content-type": "image/svg+xml"},
        policy_headers={"content-type": "image/svg+xml"},
        content_type="image/svg+xml",
        body=b"<svg></svg>",
    )

    async def _run():
        assert await service.store_payload(request, payload)
        service.memory_cache.clear()
        assert service.memory_cache.snapshot()["entries"] == 0
        hydration = await service.hydrate_memory_from_disk(reason="test")
        assert hydration["loaded"] == 1
        assert service.memory_cache.snapshot()["entries"] == 1
        assert await service.get(request) is not None

    asyncio.run(_run())
