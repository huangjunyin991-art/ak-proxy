import ipaddress
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from public_admin.server.security.url_fetch_gateway import UrlFetchError, UrlFetchGateway


class FakeResolverGateway(UrlFetchGateway):
    def __init__(self, addresses):
        super().__init__()
        self.addresses = [ipaddress.ip_address(item) for item in addresses]

    def _resolve_host(self, hostname: str, port: int):
        return self.addresses


def test_rejects_loopback_literal():
    _assert_rejected("http://127.0.0.1:8080/health")


def test_rejects_link_local_literal():
    _assert_rejected("http://169.254.169.254/latest/meta-data")


def test_rejects_localhost_hostname():
    _assert_rejected("http://localhost:8080")


def test_rejects_embedded_credentials():
    _assert_rejected("https://user:pass@example.com/topic")


def test_accepts_public_ip_literal():
    assert UrlFetchGateway().validate_url("https://8.8.8.8/topic") == "https://8.8.8.8/topic"


def test_rejects_hostname_resolving_to_private_ip():
    gateway = FakeResolverGateway(["10.0.0.5"])
    _assert_rejected("https://ntfy.example.test/topic", gateway=gateway)


def test_accepts_hostname_resolving_to_public_ip():
    gateway = FakeResolverGateway(["1.1.1.1"])
    assert gateway.validate_url("https://ntfy.example.test/topic") == "https://ntfy.example.test/topic"


def _assert_rejected(url: str, *, gateway: UrlFetchGateway | None = None):
    try:
        (gateway or UrlFetchGateway()).validate_url(url)
    except UrlFetchError:
        return
    raise AssertionError(f"expected URL to be rejected: {url}")


if __name__ == "__main__":
    test_rejects_loopback_literal()
    test_rejects_link_local_literal()
    test_rejects_localhost_hostname()
    test_rejects_embedded_credentials()
    test_accepts_public_ip_literal()
    test_rejects_hostname_resolving_to_private_ip()
    test_accepts_hostname_resolving_to_public_ip()
    print("url fetch gateway tests passed")
