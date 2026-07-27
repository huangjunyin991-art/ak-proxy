from public_admin.server import sub_parser
from public_admin.server.subscription_fetch.profiles import SUBSCRIPTION_FETCH_PROFILES


def _vless_links(count: int) -> str:
    return "\n".join(
        "vless://00000000-0000-0000-0000-000000000000@node{index}.example.com:443"
        "?encryption=none&type=tcp&security=tls#Node{index}".format(index=index)
        for index in range(count)
    )


def test_subscription_fetches_all_profiles_and_keeps_largest_result(monkeypatch):
    counts = {
        "v2rayN/7.2.3": 4,
        "ClashMetaForAndroid/2.11.8.Meta": 6,
        "sing-box 1.10.0": 2,
    }
    seen_user_agents = []

    def fake_fetch_text(url: str, timeout: int, user_agent: str) -> str:
        seen_user_agents.append(user_agent)
        return _vless_links(counts.get(user_agent, 1))

    monkeypatch.setattr(sub_parser, "_fetch_subscription_text", fake_fetch_text)

    result = sub_parser.fetch_subscription("https://subscription.example.com/token")

    assert result["total_nodes"] == 6
    assert result["fetch_profile"] == "clash_meta"
    assert result["fetch_route"] == "direct"
    assert result["fetch_tunnel_fallback_attempted"] is False
    assert len(seen_user_agents) == len(SUBSCRIPTION_FETCH_PROFILES)
    assert {item["profile"] for item in result["fetch_attempts"]} == {
        profile.identifier for profile in SUBSCRIPTION_FETCH_PROFILES
    }


def test_subscription_log_target_excludes_the_subscription_token():
    target = sub_parser._subscription_log_target("https://subscription.example.com/s/secret-token?key=secret")

    assert target == "subscription.example.com"
    assert "secret" not in target


def test_subscription_fetch_retries_empty_direct_response_through_tunnel(monkeypatch):
    direct_user_agents = []
    tunnel_attempts = []

    def fake_direct_fetch(url: str, timeout: int, user_agent: str) -> str:
        direct_user_agents.append(user_agent)
        return "<!DOCTYPE html><html><body>Checking your browser</body></html>"

    def fake_tunnel_fetch(url: str, timeout: int, user_agent: str, proxy_url: str) -> str:
        tunnel_attempts.append((user_agent, proxy_url))
        return _vless_links(3 if user_agent == "v2rayN/7.2.3" else 1)

    monkeypatch.setattr(sub_parser, "_fetch_subscription_text", fake_direct_fetch)
    monkeypatch.setattr(sub_parser, "_fetch_subscription_text_via_tunnel", fake_tunnel_fetch)

    result = sub_parser.fetch_subscription(
        "https://subscription.example.com/token",
        tunnel_candidates=[
            {"name": "first", "proxy_url": "socks5://127.0.0.1:10001"},
            {"name": "second", "proxy_url": "socks5://127.0.0.1:10002"},
        ],
    )

    assert result["total_nodes"] == 3
    assert result["fetch_route"] == "node_tunnel"
    assert result["fetch_tunnel_fallback_attempted"] is True
    assert result["fetch_tunnel_attempt_count"] == 1
    assert len(direct_user_agents) == len(SUBSCRIPTION_FETCH_PROFILES)
    assert len(tunnel_attempts) == len(SUBSCRIPTION_FETCH_PROFILES)
    assert {proxy_url for _, proxy_url in tunnel_attempts} == {"socks5://127.0.0.1:10001"}


def test_subscription_fetch_keeps_direct_error_when_all_tunnels_return_empty(monkeypatch):
    monkeypatch.setattr(
        sub_parser,
        "_fetch_subscription_text",
        lambda url, timeout, user_agent: "<!DOCTYPE html><html></html>",
    )
    monkeypatch.setattr(
        sub_parser,
        "_fetch_subscription_text_via_tunnel",
        lambda url, timeout, user_agent, proxy_url: "<!DOCTYPE html><html></html>",
    )

    result = sub_parser.fetch_subscription(
        "https://subscription.example.com/token",
        tunnel_candidates=[{"name": "only", "proxy_url": "socks5://127.0.0.1:10001"}],
    )

    assert result["fetch_route"] == "direct"
    assert result["fetch_tunnel_fallback_attempted"] is True
    assert result["fetch_tunnel_attempt_count"] == 1
    assert result["response_kind"] == "html"
    assert result["error"]
