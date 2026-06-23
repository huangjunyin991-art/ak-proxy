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
    assert config["proxies"][0]["servername"] == "update.microsoft.com"
    assert config["proxies"][0]["xhttp-opts"]["path"] == "/x"
    assert config["proxies"][0]["skip-cert-verify"] is True

