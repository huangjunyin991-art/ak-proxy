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
