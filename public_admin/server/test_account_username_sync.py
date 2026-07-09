from public_admin.server.account_username_sync import (
    extract_changed_username,
    patch_login_payload_username,
)


def test_extract_changed_username_only_for_successful_change_username_rpc():
    assert extract_changed_username(
        "Change_UserName",
        {"MemberNo": "hjy313123123"},
        {"Error": False},
    ) == "hjy313123123"
    assert extract_changed_username(
        "Change_UserName",
        {"MemberNo": "hjy313123123"},
        {"Error": True, "Msg": "交易密碼不正確"},
    ) == ""
    assert extract_changed_username(
        "OtherApi",
        {"MemberNo": "hjy313123123"},
        {"Error": False},
    ) == ""


def test_patch_login_payload_username_rewrites_identity_fields():
    payload = {
        "UserName": "olduser",
        "UserData": {
            "UserName": "olduser",
            "Account": "olduser",
            "Nickname": "tester",
        },
    }

    patched = patch_login_payload_username(payload, "newuser")

    assert patched["UserName"] == "newuser"
    assert patched["UserData"]["UserName"] == "newuser"
    assert patched["UserData"]["Account"] == "newuser"
    assert patched["UserData"]["Nickname"] == "tester"
    assert payload["UserName"] == "olduser"
    assert payload["UserData"]["UserName"] == "olduser"
