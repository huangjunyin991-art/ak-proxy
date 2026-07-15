import asyncio
import base64
import json
from datetime import datetime, timedelta

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from public_admin.plugins.license_center.server.offline_authorization import (
    PRIVATE_KEY_ENV,
    OfflineAuthorizationSigner,
)
from public_admin.plugins.license_center.server.products import AUTO_SELL_PRODUCT_ID, DEFAULT_PRODUCT_ID, get_product
from public_admin.plugins.license_center.server.service import LicenseCenterService


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _signer() -> OfflineAuthorizationSigner:
    private_key = Ed25519PrivateKey.generate()
    private_bytes = private_key.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return OfflineAuthorizationSigner(private_key_b64=_b64url(private_bytes), key_id="test-key")


def test_product_catalog_keeps_admin_and_auto_sell_separate():
    admin_panel = get_product(DEFAULT_PRODUCT_ID)
    auto_sell = get_product(AUTO_SELL_PRODUCT_ID)

    assert admin_panel is not None
    assert "per_use" in admin_panel.billing_modes
    assert auto_sell is not None
    assert auto_sell.supports_offline_authorization is True
    assert auto_sell.offline_authorization_ttl_seconds == 8 * 60 * 60


def test_offline_authorization_signature_binds_machine_and_expiry():
    signer = _signer()

    token, payload = signer.issue(
        product_id=AUTO_SELL_PRODUCT_ID,
        license_key="ABCDE-ABCDE-ABCDE-ABCDE",
        machine_id="machine-a",
        issued_at=datetime(2026, 7, 15, 9, 0, 0),
        ttl_seconds=8 * 60 * 60,
    )

    header, body, signature = token.split(".")
    public_key = Ed25519PublicKey.from_public_bytes(
        base64.urlsafe_b64decode(signer.public_key() + "==")
    )
    public_key.verify(base64.urlsafe_b64decode(signature + "=="), f"{header}.{body}".encode("ascii"))
    decoded = json.loads(base64.urlsafe_b64decode(body + "=="))

    assert decoded == payload
    assert decoded["product_id"] == AUTO_SELL_PRODUCT_ID
    assert decoded["machine_id"] == "machine-a"
    assert decoded["expires_at"] == "2026-07-15T17:00:00Z"


def test_offline_authorization_generates_missing_deployment_key_once(tmp_path, monkeypatch):
    env_file = tmp_path / "ak-proxy.env"
    monkeypatch.setenv("AK_PROXY_ENV_FILE", str(env_file))
    monkeypatch.delenv(PRIVATE_KEY_ENV, raising=False)

    first = OfflineAuthorizationSigner.from_env()
    first_public_key = first.public_key()
    first_contents = env_file.read_text(encoding="utf-8")

    monkeypatch.delenv(PRIVATE_KEY_ENV, raising=False)
    second = OfflineAuthorizationSigner.from_env()

    assert second.public_key() == first_public_key
    assert env_file.read_text(encoding="utf-8") == first_contents
    assert first_contents.count(f"{PRIVATE_KEY_ENV}=") == 1


def test_offline_authorization_keeps_an_explicitly_empty_deployment_key(tmp_path, monkeypatch):
    env_file = tmp_path / "ak-proxy.env"
    env_file.write_text(f"{PRIVATE_KEY_ENV}=\n", encoding="utf-8")
    monkeypatch.setenv("AK_PROXY_ENV_FILE", str(env_file))
    monkeypatch.delenv(PRIVATE_KEY_ENV, raising=False)

    signer = OfflineAuthorizationSigner.from_env()

    try:
        signer.public_key()
    except RuntimeError as exc:
        assert "explicitly empty" in str(exc)
    else:
        raise AssertionError("an explicitly empty deployment key must not be regenerated")


