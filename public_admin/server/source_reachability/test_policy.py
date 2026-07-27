from .policy import source_probe_policy_for_protocol


def test_hysteria2_aliases_and_tuic_use_quic_policy():
    for protocol in ("hysteria2", "hy2", "tuic", "HYSTERIA2"):
        policy = source_probe_policy_for_protocol(protocol)

        assert policy.pool == "quic"
        assert policy.max_attempts == 2
        assert policy.batch_concurrency == 3


def test_tcp_protocols_keep_default_probe_policy():
    for protocol in ("vless", "anytls", "shadowsocks", ""):
        policy = source_probe_policy_for_protocol(protocol)

        assert policy.pool == "default"
        assert policy.max_attempts == 1
        assert policy.batch_concurrency == 12


def test_quic_policy_retries_only_transport_failures():
    policy = source_probe_policy_for_protocol("hysteria2")

    assert policy.should_retry(reachable=False, status_code=None, attempt=1) is True
    assert policy.should_retry(reachable=False, status_code=429, attempt=1) is False
    assert policy.should_retry(reachable=True, status_code=403, attempt=1) is False
    assert policy.should_retry(reachable=False, status_code=None, attempt=2) is False
