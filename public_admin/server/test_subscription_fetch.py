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
    assert len(seen_user_agents) == len(SUBSCRIPTION_FETCH_PROFILES)
    assert {item["profile"] for item in result["fetch_attempts"]} == {
        profile.identifier for profile in SUBSCRIPTION_FETCH_PROFILES
    }


def test_subscription_log_target_excludes_the_subscription_token():
    target = sub_parser._subscription_log_target("https://subscription.example.com/s/secret-token?key=secret")

    assert target == "subscription.example.com"
    assert "secret" not in target