def test_auto_sell_authorization_reuses_the_same_bound_activation_code():
    class Repository:
        pool_supplier = staticmethod(lambda: None)

        def __init__(self):
            self.logs = []
            self.bound_device = None

        async def get_license_device(self, license_key, machine_id):
            return self.bound_device

        async def add_verification_log(self, payload):
            self.logs.append(dict(payload))

    repository = Repository()
    service = LicenseCenterService(repository, offline_authorization_signer=_signer())
    calls = []

    async def verify_or_activate(data, ip_address, activate):
        calls.append((dict(data), ip_address, activate))
        if activate:
            repository.bound_device = {
                'license_key': data['license_key'],
                'machine_id': data['machine_id'],
                'status': 'active',
            }
        return {
            "error": False,
            "success": True,
            "data": {"license_key": data["license_key"], "valid": True},
        }

    service._verify_or_activate = verify_or_activate
    request = {
        "product_id": AUTO_SELL_PRODUCT_ID,
        "license_key": "ABCDE-ABCDE-ABCDE-ABCDE",
        "machine_id": "machine-a",
    }
    result = asyncio.run(service.authorize_offline(request, ip_address="203.0.113.10"))
    renewed = asyncio.run(service.authorize_offline(request, ip_address="203.0.113.10"))

    assert result["success"] is True
    assert result["data"]["authorization_ttl_seconds"] == 8 * 60 * 60
    assert result["data"]["authorization_code"].count(".") == 2
    assert result["data"]["authorization_public_key"] == service.offline_authorization_signer.public_key()
    assert result["data"]["authorization_algorithm"] == "Ed25519"
    assert result["data"]["authorization_key_id"] == "test-key"
    assert result["data"]["authorization_issued_at"].endswith("Z")
    assert result["data"]["authorization_expires_at"].endswith("Z")
    assert result["data"]["authorization_activation_performed"] is True
    assert renewed["success"] is True
    assert renewed["data"]["authorization_code"] != result["data"]["authorization_code"]
    assert renewed["data"]["authorization_activation_performed"] is False
    assert calls == [({
        "product_id": AUTO_SELL_PRODUCT_ID,
        "license_key": "ABCDE-ABCDE-ABCDE-ABCDE",
        "machine_id": "machine-a",
    }, "203.0.113.10", True), ({
        "product_id": AUTO_SELL_PRODUCT_ID,
        "license_key": "ABCDE-ABCDE-ABCDE-ABCDE",
        "machine_id": "machine-a",
    }, "203.0.113.10", False)]
    assert repository.logs[-1]["action"] == "offline_authorize"
    assert repository.logs[-1]["result"] == "success"


def test_auto_sell_authorization_does_not_activate_when_signing_is_unavailable():
    class Repository:
        pool_supplier = staticmethod(lambda: None)

        def __init__(self):
            self.logs = []

        async def add_verification_log(self, payload):
            self.logs.append(dict(payload))

    class UnavailableSigner:
        def public_key(self):
            raise RuntimeError("missing signing key")

    repository = Repository()
    service = LicenseCenterService(repository, offline_authorization_signer=UnavailableSigner())
    verify_calls = []

    async def verify_or_activate(data, ip_address, activate):
        verify_calls.append((data, ip_address, activate))
        raise AssertionError("activation must not run before signing preflight succeeds")

    service._verify_or_activate = verify_or_activate
    result = asyncio.run(service.authorize_offline({
        "product_id": AUTO_SELL_PRODUCT_ID,
        "license_key": "ABCDE-ABCDE-ABCDE-ABCDE",
        "machine_id": "machine-a",
    }))

    assert result["success"] is False
    assert result["error_code"] == "OFFLINE_AUTHORIZATION_UNAVAILABLE"
    assert verify_calls == []
    assert repository.logs[-1]["action"] == "offline_authorize"
    assert repository.logs[-1]["result"] == "failed"


def test_time_based_license_expires_after_activated_usage_window():
    service = LicenseCenterService.__new__(LicenseCenterService)
    expired = service.validate_license_time_and_count({
        "status": "active",
        "billing_mode": "time_based",
        "activated_at": datetime.now() - timedelta(hours=2),
        "usage_time": 60,
        "expiry_date": datetime.now() + timedelta(days=30),
    })

    assert expired is not None
    assert expired["error_code"] == "LICENSE_EXPIRED"
