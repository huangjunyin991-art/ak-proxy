import asyncio
import base64
import json
from datetime import datetime, timedelta

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from public_admin.plugins.license_center.server.offline_authorization import OfflineAuthorizationSigner
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


def test_auto_sell_authorization_reuses_the_same_bound_activation_code():
    class Repository:
        pool_supplier = staticmethod(lambda: None)

        def __init__(self):
            self.logs = []

        async def add_verification_log(self, payload):
            self.logs.append(dict(payload))

    repository = Repository()
    service = LicenseCenterService(repository, offline_authorization_signer=_signer())
    calls = []

    async def verify_or_activate(data, ip_address, activate):
        calls.append((dict(data), ip_address, activate))
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
    assert renewed["success"] is True
    assert renewed["data"]["authorization_code"] != result["data"]["authorization_code"]
    assert calls == [({
        "product_id": AUTO_SELL_PRODUCT_ID,
        "license_key": "ABCDE-ABCDE-ABCDE-ABCDE",
        "machine_id": "machine-a",
    }, "203.0.113.10", True)] * 2
    assert repository.logs[-1]["action"] == "offline_authorize"
    assert repository.logs[-1]["result"] == "success"


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
