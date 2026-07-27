import json

from public_admin.server.singbox_manager import generate_config
from public_admin.server.sub_parser import parse_subscription_text


def _hysteria2_outbound(config: dict) -> dict:
    return next(item for item in config["outbounds"] if item["type"] == "hysteria2")


def test_hysteria2_uri_preserves_port_hopping_and_obfuscation():
    result = parse_subscription_text(
        "hysteria2://secret@hy2.example.com:20000"
        "?sni=cdn.example.com&insecure=0&mport=20000-40000"
        "&obfs=salamander&obfs-password=mask#HY2"
    )

    assert result["total_nodes"] == 1
    outbound = _hysteria2_outbound(generate_config(result["nodes"]))
    assert outbound["server_ports"] == ["20000:40000"]
    assert outbound["obfs"] == {"type": "salamander", "password": "mask"}
    assert outbound["tls"]["server_name"] == "cdn.example.com"


def test_native_singbox_subscription_filters_info_nodes_and_keeps_outbound():
    native_config = {
        "outbounds": [
            {
                "type": "hysteria2",
                "tag": "剩余流量：100 GB",
                "server": "hy2.example.com",
                "server_port": 20000,
                "password": "info",
                "tls": {"enabled": True},
            },
            {
                "type": "hysteria2",
                "tag": "HY2",
                "server": "hy2.example.com",
                "server_port": 20000,
                "server_ports": ["20000:40000"],
                "hop_interval": "30s",
                "up_mbps": 0,
                "down_mbps": 0,
                "password": "secret",
                "obfs": {"type": "salamander", "password": "mask"},
                "tls": {
                    "enabled": True,
                    "insecure": False,
                    "server_name": "cdn.example.com",
                },
            },
            {"type": "direct", "tag": "direct"},
        ],
    }

    result = parse_subscription_text(json.dumps(native_config, ensure_ascii=False))

    assert result["format"] == "singbox_json"
    assert result["total_nodes"] == 1
    outbound = _hysteria2_outbound(generate_config(result["nodes"]))
    assert outbound["server_ports"] == ["20000:40000"]
    assert outbound["hop_interval"] == "30s"
    assert outbound["obfs"] == {"type": "salamander", "password": "mask"}
    assert outbound["up_mbps"] == 0
    assert outbound["down_mbps"] == 0
