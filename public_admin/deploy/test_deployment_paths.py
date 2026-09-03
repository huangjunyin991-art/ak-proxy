from pathlib import Path

import pytest

from public_admin.deploy.env.ensure_env import reconcile_authorization_env


CANONICAL_ENV_PATH = "/etc/ak-proxy/ak-proxy.env"
LEGACY_ENV_PATH = "/etc/ak-proxy.env"


def test_systemd_template_uses_canonical_environment_path():
    root = Path(__file__).parents[2]
    service = (root / "deploy" / "systemd" / "ak-proxy.service").read_text(encoding="utf-8")
    readme = (root / "deploy" / "systemd" / "README.md").read_text(encoding="utf-8")

    assert f"EnvironmentFile={CANONICAL_ENV_PATH}" in service
    assert f"--legacy-env-file {LEGACY_ENV_PATH}" in service
    assert CANONICAL_ENV_PATH in readme
    assert LEGACY_ENV_PATH in readme


def test_license_center_uses_canonical_environment_path():
    root = Path(__file__).parents[2]
    source = (
        root / "public_admin" / "plugins" / "license_center" / "server" / "offline_authorization.py"
    ).read_text(encoding="utf-8")

    assert f'DEFAULT_ENV_FILE = "{CANONICAL_ENV_PATH}"' in source
    assert "DEFAULT_LEGACY_ENV_FILE" in source


def test_generated_systemd_units_have_restart_rate_limits():
    root = Path(__file__).parents[2]
    for relative in ("public_admin/deploy_ak_proxy.sh", "public_admin/manage_ak_proxy.sh"):
        source = (root / relative).read_text(encoding="utf-8")
        assert "StartLimitIntervalSec=300" in source
        assert "StartLimitBurst=5" in source
        assert "TimeoutStopSec=30" in source
        assert "ensure_env.py" in source


def test_ensure_env_has_startup_key_guard():
    root = Path(__file__).parents[2]
    source = (root / "public_admin" / "deploy" / "env" / "ensure_env.py").read_text(encoding="utf-8")
    assert "reconcile_authorization_env" in source
    assert "authorization key conflict" in source


def test_legacy_signing_key_is_migrated_without_printing_secret(tmp_path):
    canonical = tmp_path / "canonical.env"
    legacy = tmp_path / "legacy.env"
    legacy.write_text("LICENSE_AUTO_SELL_SIGNING_PRIVATE_KEY=legacy-private\n", encoding="utf-8")

    changed = reconcile_authorization_env(str(canonical), str(legacy))

    assert changed == ["LICENSE_AUTO_SELL_SIGNING_PRIVATE_KEY"]
    assert "legacy-private" in canonical.read_text(encoding="utf-8")


def test_signing_key_conflict_fails_with_fingerprints_only(tmp_path):
    canonical = tmp_path / "canonical.env"
    legacy = tmp_path / "legacy.env"
    canonical.write_text("LICENSE_AUTO_SELL_SIGNING_PRIVATE_KEY=current-private\n", encoding="utf-8")
    legacy.write_text("LICENSE_AUTO_SELL_SIGNING_PRIVATE_KEY=legacy-private\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="authorization key conflict") as exc_info:
        reconcile_authorization_env(str(canonical), str(legacy))

    assert "current-private" not in str(exc_info.value)
    assert "legacy-private" not in str(exc_info.value)


def test_explicit_empty_canonical_signing_key_is_not_regenerated(tmp_path):
    canonical = tmp_path / "canonical.env"
    legacy = tmp_path / "legacy.env"
    canonical.write_text("LICENSE_AUTO_SELL_SIGNING_PRIVATE_KEY=\n", encoding="utf-8")
    legacy.write_text("LICENSE_AUTO_SELL_SIGNING_PRIVATE_KEY=legacy-private\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="explicitly empty"):
        reconcile_authorization_env(str(canonical), str(legacy))
