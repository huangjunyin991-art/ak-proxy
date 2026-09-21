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
