from public_admin.server.proxy_cores.classifier import classify_node
from public_admin.server.singbox_manager import generate_config
from public_admin.server.sub_parser import parse_subscription_text


def test_mixed_subscription_keeps_tuic_vless_and_shadowsocks_nodes():
    text = "\n".join([
        "vless://00000000-0000-0000-0000-000000000000@vless.example.com:443?encryption=none&type=tcp&security=tls#VLESS",
        "tuic://11111111-1111-1111-1111-111111111111:secret@tuic.example.com:443?congestion_control=bbr&udp_relay_mode=native&alpn=h3%2Ch2&sni=cdn.example.com#TUIC",
        "ss://YWVzLTEyOC1nY206c2VjcmV0@ss.example.com:443#SS",
    ])

    result = parse_subscription_text(text)

    assert result["total_nodes"] == 3
    assert {node["type"] for node in result["nodes"]} == {"vless", "tuic", "ss"}


def test_tuic_node_builds_a_singbox_outbound_and_is_supported():
    result = parse_subscription_text(
        "tuic://11111111-1111-1111-1111-111111111111:secret@tuic.example.com:443"
        "?congestion_control=bbr&udp_relay_mode=native&zero_rtt_handshake=true"
        "&alpn=h3%2Ch2&sni=cdn.example.com#TUIC"
    )
    node = result["nodes"][0]
    config = generate_config([node])
    outbound = next(item for item in config["outbounds"] if item["type"] == "tuic")

    assert classify_node(node)["supported"] is True
    assert outbound["uuid"] == "11111111-1111-1111-1111-111111111111"
    assert outbound["congestion_control"] == "bbr"
    assert outbound["udp_relay_mode"] == "native"
    assert outbound["zero_rtt_handshake"] is True
    assert outbound["tls"]["server_name"] == "cdn.example.com"
    assert outbound["tls"]["alpn"] == ["h3", "h2"]


def test_json_shadowsocks_keeps_plugin_options_for_core_routing():
    result = parse_subscription_text(
        '{"nodes":[{"name":"ShadowTLS","type":"ss","server":"ss.example.com",'
        '"port":443,"cipher":"2022-blake3-aes-256-gcm","password":"ss-secret",'
        '"plugin":"shadow-tls","plugin_opts":"host=www.microsoft.com;password=st-secret;version=3"}]}'
    )
    node = result["nodes"][0]

    assert node["raw"]["plugin-opts"] == "host=www.microsoft.com;password=st-secret;version=3"
    assert classify_node(node)["core_type"] == "mihomo"
