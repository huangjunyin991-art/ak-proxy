import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "public_admin"))

from plugins.notify_center.server.config import NotifyCenterConfig
from plugins.notify_center.server.identity import build_identity_cookie_value, verify_identity_cookie_value
from plugins.notify_center.server.identity_resolver import NotifyIdentityResolver


class FakeRequest:
    def __init__(self, cookies):
        self.cookies = cookies


def test_identity_cookie_roundtrip():
    token = build_identity_cookie_value("Alice", "secret-1", ttl_seconds=300, now=1000)
    assert verify_identity_cookie_value(token, "secret-1", now=1001) == "alice"


def test_identity_cookie_rejects_expired_token():
    token = build_identity_cookie_value("alice", "secret-1", ttl_seconds=60, now=1000)
    assert verify_identity_cookie_value(token, "secret-1", now=1061) == ""


def test_identity_cookie_rejects_tampering():
    token = build_identity_cookie_value("alice", "secret-1", ttl_seconds=300, now=1000)
    version, payload, signature = token.split(".")
    tampered = f"{version}.{payload[:-1]}A.{signature}"
    assert verify_identity_cookie_value(tampered, "secret-1", now=1001) == ""
    assert verify_identity_cookie_value(token + "x", "secret-1", now=1001) == ""


def test_identity_resolver_ignores_client_writable_username_cookie():
    resolver = NotifyIdentityResolver(_config())
    request = FakeRequest({"ak_username": "victim", "ak_im_username": "victim"})
    assert resolver.resolve(request).username == ""


def test_identity_resolver_accepts_signed_identity_cookie():
    token = build_identity_cookie_value("Alice", "secret-1", ttl_seconds=300)
    resolver = NotifyIdentityResolver(_config())
    request = FakeRequest({"ak_notify_identity": token, "ak_username": "victim"})
    assert resolver.resolve(request).username == "alice"


def _config() -> NotifyCenterConfig:
    return NotifyCenterConfig(
        enabled=True,
        internal_secret="internal-secret",
        identity_secret="secret-1",
        identity_cookie_name="ak_notify_identity",
        identity_ttl_seconds=300,
        cookie_name="ak_username",
        public_base_url="https://example.com",
        vapid_public_key="",
        vapid_private_key="",
        vapid_private_key_file="",
        vapid_subject="mailto:admin@example.com",
        outbox_batch_size=100,
        worker_interval_seconds=5,
        max_attempts=5,
        retry_base_seconds=60,
        dedupe_window_seconds=30,
        show_message_preview=False,
        web_push_ttl_seconds=86400,
        web_push_timeout_seconds=8,
        ntfy_default_server_url="https://ntfy.ak2025.vip",
    )


if __name__ == "__main__":
    test_identity_cookie_roundtrip()
    test_identity_cookie_rejects_expired_token()
    test_identity_cookie_rejects_tampering()
    test_identity_resolver_ignores_client_writable_username_cookie()
    test_identity_resolver_accepts_signed_identity_cookie()
    print("notify identity tests passed")
