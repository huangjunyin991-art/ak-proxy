from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_legacy_remote_license_proxy_is_removed():
    proxy_server = (ROOT / "server" / "proxy_server.py").read_text(encoding="utf-8")
    env_example = (ROOT / "deploy" / "env" / "ak-proxy.env.example").read_text(encoding="utf-8")

    assert "proxy_license_request" not in proxy_server
    assert "LICENSE_SERVER_URL" not in proxy_server
    assert "LICENSE_ADMIN_KEY" not in proxy_server
    assert "LICENSE_SERVER_URL" not in env_example
    assert "LICENSE_ADMIN_KEY" not in env_example


def test_admin_license_ui_uses_the_local_license_center_routes():
    admin_page = (ROOT / "frontend" / "pages" / "admin.html").read_text(encoding="utf-8")
    local_router = (ROOT / "plugins" / "license_center" / "server" / "router.py").read_text(encoding="utf-8")

    assert "remoteRes" not in admin_page
    assert "remoteData" not in admin_page
    for path in (
        "/admin/api/license/statistics",
        "/admin/api/license/list",
        "/admin/api/license/create",
        "/admin/api/license/logs",
    ):
        assert path in local_router
