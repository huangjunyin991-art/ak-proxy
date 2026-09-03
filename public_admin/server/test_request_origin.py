from .active_defense.request_origin import RequestOriginResolver, resolve_defense_client_ip


def test_trusted_loopback_proxy_uses_nginx_real_ip():
    resolver = RequestOriginResolver()

    assert resolver.resolve({"x-real-ip": "198.51.100.10"}, "127.0.0.1") == "198.51.100.10"


def test_untrusted_peer_cannot_choose_penalty_ip_with_forwarded_headers():
    resolver = RequestOriginResolver()

    assert resolver.resolve(
        {"x-real-ip": "198.51.100.10", "x-forwarded-for": "198.51.100.11"},
        "203.0.113.9",
    ) == "203.0.113.9"


def test_first_party_internal_request_has_no_public_penalty_ip():
    resolver = RequestOriginResolver()

    assert resolve_defense_client_ip(
        resolver,
        {"x-real-ip": "152.32.216.95"},
        "127.0.0.1",
        first_party_internal=True,
    ) == "unknown"


def test_loopback_proxy_falls_back_to_the_rightmost_forwarded_client_ip():
    resolver = RequestOriginResolver()

    assert resolver.resolve(
        {"x-forwarded-for": "198.51.100.10, 203.0.113.7"},
        "127.0.0.1",
    ) == "203.0.113.7"


def test_cloudflare_edge_address_is_never_used_as_a_penalty_bucket():
    resolver = RequestOriginResolver()

    assert resolver.resolve({"x-real-ip": "162.159.113.53"}, "127.0.0.1") == "unknown"
    assert resolver.resolve({"x-forwarded-for": "172.71.158.114"}, "127.0.0.1") == "unknown"


def test_real_client_address_remains_usable_after_cloudflare_realip_restoration():
    resolver = RequestOriginResolver()

    assert resolver.resolve({"x-real-ip": "203.0.113.10"}, "127.0.0.1") == "203.0.113.10"
