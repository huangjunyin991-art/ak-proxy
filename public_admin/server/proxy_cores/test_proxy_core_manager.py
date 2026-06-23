from public_admin.server.proxy_cores.classifier import classify_node, prepare_nodes
from public_admin.server.proxy_cores.manager import build_runtime_nodes


def test_classifies_mixed_subscription_nodes_by_capability():
    nodes = prepare_nodes([
        {
            "name": "HK xhttp",
            "type": "vless",
            "server": "hk.example.com",
            "port": 443,
            "group_id": "g1",
            "raw": {"type": "vless", "uuid": "u", "network": "xhttp", "tls": True},
        },
        {
            "name": "AnyTLS",
            "type": "anytls",
            "server": "sg.example.com",
            "port": 443,
            "group_id": "g1",
            "raw": {"type": "anytls", "password": "p"},
        },
        {
            "name": "Info",
            "type": "trojan",
            "server": "0.0.0.0",
            "port": 443,
            "group_id": "g1",
            "raw": {"type": "trojan", "password": "p", "network": "ws"},
        },
    ])

    assert nodes[0]["core_type"] == "mihomo"
    assert nodes[0]["core_supported"] is True
    assert nodes[1]["core_type"] == "singbox"
    assert nodes[1]["core_supported"] is True
    assert nodes[2]["core_type"] == "unsupported"
    assert nodes[2]["core_supported"] is False


def test_build_runtime_nodes_assigns_separate_port_ranges():
    runtime_nodes = build_runtime_nodes([
        {
            "name": "HK xhttp",
            "type": "vless",
            "server": "hk.example.com",
            "port": 443,
            "group_id": "g1",
            "raw": {"type": "vless", "uuid": "u", "network": "xhttp", "tls": True},
        },
        {
            "name": "AnyTLS",
            "type": "anytls",
            "server": "sg.example.com",
            "port": 443,
            "group_id": "g1",
            "raw": {"type": "anytls", "password": "p"},
        },
    ], singbox_base_port=10001, mihomo_base_port=11001)

    singbox = [item for item in runtime_nodes if item["core_type"] == "singbox"]
    mihomo = [item for item in runtime_nodes if item["core_type"] == "mihomo"]
    assert singbox[0]["local_port"] == 10001
    assert mihomo[0]["local_port"] == 11001


def test_placeholder_node_is_not_runnable():
    result = classify_node({
        "name": "placeholder",
        "type": "trojan",
        "server": "0.0.0.0",
        "port": 443,
        "raw": {"type": "trojan", "network": "ws"},
    })
    assert result["core_type"] == "unsupported"
    assert result["supported"] is False
    assert result["reason"] == "placeholder_server"

