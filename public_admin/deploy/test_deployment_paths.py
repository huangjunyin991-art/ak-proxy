from pathlib import Path


CANONICAL_ENV_PATH = "/etc/ak-proxy/ak-proxy.env"
LEGACY_ENV_PATH = "/etc/ak-proxy.env"


def test_systemd_template_uses_canonical_environment_path():
    root = Path(__file__).parents[2]
    service = (root / "deploy" / "systemd" / "ak-proxy.service").read_text(encoding="utf-8")
    readme = (root / "deploy" / "systemd" / "README.md").read_text(encoding="utf-8")

    assert f"EnvironmentFile={CANONICAL_ENV_PATH}" in service
    assert LEGACY_ENV_PATH not in service
    assert CANONICAL_ENV_PATH in readme
    assert LEGACY_ENV_PATH not in readme


def test_license_center_uses_canonical_environment_path():
    root = Path(__file__).parents[2]
    source = (
        root / "public_admin" / "plugins" / "license_center" / "server" / "offline_authorization.py"
    ).read_text(encoding="utf-8")

    assert f'DEFAULT_ENV_FILE = "{CANONICAL_ENV_PATH}"' in source
    assert LEGACY_ENV_PATH not in source


def test_generated_systemd_units_have_restart_rate_limits():
    root = Path(__file__).parents[2]
    for relative in ("public_admin/deploy_ak_proxy.sh", "public_admin/manage_ak_proxy.sh"):
        source = (root / relative).read_text(encoding="utf-8")
        assert "StartLimitIntervalSec=300" in source
        assert "StartLimitBurst=5" in source
        assert "TimeoutStopSec=30" in source
