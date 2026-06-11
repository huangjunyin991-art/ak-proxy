from pathlib import Path

from .config import StaticResourceCacheConfig
from .models import StaticResourcePayload, StaticResourceRequest
from .policy import StaticResourceCachePolicy


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
