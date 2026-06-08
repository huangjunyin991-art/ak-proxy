import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from public_admin.server.security.credentials import (
    credential_hint,
    has_credential,
    mask_credential,
    sanitize_credential_mapping,
)


def test_mask_and_presence_helpers():
    assert has_credential("secret") is True
    assert has_credential("") is False
    assert has_credential(None) is False
    assert mask_credential("secret") == "***"
    assert mask_credential("") == ""
    assert credential_hint("secret") == "已设置"
    assert credential_hint("") == ""


def test_sanitize_credential_mapping_redacts_nested_values():
    payload = {
        "username": "demo",
        "password": "secret",
        "profile": {
            "ak_userkey": "abc123",
            "nickname": "Demo",
        },
        "items": [
            {"token": "tok"},
            {"name": "plain"},
        ],
    }

    result = sanitize_credential_mapping(payload)

    assert result["username"] == "demo"
    assert result["password"] == "***"
    assert result["has_password"] is True
    assert result["profile"]["ak_userkey"] == "***"
    assert result["profile"]["has_ak_userkey"] is True
    assert result["items"][0]["token"] == "***"
    assert result["items"][0]["has_token"] is True
    assert result["items"][1]["name"] == "plain"


def main():
    test_mask_and_presence_helpers()
    test_sanitize_credential_mapping_redacts_nested_values()


if __name__ == "__main__":
    main()
