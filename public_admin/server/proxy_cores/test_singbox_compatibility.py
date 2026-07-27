from public_admin.server.proxy_cores.singbox_compatibility import normalize_singbox_outbound
from public_admin.server.singbox_manager import generate_config


def _native_node(outbound: dict) -> dict:
    return {
        "name": "provider node",
        "type": outbound["type"],
        "server": outbound["server"],
        "port": outbound["server_port"],
        "raw": {},
        "outbound_config": outbound,
    }


def test_anytls_h3_only_alpn_is_removed_from_runtime_config_without_mutating_source():
    source = {
        "type": "anytls",
        "tag": "provider tag",
        "server": "anytls.example.com",
        "server_port": 443,
        "password": "secret",
        "tls": {
            "enabled": True,
            "server_name": "cdn.example.com",
            "alpn": ["h3"],
        },
    }

    outbound = generate_config([_native_node(source)])["outbounds"][0]

    assert "alpn" not in outbound["tls"]
    assert outbound["tag"] == "proxy-out-0"
    assert source["tls"]["alpn"] == ["h3"]
    assert source["tag"] == "provider tag"


def test_anytls_mixed_alpn_is_preserved():
    source = {
        "type": "anytls",
        "server": "anytls.example.com",
        "server_port": 443,
        "tls": {"enabled": True, "alpn": ["h3", "h2"]},
    }

    normalized = normalize_singbox_outbound(source)

    assert normalized["tls"]["alpn"] == ["h3", "h2"]


def test_h3_alpn_is_preserved_for_quic_protocols():
    for protocol in ("hysteria2", "tuic"):
        source = {
            "type": protocol,
            "server": f"{protocol}.example.com",
            "server_port": 443,
            "tls": {"enabled": True, "alpn": ["h3"]},
        }

        normalized = normalize_singbox_outbound(source)

        assert normalized["tls"]["alpn"] == ["h3"]
