import errno
import json

import pytest

from public_admin.server.proxy_cores import rolling


def test_active_port_generation_persists_base_and_size(monkeypatch, tmp_path):
    state_path = tmp_path / "active_port_generations.json"
    monkeypatch.setattr(rolling, "_STATE_PATH", state_path)

    rolling.mark_active_base_port("singbox", 30001, 46)

    assert rolling.active_port_generation("singbox", 10001) == (30001, 46)
    assert json.loads(state_path.read_text(encoding="utf-8"))["singbox"]["port_count"] == 46
    monkeypatch.setattr(rolling, "_port_range_is_available", lambda base_port, port_count: True)
    assert rolling.candidate_base_port("singbox", 10001, 46) == 30079


def test_candidate_port_bank_skips_occupied_preferred_range(monkeypatch, tmp_path):
    monkeypatch.setattr(rolling, "_STATE_PATH", tmp_path / "state.json")
    monkeypatch.setattr(
        rolling,
        "_port_range_is_available",
        lambda base_port, port_count: base_port != 30001,
    )

    assert rolling.candidate_base_port("singbox", 10001, 46) == 50001


def test_candidate_port_bank_avoids_other_core_reservation(monkeypatch, tmp_path):
    monkeypatch.setattr(rolling, "_STATE_PATH", tmp_path / "state.json")
    monkeypatch.setattr(rolling, "_port_range_is_available", lambda base_port, port_count: True)

    selected = rolling.candidate_base_port(
        "mihomo",
        11001,
        20,
        reserved_ranges=((30001, 1500),),
    )

    assert selected == 51001


def test_candidate_port_bank_continues_after_all_legacy_banks_are_busy(monkeypatch, tmp_path):
    monkeypatch.setattr(rolling, "_STATE_PATH", tmp_path / "state.json")
    rolling.mark_active_base_port("singbox", 10001, 520)
    monkeypatch.setattr(
        rolling,
        "_port_range_is_available",
        lambda base_port, port_count: base_port not in {10001, 30001, 50001},
    )

    assert rolling.candidate_base_port("singbox", 10001, 545) == 10553


def test_candidate_port_bank_handles_478_existing_and_528_new_nodes(monkeypatch, tmp_path):
    monkeypatch.setattr(rolling, "_STATE_PATH", tmp_path / "state.json")
    rolling.mark_active_base_port("singbox", 10001, 478)
    monkeypatch.setattr(rolling, "_port_range_is_available", lambda base_port, port_count: True)

    assert rolling.candidate_base_port("singbox", 10001, 528) == 10511


def test_linux_port_snapshot_checks_large_range_without_opening_sockets(monkeypatch):
    monkeypatch.setattr(rolling, "_read_linux_listening_ports", lambda: {10001, 20000})
    monkeypatch.setattr(
        rolling.socket,
        "socket",
        lambda *args, **kwargs: pytest.fail("Linux snapshot must not open probe sockets"),
    )

    assert rolling._port_range_is_available(10511, 528) is True
    assert rolling._port_range_is_available(19800, 528) is False


def test_linux_port_snapshot_parses_ipv4_and_ipv6_listeners(monkeypatch, tmp_path):
    tcp4 = tmp_path / "tcp"
    tcp6 = tmp_path / "tcp6"
    tcp4.write_text(
        "sl local_address rem_address st\n"
        "0: 0100007F:2711 00000000:0000 0A\n"
        "1: 0100007F:C350 0100007F:01BB 01\n",
        encoding="ascii",
    )
    tcp6.write_text(
        "sl local_address rem_address st\n"
        "0: 00000000000000000000000000000000:2AF9 00000000000000000000000000000000:0000 0A\n",
        encoding="ascii",
    )
    monkeypatch.setattr(rolling.sys, "platform", "linux")
    monkeypatch.setattr(rolling, "_PROC_TCP_PATHS", (tcp4, tcp6))

    assert rolling._read_linux_listening_ports() == {10001, 11001}


def test_port_probe_does_not_hide_file_descriptor_exhaustion(monkeypatch):
    monkeypatch.setattr(rolling, "_read_linux_listening_ports", lambda: None)

    def exhausted_socket(*args, **kwargs):
        raise OSError(errno.EMFILE, "Too many open files")

    monkeypatch.setattr(rolling.socket, "socket", exhausted_socket)

    with pytest.raises(RuntimeError, match="文件描述符不足"):
        rolling._port_range_is_available(10001, 528)


def test_candidate_port_bank_reports_when_every_range_is_occupied(monkeypatch, tmp_path):
    monkeypatch.setattr(rolling, "_STATE_PATH", tmp_path / "state.json")
    monkeypatch.setattr(rolling, "_port_range_is_available", lambda base_port, port_count: False)

    with pytest.raises(RuntimeError, match="无可用本地端口段"):
        rolling.candidate_base_port("singbox", 10001, 46)


def test_process_output_removes_terminal_colors_and_line_noise():
    raw = "\x1b[0;31mFATAL\x1b[0m\nlisten tcp 127.0.0.1:30001: bind: address already in use"

    assert rolling.clean_process_output(raw) == (
        "FATAL listen tcp 127.0.0.1:30001: bind: address already in use"
    )


def test_candidate_start_error_distinguishes_descriptor_limit():
    message = rolling.candidate_start_failure_message(
        "sing-box",
        "FATAL create listener: too many open files",
        10511,
    )

    assert message == "sing-box 文件描述符上限不足，无法启动当前数量的节点"
