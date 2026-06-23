from public_admin.server.proxy_cores.mihomo_core import generate_config


def test_mihomo_xhttp_node_uses_dedicated_socks_listener():
    config = generate_config([
        {
            "name": "HK xhttp",
            "type": "vless",
            "server": "hk.example.com",
            "port": 443,
            "local_port": 11001,
            "raw": {
                "type": "vless",
                "uuid": "00000000-0000-0000-0000-000000000000",
                "network": "xhttp",
                "tls": True,
                "servername": "update.microsoft.com",
                "path": "/x",
                "skip-cert-verify": True,
            },
        }
    ], base_port=11001)

    assert config["listeners"][0]["type"] == "socks"
    assert config["listeners"][0]["port"] == 11001
    assert config["listeners"][0]["proxy"] == "proxy-out-0"
    assert config["proxies"][0]["type"] == "vless"
    assert config["proxies"][0]["network"] == "xhttp"
    assert config["proxies"][0]["encryption"] == ""
    assert config["proxies"][0]["servername"] == "update.microsoft.com"
    assert config["proxies"][0]["client-fingerprint"] == "chrome"
    assert config["proxies"][0]["xhttp-opts"]["path"] == "/x"
    assert config["proxies"][0]["xhttp-opts"]["host"] == "update.microsoft.com"
    assert config["proxies"][0]["skip-cert-verify"] is True


def test_mihomo_vless_reality_options_are_mapped():
    config = generate_config([
        {
            "name": "Reality xhttp",
            "type": "vless",
            "server": "reality.example.com",
            "port": 443,
            "raw": {
                "type": "vless",
                "uuid": "00000000-0000-0000-0000-000000000000",
                "network": "xhttp",
                "security": "reality",
                "sni": "www.microsoft.com",
                "fp": "chrome",
                "pbk": "public-key",
                "sid": "abcd",
                "alpn": "h2,http/1.1",
            },
        }
    ])

    proxy = config["proxies"][0]
    assert proxy["tls"] is True
    assert proxy["servername"] == "www.microsoft.com"
    assert proxy["client-fingerprint"] == "chrome"
    assert proxy["alpn"] == ["h2", "http/1.1"]
    assert proxy["reality-opts"] == {"public-key": "public-key", "short-id": "abcd"}


def test_mihomo_normalizes_httpx_alias_to_xhttp():
    config = generate_config([
        {
            "name": "HTTPX alias",
            "type": "vless",
            "server": "hk.example.com",
            "port": 443,
            "raw": {
                "type": "vless",
                "uuid": "00000000-0000-0000-0000-000000000000",
                "network": "httpx",
                "tls": True,
            },
        }
    ])

    assert config["proxies"][0]["network"] == "xhttp"
    assert config["proxies"][0]["xhttp-opts"]["host"] == "hk.example.com"
