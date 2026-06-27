from public_admin.server.proxy_cores.classifier import classify_node, prepare_nodes
from public_admin.server.proxy_cores.manager import build_runtime_nodes
from public_admin.server.proxy_cores import singbox_core


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


def test_vless_xhttp_top_level_network_uses_mihomo():
    result = classify_node({
        "name": "top level xhttp",
        "type": "vless",
        "server": "hk.example.com",
        "port": 443,
        "network": "xhttp",
        "raw": {"type": "vless", "uuid": "u"},
    })
    assert result["core_type"] == "mihomo"
    assert result["supported"] is True


def test_vless_httpx_alias_uses_mihomo():
    result = classify_node({
        "name": "httpx typo alias",
        "type": "vless",
        "server": "hk.example.com",
        "port": 443,
        "raw": {"type": "vless", "uuid": "u", "network": "httpx"},
    })
    assert result["core_type"] == "mihomo"
    assert result["supported"] is True


def test_vless_xhttp_opts_without_network_uses_mihomo():
    result = classify_node({
        "name": "xhttp opts only",
        "type": "vless",
        "server": "hk.example.com",
        "port": 443,
        "raw": {"type": "vless", "uuid": "u", "xhttp-opts": {"path": "/x"}},
    })
    assert result["core_type"] == "mihomo"
    assert result["supported"] is True


def test_singbox_systemd_config_match_requires_generated_config():
    original = singbox_core._systemd_exec_start
    try:
        singbox_core._systemd_exec_start = lambda: "/usr/bin/sing-box run -c /etc/sing-box/config.json"
        assert singbox_core._systemd_uses_config("/root/sing-box/config.json") is False
        singbox_core._systemd_exec_start = lambda: "/root/.ak_proxy/proxy_cores/singbox/bin/sing-box run -c /root/sing-box/config.json"
        assert singbox_core._systemd_uses_config("/root/sing-box/config.json") is True
    finally:
        singbox_core._systemd_exec_start = original


def test_singbox_status_recovers_generated_config_process(monkeypatch):
    class DummyPidPath:
        def write_text(self, *args, **kwargs):
            return 4

    monkeypatch.setattr(singbox_core, "_read_pid", lambda: 0)
    monkeypatch.setattr(singbox_core, "_pid_is_running", lambda pid: pid == 1234)
    monkeypatch.setattr(singbox_core, "_find_managed_processes", lambda config_path: [1234])
    monkeypatch.setattr(singbox_core, "_tail_log", lambda max_chars=2000: "")
    monkeypatch.setattr(singbox_core, "pid_path", lambda: DummyPidPath())

    from public_admin.server import singbox_manager

    monkeypatch.setattr(singbox_manager, "get_service_status", lambda: {
        "installed": True,
        "active": False,
        "pid": "0",
        "config_path": "/root/sing-box/config.json",
    })

    status = singbox_core.get_status()

    assert status["active"] is True
    assert status["managed_active"] is True
    assert status["managed_pid"] == "1234"
    assert status["run_mode"] == "managed"
