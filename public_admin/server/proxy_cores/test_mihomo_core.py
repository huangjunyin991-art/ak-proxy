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
                "mode": "stream-up",
                "extra": '{"downloadSettings":{"path":"/x","server":"download.example.com","port":443,"servername":"update.microsoft.com"}}',
                "skip-cert-verify": True,
            },
        }
    ], base_port=11001)

    assert config["listeners"][0]["type"] == "socks"
    assert config["listeners"][0]["port"] == 11001
    assert config["rules"][0] == "IN-NAME,socks-in-0,proxy-out-0"
    assert config["rules"][-1] == "MATCH,DIRECT"
    assert config["proxies"][0]["type"] == "vless"
    assert config["proxies"][0]["network"] == "xhttp"
    assert config["proxies"][0]["encryption"] == ""
    assert config["proxies"][0]["servername"] == "update.microsoft.com"
    assert config["proxies"][0]["alpn"] == ["h2"]
    assert config["proxies"][0]["client-fingerprint"] == "chrome"
    assert config["proxies"][0]["xhttp-opts"]["path"] == "/x"
    assert config["proxies"][0]["xhttp-opts"]["mode"] == "stream-up"
    assert config["proxies"][0]["xhttp-opts"]["host"] == "update.microsoft.com"
    assert config["proxies"][0]["xhttp-opts"]["download-settings"] == {
        "path": "/x",
        "server": "download.example.com",
        "port": 443,
        "servername": "update.microsoft.com",
    }
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
    assert config["proxies"][0]["skip-cert-verify"] is True


def test_mihomo_xhttp_keeps_cert_verify_when_explicit_server_name_exists():
    config = generate_config([
        {
            "name": "Explicit SNI",
            "type": "vless",
            "server": "hk.example.com",
            "port": 443,
            "raw": {
                "type": "vless",
                "uuid": "00000000-0000-0000-0000-000000000000",
                "network": "xhttp",
                "tls": True,
                "sni": "download.example.com",
            },
        }
    ])

    assert config["proxies"][0]["servername"] == "download.example.com"
    assert "skip-cert-verify" not in config["proxies"][0]


def test_mihomo_maps_singbox_style_shadow_tls_shadowsocks():
    config = generate_config([{
        "name": "ShadowTLS SS",
        "type": "shadowsocks",
        "server": "ss.example.com",
        "port": 443,
        "local_port": 12001,
        "raw": {"type": "shadowsocks"},
        "outbound_config": {
            "type": "shadowsocks",
            "server": "ss.example.com",
            "server_port": 443,
            "method": "2022-blake3-aes-256-gcm",
            "password": "ss-secret",
            "plugin": "shadow-tls",
            "plugin_opts": "host=www.microsoft.com;password=shadow-secret;version=3",
        },
    }], base_port=12001)

    assert config["listeners"][0]["port"] == 12001
    assert config["proxies"][0] == {
        "name": "proxy-out-0",
        "type": "ss",
        "server": "ss.example.com",
        "port": 443,
        "cipher": "2022-blake3-aes-256-gcm",
        "password": "ss-secret",
        "udp": True,
        "plugin": "shadow-tls",
        "plugin-opts": {
            "host": "www.microsoft.com",
            "password": "shadow-secret",
            "version": 3,
        },
    }


def test_mihomo_parses_inline_sip003_plugin_options():
    config = generate_config([{
        "name": "Inline plugin",
        "type": "ss",
        "server": "ss.example.com",
        "port": 443,
        "raw": {
            "type": "ss",
            "cipher": "aes-128-gcm",
            "password": "ss-secret",
            "plugin": "shadow-tls;host=www.apple.com;password=shadow-secret;version=3",
        },
    }])

    proxy = config["proxies"][0]
    assert proxy["plugin"] == "shadow-tls"
    assert proxy["plugin-opts"] == {
        "host": "www.apple.com",
        "password": "shadow-secret",
        "version": 3,
    }
