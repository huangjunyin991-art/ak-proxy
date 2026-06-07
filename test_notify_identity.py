import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "public_admin"))

from plugins.notify_center.server.identity import build_identity_cookie_value, verify_identity_cookie_value


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


if __name__ == "__main__":
    test_identity_cookie_roundtrip()
    test_identity_cookie_rejects_expired_token()
    test_identity_cookie_rejects_tampering()
    print("notify identity tests passed")
