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
