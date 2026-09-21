from server.proxy_server import _javascript_content_type, _transform_ak_public_static_content


def test_unpatched_legacy_javascript_is_reencoded_as_utf8():
    source = "window.message = '请完成人机验证';".encode("gb18030")

    transformed = _transform_ak_public_static_content(
        "content/js/pages/account/login.js",
        "application/javascript",
        source,
    )

    assert transformed.decode("utf-8") == "window.message = '请完成人机验证';"


def test_javascript_content_type_declares_utf8():
    assert _javascript_content_type("application/javascript") == "application/javascript; charset=utf-8"
    assert _javascript_content_type("text/javascript; charset=gbk") == "text/javascript; charset=utf-8"
