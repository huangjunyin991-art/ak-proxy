from .service import LoginUiTokenService


def test_login_ui_token_round_trip_and_expiry():
    service = LoginUiTokenService("test-secret", ttl_seconds=900)
    token = service.issue(now=1_000)

    assert service.validate(token, now=1_000)
    assert service.validate(token, now=1_899)
    assert not service.validate(token, now=1_901)


def test_login_ui_token_rejects_tampering_and_future_values():
    service = LoginUiTokenService("test-secret", ttl_seconds=900)
    token = service.issue(now=1_000)
    issued_at, nonce, signature = token.split(".")

    assert not service.validate(f"{issued_at}.{nonce}.tampered", now=1_001)
    assert not service.validate(f"{2_000}.{nonce}.{signature}", now=1_000)


def test_login_ui_token_is_disabled_without_secret():
    service = LoginUiTokenService("", ttl_seconds=900)

    assert service.issue(now=1_000) == ""
    assert not service.validate("1000.nonce.signature", now=1_000)
