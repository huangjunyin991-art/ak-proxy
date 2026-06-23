from public_admin.server.sub_parser import parse_subscription_text


def test_clash_xhttp_download_settings_are_preserved():
    text = """
proxies:
  - name: HK xhttp
    type: vless
    server: hk.example.com
    port: 443
    uuid: 00000000-0000-0000-0000-000000000000
    tls: true
    skip-cert-verify: true
    servername: update.microsoft.com
    network: xhttp
    xhttp-opts:
      path: /path
      mode: stream-up
      download-settings:
        path: /path
        server: download.example.com
        port: 443
        servername: update.microsoft.com
"""

    result = parse_subscription_text(text)
    raw = result["nodes"][0]["raw"]

    assert result["format"] == "clash_yaml"
    assert raw["xhttp-opts"]["mode"] == "stream-up"
    assert raw["xhttp-opts"]["download-settings"]["server"] == "download.example.com"


def test_vless_xhttp_extra_download_settings_are_preserved():
    text = (
        "vless://00000000-0000-0000-0000-000000000000@hk.example.com:443"
        "?type=xhttp&encryption=none&path=%2Fpath&security=tls&allowInsecure=1"
        "&sni=update.microsoft.com&mode=stream-up"
        "&extra=%7B%22downloadSettings%22%3A%7B%22path%22%3A%22%2Fpath%22%2C"
        "%22server%22%3A%22download.example.com%22%2C%22port%22%3A443%2C"
        "%22servername%22%3A%22update.microsoft.com%22%7D%7D#HK"
    )

    result = parse_subscription_text(text)
    raw = result["nodes"][0]["raw"]

    assert result["format"] == "proxy_links"
    assert raw["encryption"] == "none"
    assert raw["xhttp-opts"]["mode"] == "stream-up"
    assert raw["xhttp-opts"]["download-settings"]["server"] == "download.example.com"
