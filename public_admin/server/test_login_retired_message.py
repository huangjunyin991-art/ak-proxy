import json


def test_public_login_retired_response_uses_public_message():
    from . import proxy_server

    response = proxy_server._public_login_retired_response(status_code=429)

    assert response.status_code == 429
    assert json.loads(response.body) == {
        "Error": True,
        "Msg": proxy_server.PUBLIC_LOGIN_RETIRED_MESSAGE,
        "message": proxy_server.PUBLIC_LOGIN_RETIRED_MESSAGE,
    }


def test_internal_login_failure_keeps_diagnostic_payload():
    from . import proxy_server

    response = proxy_server._login_failure_response(
        internal_sell_login=True,
        status_code=503,
        payload={"Error": True, "Msg": "upstream unavailable"},
    )

    assert response.status_code == 503
    assert json.loads(response.body) == {"Error": True, "Msg": "upstream unavailable"}


def test_login_script_replaces_client_side_turnstile_prompt():
    from . import proxy_server

    source = b"""
    if (!window.turnstileLoginToken) {
        APP.GLOBAL.toastMsg('please complete verification');
        return;
    }
    """

    transformed = proxy_server._transform_ak_public_static_content(
        "content/js/pages/account/login.js",
        "application/javascript; charset=gb18030",
        source,
    ).decode("utf-8")

    assert proxy_server.PUBLIC_LOGIN_RETIRED_MESSAGE in transformed
    assert "please complete verification" not in transformed
