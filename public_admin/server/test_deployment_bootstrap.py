import importlib.util
from pathlib import Path


def _load_bootstrap_module():
    path = Path(__file__).resolve().parents[2] / "deploy" / "systemd" / "ak_proxy_bootstrap.py"
    spec = importlib.util.spec_from_file_location("ak_proxy_bootstrap_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_bootstrap_reads_literal_environment_value_without_shell_evaluation(tmp_path):
    bootstrap = _load_bootstrap_module()
    env_file = tmp_path / "ak-proxy.env"
    env_file.write_text(
        "LICENSE_AUTO_SELL_SIGNING_PRIVATE_KEY=existing-key\n"
        "OTHER_VALUE='ignored'\n",
        encoding="utf-8",
    )

    assert bootstrap.read_env_value(env_file, "LICENSE_AUTO_SELL_SIGNING_PRIVATE_KEY") == "existing-key"


def test_bootstrap_reads_all_values_without_evaluating_shell_syntax(tmp_path):
    bootstrap = _load_bootstrap_module()
    env_file = tmp_path / "ak-proxy.env"
    env_file.write_text(
        "LICENSE_AUTO_SELL_SIGNING_PRIVATE_KEY=existing-key\n"
        "LITERAL_VALUE=$(not-a-command)\n",
        encoding="utf-8",
    )

    assert bootstrap.read_env_values(env_file) == {
        "LICENSE_AUTO_SELL_SIGNING_PRIVATE_KEY": "existing-key",
        "LITERAL_VALUE": "$(not-a-command)",
    }


def test_bootstrap_treats_an_explicit_empty_value_as_invalid(tmp_path):
    bootstrap = _load_bootstrap_module()
    env_file = tmp_path / "ak-proxy.env"
    env_file.write_text("LICENSE_AUTO_SELL_SIGNING_PRIVATE_KEY=\n", encoding="utf-8")

    assert bootstrap.read_env_value(env_file, "LICENSE_AUTO_SELL_SIGNING_PRIVATE_KEY") == ""
