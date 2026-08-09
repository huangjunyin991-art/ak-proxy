import asyncio
from contextlib import asynccontextmanager

import pytest

from .ep_auto_purchase.credentials import EPAutoPurchaseCredentials
from .ep_auto_purchase.provider import (
    EPAutoPurchaseCredentialError,
    EPAutoPurchaseProvider,
    EPAutoPurchaseUpstreamError,
)
from .ep_auto_purchase.repository import EPAutoPurchaseRepository
from .ep_auto_purchase.service import EPAutoPurchaseService, parse_interval_milliseconds
from .ep_auto_purchase.listing import inspect_listing_payload, parse_listing
from .ep_auto_purchase.order_detail import extract_seller_account
from .ep_auto_purchase.notifier import EPAutoPurchaseSuccessNotifier
from .ep_auto_purchase.internal_rpc import (
    DEFAULT_EP_AUTO_PURCHASE_RPC_BASE_URL,
    EP_AUTO_PURCHASE_INTERNAL_HEADER,
    is_trusted_internal_rpc_request,
)
from .upstream_rpc_gate import RpcGateBusy
from .upstream_rpc_gate.service import UpstreamRpcGate


class _Response:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def json(self):
        return self._payload


class _Client:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code
        self.calls = []

    async def post(self, url, data, headers=None):
        self.calls.append((url, dict(data), dict(headers or {})))
        return _Response(self.payload, self.status_code)


@pytest.mark.anyio
async def test_ep_buy_sends_only_order_and_auth_fields():
    client = _Client({"Error": False, "Msg": "ok"})
    provider = EPAutoPurchaseProvider("http://local/RPC/")

    result = await provider.buy(
        client,
        {"key": "buyer-key", "user_id": "103"},
        "88",
        "order-secret",
    )

    assert result == {"success": True, "message": "ok"}
    assert set(client.calls[0][1]) == {"sId", "Sokey", "key", "UserID", "v", "lang"}
    assert client.calls[0][1]["sId"] == "88"
    assert "password" not in client.calls[0][1]
    assert "gCode" not in client.calls[0][1]


@pytest.mark.anyio
async def test_confirm_payment_sends_exact_order_password_and_auth_fields():
    client = _Client({"Error": False, "Msg": "ok"})
    provider = EPAutoPurchaseProvider("http://local/RPC/")

    result = await provider.confirm_payment(
        client,
        {"key": "buyer-key", "user_id": "103"},
        "88",
        "trade-secret",
    )

    assert result == {"success": True, "message": "ok", "auth_error": False}
    request = client.calls[0][1]
    assert set(request) == {"sId", "password", "remark", "key", "UserID", "v", "lang"}
    assert request["sId"] == "88"
    assert request["password"] == "trade-secret"
    assert request["remark"] == ""
    assert request["key"] == "buyer-key"
    assert request["UserID"] == "103"
    assert request["lang"] == "ko"
    assert "Sokey" not in request


@pytest.mark.anyio
async def test_confirm_payment_marks_login_error_for_one_auth_refresh():
    client = _Client({"Error": True, "Msg": "用户未登录"})
    provider = EPAutoPurchaseProvider("http://local/RPC/")

    result = await provider.confirm_payment(
        client,
        {"key": "expired-key", "user_id": "103"},
        "88",
        "trade-secret",
    )

    assert result["success"] is False
    assert result["auth_error"] is True


@pytest.mark.anyio
async def test_cancel_purchase_sends_only_order_and_auth_fields():
    client = _Client({"Error": False, "Msg": "ok"})
    provider = EPAutoPurchaseProvider("http://local/RPC/")

    result = await provider.cancel_purchase(
        client,
        {"key": "buyer-key", "user_id": "103"},
        "88",
    )

    assert result == {"success": True, "message": "ok", "auth_error": False}
    assert client.calls[0][0] == "http://local/RPC/EP_Cancel_Buy"
    assert set(client.calls[0][1]) == {"sId", "key", "UserID", "v", "lang"}
    assert client.calls[0][1]["sId"] == "88"
    assert client.calls[0][1]["key"] == "buyer-key"
    assert "password" not in client.calls[0][1]


@pytest.mark.anyio
async def test_cancel_purchase_marks_login_error_for_one_auth_refresh():
    client = _Client({"Error": True, "Msg": "用户未登录"})
    provider = EPAutoPurchaseProvider("http://local/RPC/")

    result = await provider.cancel_purchase(
        client,
        {"key": "expired-key", "user_id": "103"},
        "88",
    )

    assert result["success"] is False
    assert result["auth_error"] is True


@pytest.mark.anyio
async def test_pending_list_uses_confirmed_market_parameters():
    client = _Client({"Error": False, "Data": {"List": [{"sId": 1}]}})
    provider = EPAutoPurchaseProvider("http://local/RPC/")

    rows = await provider.list_pending(client, {"key": "buyer-key", "user_id": "103"})

    assert rows == [{"sId": 1}]
    request = client.calls[0][1]
    assert request["p"] == "1"
    assert request["pageSize"] == "50"
    assert request["type"] == "1"
    assert request["Position"] == "1"
    assert request["account"] == ""


@pytest.mark.anyio
async def test_default_provider_routes_ep_calls_through_nginx_with_internal_marker():
    client = _Client({"Error": False, "Data": {"List": []}})
    provider = EPAutoPurchaseProvider(internal_token="runtime-secret")

    await provider.list_pending(client, {"key": "buyer-key", "user_id": "103"})

    assert provider.base_url == DEFAULT_EP_AUTO_PURCHASE_RPC_BASE_URL
    assert client.calls[0][0] == "https://ak2025.vip/RPC/Public_EP_SellRecords1"
    assert client.calls[0][2] == {EP_AUTO_PURCHASE_INTERNAL_HEADER: "runtime-secret"}


def test_default_provider_uses_ep_nginx_headers():
    provider = EPAutoPurchaseProvider(internal_token="runtime-secret")

    headers = provider._headers()

    assert headers["User-Agent"] == "AK-Proxy-EP-Auto-Purchase/1.0"
    assert headers["Origin"] == "https://ak2025.vip"
    assert headers["Referer"] == "https://ak2025.vip/"


@pytest.mark.anyio
async def test_order_detail_uses_confirmed_minimal_parameters_and_internal_marker():
    client = _Client({"Error": False, "Detail": {"Seller": {"FlowNumber": "seller"}}})
    provider = EPAutoPurchaseProvider(internal_token="runtime-secret")

    await provider.fetch_order_detail(client, {"key": "buyer-key", "user_id": "103"}, "88")

    assert client.calls[0][0] == "https://ak2025.vip/RPC/Public_EP_SellDetail"
    assert client.calls[0][1]["sId"] == "88"
    assert set(client.calls[0][1]) == {"sId", "key", "UserID", "v", "lang"}
    assert client.calls[0][2] == {EP_AUTO_PURCHASE_INTERNAL_HEADER: "runtime-secret"}


@pytest.mark.anyio
async def test_background_login_uses_internal_marker_for_shared_rpc_gate():
    client = _Client({"Error": False, "UserData": {"Id": "103", "Key": "key"}})
    provider = EPAutoPurchaseProvider("https://proxy.example/RPC/", internal_token="runtime-secret")

    await provider.post_rpc(client, "Login", {"account": "buyer", "password": "secret"})

    assert client.calls[0][2] == {EP_AUTO_PURCHASE_INTERNAL_HEADER: "runtime-secret"}


@pytest.mark.anyio
async def test_proxy_gate_busy_response_is_exposed_as_gate_busy():
    client = _Client(
        {"Error": True, "Code": "rpc_gate_busy", "Msg": "busy"},
        status_code=503,
    )
    provider = EPAutoPurchaseProvider("https://proxy.example/RPC/", internal_token="runtime-secret")

    with pytest.raises(RpcGateBusy):
        await provider.list_pending(client, {"key": "buyer-key", "user_id": "103"})


@pytest.mark.anyio
async def test_login_password_error_is_preserved_from_json_error_response():
    client = _Client({"Error": True, "Msg": "密码错误"}, status_code=400)
    provider = EPAutoPurchaseProvider("http://local/RPC/")

    with pytest.raises(EPAutoPurchaseUpstreamError) as caught:
        await provider.post_rpc(client, "Login", {"account": "buyer", "password": "secret"})

    assert caught.value.is_password_error is True


def test_internal_rpc_marker_requires_loopback_and_exact_runtime_token():
    headers = {EP_AUTO_PURCHASE_INTERNAL_HEADER: "runtime-secret"}

    assert is_trusted_internal_rpc_request(headers, "127.0.0.1", "runtime-secret") is True
    assert is_trusted_internal_rpc_request(headers, "203.0.113.10", "runtime-secret") is False
    assert is_trusted_internal_rpc_request(headers, "127.0.0.1", "other-secret") is False


class _Gate:
    def __init__(self):
        self.lease = object()
        self.released = 0

    async def try_reserve_background(self, identity):
        return self.lease

    async def release(self, lease):
        assert lease is self.lease
        self.released += 1


class _Repository:
    def __init__(self, allow_begin=True):
        self.allow_begin = allow_begin
        self.order_states = {}
        self.registered = []
        self.begin_calls = []
        self.deferred = []
        self.finished = []

    async def register_listing(self, sid, buyer_account, seller_account, ep_amount, sokey_digest):
        self.registered.append((sid, buyer_account, seller_account, ep_amount, sokey_digest))
        if sid in self.order_states:
            return False
        self.order_states[sid] = "pending"
        return True

    async def begin_order_attempt(self, sid, buyer_account, seller_account, ep_amount, sokey_digest):
        self.begin_calls.append((sid, buyer_account, seller_account, ep_amount, sokey_digest))
        if not self.allow_begin or self.order_states.get(sid) != "pending":
            return False
        self.order_states[sid] = "sending"
        return True

    async def defer_order(self, sid, buyer_account, message, retry_seconds=1.0):
        self.deferred.append((sid, buyer_account, message, retry_seconds))
        if self.order_states.get(sid) == "sending":
            self.order_states[sid] = "pending"

    async def finish_order(self, sid, state, message):
        self.finished.append((sid, state, message))
        if self.order_states.get(sid) == "sending":
            self.order_states[sid] = state

    async def claim_next_seller_lookup(self, buyer_account):
        return None


@pytest.mark.anyio
async def test_order_timeout_is_recorded_unknown_without_second_buy():
    repository = _Repository()
    gate = _Gate()
    service = EPAutoPurchaseService(repository, auth_store=None, rpc_gate=gate)
    calls = 0

    async def fail_buy(client, auth, sid, sokey):
        nonlocal calls
        calls += 1
        raise TimeoutError("timeout")

    service.provider.buy = fail_buy

    success = await service._purchase_listing(
        None,
        "buyer",
        {"user_id": "103", "key": "key"},
        {"sId": "88", "Sokey": "secret", "Account": "seller", "EPAmount": "5"},
    )

    assert success is False
    assert calls == 1
    assert repository.finished == [("88", "unknown", "timeout")]
    assert repository.order_states["88"] == "unknown"

    second_attempt = await service._purchase_listing(
        None,
        "buyer",
        {"user_id": "103", "key": "key"},
        {"sId": "88", "Sokey": "secret"},
    )
    assert second_attempt is False
    assert calls == 1
    assert gate.released == 0


@pytest.mark.anyio
async def test_existing_order_is_not_purchased_again():
    repository = _Repository()
    repository.order_states["88"] = "success"
    gate = _Gate()
    service = EPAutoPurchaseService(repository, auth_store=None, rpc_gate=gate)

    async def should_not_buy(*args):
        raise AssertionError("duplicate order must not reach EP_Buy")

    service.provider.buy = should_not_buy

    success = await service._purchase_listing(
        None,
        "buyer",
        {"user_id": "103", "key": "key"},
        {"sId": "88", "Sokey": "secret"},
    )

    assert success is False
    assert len(repository.registered) == 1
    assert len(repository.begin_calls) == 1
    assert repository.finished == []
    assert gate.released == 0


@pytest.mark.anyio
async def test_gate_busy_defers_unforwarded_order_for_retry():
    repository = _Repository()
    service = EPAutoPurchaseService(repository, auth_store=None, rpc_gate=_Gate())

    async def busy(*args):
        raise RpcGateBusy()

    service.provider.buy = busy

    with pytest.raises(RpcGateBusy):
        await service._purchase_listing(
            None,
            "buyer",
            {"user_id": "103", "key": "key"},
            {"sId": "88", "Sokey": "secret"},
        )

    assert repository.order_states["88"] == "pending"
    assert repository.deferred[0][:2] == ("88", "buyer")
    assert repository.finished == []


@pytest.mark.anyio
async def test_repeated_listing_is_counted_once_and_bought_once():
    class PollRepository(_Repository):
        def __init__(self):
            super().__init__()
            self.poll_results = []

        async def finish_poll(self, owner, account, **values):
            self.poll_results.append((owner, account, values))

    repository = PollRepository()
    service = EPAutoPurchaseService(repository, auth_store=None, rpc_gate=_Gate())
    purchases = []

    @asynccontextmanager
    async def no_network_client():
        yield object()

    async def load_auth(account):
        return {"account": account, "user_id": "103", "key": "buyer-key"}

    async def pending_payload(client, auth):
        return {
            "Data": {
                "List": [
                    {"sId": "88", "Sokey": "order-secret", "Account": "seller", "EPAmount": "5"},
                    {"sId": "88", "Sokey": "order-secret", "Account": "seller", "EPAmount": "5"},
                ]
            }
        }

    async def buy(client, auth, sid, sokey):
        purchases.append((sid, sokey))
        return {"success": True, "message": "ok"}

    service.provider.build_client = no_network_client
    service._load_auth = load_auth
    service.provider.fetch_pending_payload = pending_payload
    service.provider.buy = buy

    await service._process_poll("buyer")

    assert purchases == [("88", "order-secret")]
    assert repository.poll_results[0][2]["unique_listings_discovered"] == 1
    assert repository.poll_results[0][2]["purchase_successes"] == 1


@pytest.mark.anyio
async def test_password_failure_pauses_poll_until_credentials_are_replaced():
    class PollRepository(_Repository):
        def __init__(self):
            super().__init__()
            self.poll_results = []

        async def finish_poll(self, owner, account, **values):
            self.poll_results.append((owner, account, values))

    repository = PollRepository()
    service = EPAutoPurchaseService(repository, auth_store=None, rpc_gate=_Gate())

    @asynccontextmanager
    async def no_network_client():
        yield object()

    async def load_auth(account):
        return {"account": account, "user_id": "103", "key": "buyer-key"}

    async def list_with_refresh(client, account, auth):
        raise EPAutoPurchaseCredentialError("请输入正确的登录密码")

    service.provider.build_client = no_network_client
    service._load_auth = load_auth
    service._list_with_one_refresh = list_with_refresh

    await service._process_poll("buyer")

    assert repository.poll_results[0][2]["state"] == "needs_password"
    assert repository.poll_results[0][2]["error"] == "请输入正确的登录密码"


class _SuccessNotificationRepository:
    def __init__(self, jobs):
        self.jobs = list(jobs)
        self.finished = []
        self.deferred = []

    async def claim_next_success_notification(self):
        return self.jobs.pop(0) if self.jobs else None

    async def finish_success_notification(self, sid):
        self.finished.append(sid)

    async def defer_success_notification(self, sid, error, retry_seconds=60):
        self.deferred.append((sid, error, retry_seconds))


@pytest.mark.anyio
async def test_success_notification_is_dispatched_once_from_persisted_order():
    repository = _SuccessNotificationRepository([{
        "sid": "88",
        "buyer_account": "buyer",
        "seller_account": "seller",
        "ep_amount": "5",
    }])
    published = []

    async def publish(order):
        published.append(dict(order))

    service = EPAutoPurchaseService(
        repository,
        auth_store=None,
        rpc_gate=_Gate(),
        notification_publisher=publish,
    )

    await service._dispatch_one_success_notification()

    assert published == [{
        "sid": "88",
        "buyer_account": "buyer",
        "seller_account": "seller",
        "ep_amount": "5",
    }]
    assert repository.finished == ["88"]
    assert repository.deferred == []


@pytest.mark.anyio
async def test_success_notification_failure_is_deferred_without_stopping_worker():
    repository = _SuccessNotificationRepository([{
        "sid": "88",
        "buyer_account": "buyer",
        "seller_account": "",
        "ep_amount": "5",
    }])

    async def fail_publish(order):
        raise RuntimeError("notify unavailable")

    service = EPAutoPurchaseService(
        repository,
        auth_store=None,
        rpc_gate=_Gate(),
        notification_publisher=fail_publish,
    )

    await service._dispatch_one_success_notification()

    assert repository.finished == []
    assert repository.deferred == [("88", "notify unavailable", 60)]


@pytest.mark.anyio
async def test_success_notifier_writes_account_notification_and_ntfy_event():
    class SystemNotificationService:
        def __init__(self):
            self.calls = []

        async def publish_system_notification(self, **kwargs):
            self.calls.append(kwargs)

    class NotifyCenter:
        def __init__(self):
            self.events = []

        async def handle_im_message_event(self, event):
            self.events.append(event)

    notification_service = SystemNotificationService()
    notify_center = NotifyCenter()
    notifier = EPAutoPurchaseSuccessNotifier(
        notification_service=notification_service,
        notify_center_supplier=lambda: notify_center,
    )

    await notifier.publish({
        "sid": "88",
        "buyer_account": "buyer",
        "seller_account": "seller",
        "ep_amount": "5",
    })

    assert notification_service.calls[0]["event_id"] == "ep-auto-purchase:88:success"
    assert notification_service.calls[0]["username"] == "buyer"
    assert "5 EP" in notification_service.calls[0]["content"]
    assert notify_center.events == [{
        "source": "ep_auto_purchase",
        "event_id": "ep-auto-purchase:88:success",
        "sid": "88",
        "buyer_account": "buyer",
        "seller_account": "seller",
        "ep_amount": "5",
        "event_type": "im.system.ep_auto_purchase.success",
        "message_type": "system_notification",
        "sender_username": "system",
        "recipient_usernames": ["buyer"],
        "notification_title": "EP 抢购成功",
        "notification_body": "账号 buyer 已成功抢购订单 #88，数量 5 EP，挂卖账号 seller。",
        "notification_url": "/pages/home.html?first=true",
    }]


def test_listing_parser_accepts_standard_and_legacy_order_identifiers():
    payload = {
        "Data": {
            "List": [
                {"sId": 88, "Sokey": "secret-a", "Account": "seller-a", "EPAmount": 5},
                {"eId": 89, "Sokey": "secret-b", "Account": "seller-b", "EPAmount": 6},
            ]
        }
    }

    inspection = inspect_listing_payload(payload)

    assert inspection.list_path == "Data.List"
    assert inspection.row_count == 2
    assert inspection.valid_count == 2
    assert parse_listing(inspection.rows[0]).sid == "88"
    assert parse_listing(inspection.rows[1]).sid == "89"


def test_order_detail_extracts_only_seller_flow_number():
    payload = {
        "Error": False,
        "Detail": {
            "Seller": {
                "FlowNumber": "cwy6699",
                "Usdt": {"Address": "must-not-be-persisted"},
            }
        },
    }

    assert extract_seller_account(payload) == "cwy6699"


@pytest.mark.anyio
async def test_missing_seller_is_enriched_once_and_persisted():
    class SellerRepository(_Repository):
        def __init__(self):
            super().__init__()
            self.jobs = [{"sid": "3297128", "buyer_account": "buyer"}]
            self.saved_sellers = []
            self.deferred_sellers = []

        async def claim_next_seller_lookup(self, buyer_account):
            return self.jobs.pop(0) if self.jobs else None

        async def finish_seller_lookup(self, sid, seller_account):
            self.saved_sellers.append((sid, seller_account))

        async def defer_seller_lookup(self, sid, error, retry_seconds=60):
            self.deferred_sellers.append((sid, error, retry_seconds))

    repository = SellerRepository()
    service = EPAutoPurchaseService(repository, auth_store=None, rpc_gate=_Gate())

    async def order_detail(client, auth, sid):
        assert sid == "3297128"
        assert auth == {"account": "buyer", "user_id": "103", "key": "buyer-key"}
        return {"Detail": {"Seller": {"FlowNumber": "cwy6699"}}}

    service.provider.fetch_order_detail = order_detail

    await service._enrich_one_missing_seller(
        object(),
        "buyer",
        {"account": "buyer", "user_id": "103", "key": "buyer-key"},
    )

    assert repository.saved_sellers == [("3297128", "cwy6699")]
    assert repository.deferred_sellers == []


@pytest.mark.anyio
async def test_existing_seller_does_not_call_order_detail():
    repository = _Repository()
    service = EPAutoPurchaseService(repository, auth_store=None, rpc_gate=_Gate())

    async def should_not_fetch(*args):
        raise AssertionError("existing seller account must skip Public_EP_SellDetail")

    service.provider.fetch_order_detail = should_not_fetch

    await service._enrich_one_missing_seller(
        object(),
        "buyer",
        {"account": "buyer", "user_id": "103", "key": "buyer-key"},
    )


@pytest.mark.anyio
async def test_seller_lookup_gate_busy_defers_without_breaking_the_purchase_poll():
    class SellerRepository(_Repository):
        def __init__(self):
            super().__init__()
            self.deferred_sellers = []

        async def claim_next_seller_lookup(self, buyer_account):
            return {"sid": "3297128", "buyer_account": buyer_account}

        async def defer_seller_lookup(self, sid, error, retry_seconds=60):
            self.deferred_sellers.append((sid, error, retry_seconds))

    repository = SellerRepository()
    service = EPAutoPurchaseService(repository, auth_store=None, rpc_gate=_Gate())

    async def busy(*args):
        raise RpcGateBusy()

    service.provider.fetch_order_detail = busy

    await service._enrich_one_missing_seller(
        object(),
        "buyer",
        {"account": "buyer", "user_id": "103", "key": "buyer-key"},
    )

    assert repository.deferred_sellers == [("3297128", "等待用户请求优先", 1)]


class _ConfigRepository:
    def __init__(self, active_accounts):
        self.active_accounts = active_accounts
        self.saved = None
        self.account_enabled = {}
        self.trading_password_accounts = set()
        self.statuses = []

    async def list_active_accounts(self):
        return [dict(item) for item in self.active_accounts]

    async def save_config(
        self,
        account_rows,
        interval_milliseconds,
        enabled,
        trading_passwords=None,
    ):
        trading_passwords = dict(trading_passwords or {})
        accounts = [str(item["account"]) for item in account_rows]
        self.account_enabled = {
            str(item["account"]): bool(item.get("enabled", True))
            for item in account_rows
        }
        self.saved = (list(accounts), interval_milliseconds, enabled, trading_passwords)
        self.trading_password_accounts.update(trading_passwords)
        return {
            "accounts": list(accounts),
            "interval_milliseconds": interval_milliseconds,
            "interval_seconds": interval_milliseconds / 1000,
            "enabled": enabled,
            "account_enabled": self.account_enabled,
        }

    async def list_trading_password_accounts(self, accounts):
        return set(accounts) & self.trading_password_accounts

    async def get_account_password(self, account):
        item = next((row for row in self.active_accounts if row["username"] == account), {})
        return "saved-password" if item.get("has_password") else ""

    async def dashboard(self):
        return {
            "config": {"accounts": [row["username"] for row in self.active_accounts]},
            "accounts": list(self.statuses),
            "orders": [],
            "summary": {},
        }


class _AuthStore:
    def __init__(self):
        self.updated = []
        self.cleared = []

    async def update_user_saved_password(self, account, password):
        self.updated.append((account, password))
        return True

    async def clear_ak_auth_state(self, account):
        self.cleared.append(account)
        return True


@pytest.mark.anyio
async def test_configure_reuses_saved_password_and_updates_only_explicit_password():
    repository = _ConfigRepository([
        {"username": "buyer1", "nickname": "", "has_password": True},
        {"username": "buyer2", "nickname": "", "has_password": False},
    ])
    auth_store = _AuthStore()
    invalidated = []
    service = EPAutoPurchaseService(
        repository,
        auth_store,
        _Gate(),
        on_password_updated=invalidated.append,
    )

    result = await service.configure({
        "accounts": [
            {"account": "buyer1", "password": ""},
            {"account": "buyer2", "password": "new-password"},
        ],
        "interval_seconds": 2,
        "enabled": True,
    })

    assert result["accounts"] == ["buyer1", "buyer2"]
    assert repository.saved == (["buyer1", "buyer2"], 2000, True, {})
    assert auth_store.updated == [("buyer2", "new-password")]
    assert auth_store.cleared == []
    assert invalidated == ["buyer2"]
    assert "trading_password" not in result
    assert "new-password" not in str(result)


@pytest.mark.anyio
async def test_configure_allows_a_nonempty_login_password_without_assuming_its_length():
    repository = _ConfigRepository([
        {"username": "buyer", "nickname": "", "has_password": False},
    ])
    auth_store = _AuthStore()
    service = EPAutoPurchaseService(repository, auth_store, _Gate())

    await service.configure({
        "accounts": [{"account": "buyer", "password": "12"}],
        "interval_seconds": 1,
        "enabled": True,
    })

    assert auth_store.updated == [("buyer", "12")]


@pytest.mark.anyio
async def test_credentials_reuse_any_nonempty_saved_password():
    class Repository:
        async def get_account_password(self, account):
            return "fallback-password"

    class AuthStore:
        async def get_user_password(self, account):
            return "12"

    credentials = EPAutoPurchaseCredentials(Repository(), AuthStore())

    assert await credentials.get_password("buyer") == "12"


@pytest.mark.parametrize(
    ("seconds", "milliseconds"),
    [("0.001", 1), ("0.1", 100), ("0.5", 500), (1, 1000)],
)
def test_interval_seconds_are_converted_to_exact_milliseconds(seconds, milliseconds):
    assert parse_interval_milliseconds(seconds) == milliseconds


@pytest.mark.parametrize("value", [0, -0.1, "invalid", "0.0001", float("inf")])
def test_interval_rejects_non_positive_or_sub_millisecond_values(value):
    with pytest.raises(ValueError, match="抢分间隔"):
        parse_interval_milliseconds(value)


@pytest.mark.anyio
async def test_configure_persists_sub_second_interval_as_milliseconds():
    repository = _ConfigRepository([
        {"username": "buyer", "nickname": "", "has_password": True},
    ])
    service = EPAutoPurchaseService(repository, _AuthStore(), _Gate())

    result = await service.configure({
        "accounts": [{"account": "buyer", "password": ""}],
        "interval_seconds": "0.1",
        "enabled": True,
    })

    assert repository.saved == (["buyer"], 100, True, {})
    assert result["interval_seconds"] == 0.1


@pytest.mark.anyio
async def test_configure_persists_trading_password_for_its_account_only():
    repository = _ConfigRepository([
        {"username": "buyer1", "nickname": "", "has_password": True},
        {"username": "buyer2", "nickname": "", "has_password": True},
    ])
    service = EPAutoPurchaseService(repository, _AuthStore(), _Gate())

    await service.configure({
        "accounts": [
            {"account": "buyer1", "password": "", "trading_password": "trade-1"},
            {"account": "buyer2", "password": "", "trading_password": ""},
        ],
        "interval_seconds": 1,
        "enabled": True,
    })

    assert repository.saved == (["buyer1", "buyer2"], 1000, True, {"buyer1": "trade-1"})


@pytest.mark.anyio
async def test_configure_keeps_disabled_account_without_including_it_in_rotation():
    repository = _ConfigRepository([
        {"username": "buyer1", "nickname": "", "has_password": True},
        {"username": "buyer2", "nickname": "", "has_password": False},
    ])
    service = EPAutoPurchaseService(repository, _AuthStore(), _Gate())

    result = await service.configure({
        "accounts": [
            {"account": "buyer1", "enabled": True},
            {"account": "buyer2", "enabled": False},
        ],
        "interval_seconds": 1,
        "enabled": True,
    })

    assert repository.saved == (["buyer1", "buyer2"], 1000, True, {})
    assert repository.account_enabled == {"buyer1": True, "buyer2": False}
    assert result["account_enabled"] == {"buyer1": True, "buyer2": False}


class _PaymentRepository:
    def __init__(
        self,
        *,
        trading_password="trade-secret",
        claimed=True,
        payment_state="pending",
        cancel_claimed=True,
        cancel_state="pending",
    ):
        self.trading_password = trading_password
        self.claimed = claimed
        self.payment_state = payment_state
        self.cancel_claimed = cancel_claimed
        self.cancel_state = cancel_state
        self.finished = []
        self.cancel_finished = []

    async def get_trading_password(self, account):
        assert account == "buyer"
        return self.trading_password

    async def begin_payment_confirmation(self, sid):
        if not self.claimed:
            return None
        self.claimed = False
        self.payment_state = "confirming"
        return {"sid": sid, "buyer_account": "buyer", "payment_state": "confirming"}

    async def get_payment_order(self, sid):
        return {
            "sid": sid,
            "buyer_account": "buyer",
            "state": "success",
            "payment_state": self.payment_state,
            "cancel_state": self.cancel_state,
        }

    async def finish_payment_confirmation(self, sid, state, message):
        self.payment_state = state
        self.finished.append((sid, state, message))

    async def begin_purchase_cancellation(self, sid):
        if not self.cancel_claimed:
            return None
        self.cancel_claimed = False
        self.cancel_state = "cancelling"
        return {
            "sid": sid,
            "buyer_account": "buyer",
            "payment_state": self.payment_state,
            "cancel_state": self.cancel_state,
        }

    async def get_cancellation_order(self, sid):
        return {
            "sid": sid,
            "buyer_account": "buyer",
            "state": "success",
            "payment_state": self.payment_state,
            "cancel_state": self.cancel_state,
        }

    async def finish_purchase_cancellation(self, sid, state, message):
        self.cancel_state = state
        self.cancel_finished.append((sid, state, message))


class _PaymentAuthStore:
    async def get_ak_auth_state(self, account, allow_expired=True):
        return {
            "userkey": "buyer-key",
            "login_result": {"UserID": "103"},
        }


class _PaymentProvider:
    def __init__(self, result=None, error=None):
        self.result = result or {"success": True, "message": "ok", "auth_error": False}
        self.error = error
        self.calls = []

    @asynccontextmanager
    async def build_client(self):
        yield object()

    async def confirm_payment(self, client, auth, sid, trading_password, remark=""):
        self.calls.append((dict(auth), sid, trading_password, remark))
        if self.error is not None:
            raise self.error
        return dict(self.result)

    async def cancel_purchase(self, client, auth, sid):
        self.calls.append((dict(auth), sid))
        if self.error is not None:
            raise self.error
        return dict(self.result)


@pytest.mark.anyio
async def test_service_confirms_successful_order_and_persists_paid_state():
    repository = _PaymentRepository()
    provider = _PaymentProvider()
    service = EPAutoPurchaseService(
        repository,
        _PaymentAuthStore(),
        _Gate(),
        provider=provider,
    )

    result = await service.confirm_payment("88")

    assert result == {"success": True, "state": "confirmed", "message": "ok"}
    assert provider.calls == [(
        {"account": "buyer", "key": "buyer-key", "user_id": "103"},
        "88",
        "trade-secret",
        "",
    )]
    assert repository.finished == [("88", "confirmed", "ok")]


@pytest.mark.anyio
async def test_service_rejects_duplicate_payment_confirmation():
    repository = _PaymentRepository(claimed=False, payment_state="confirmed")
    provider = _PaymentProvider()
    service = EPAutoPurchaseService(
        repository,
        _PaymentAuthStore(),
        _Gate(),
        provider=provider,
    )

    with pytest.raises(ValueError, match="已经确认付款"):
        await service.confirm_payment("88")

    assert provider.calls == []
    assert repository.finished == []


@pytest.mark.anyio
async def test_service_disallows_payment_confirmation_after_purchase_cancellation():
    repository = _PaymentRepository(cancel_state="cancelled")
    provider = _PaymentProvider()
    service = EPAutoPurchaseService(
        repository,
        _PaymentAuthStore(),
        _Gate(),
        provider=provider,
    )

    with pytest.raises(ValueError):
        await service.confirm_payment("88")

    assert provider.calls == []
    assert repository.claimed is True


@pytest.mark.anyio
async def test_service_marks_transport_failure_as_unknown_without_retry():
    repository = _PaymentRepository()
    provider = _PaymentProvider(error=TimeoutError("timeout"))
    service = EPAutoPurchaseService(
        repository,
        _PaymentAuthStore(),
        _Gate(),
        provider=provider,
    )

    result = await service.confirm_payment("88")

    assert result["success"] is False
    assert result["state"] == "unknown"
    assert repository.finished == [("88", "unknown", "timeout")]


@pytest.mark.anyio
async def test_service_requires_saved_trading_password_before_claiming_order():
    repository = _PaymentRepository(trading_password="")
    provider = _PaymentProvider()
    service = EPAutoPurchaseService(
        repository,
        _PaymentAuthStore(),
        _Gate(),
        provider=provider,
    )

    with pytest.raises(ValueError, match="设置交易密码"):
        await service.confirm_payment("88")

    assert repository.claimed is True
    assert provider.calls == []


@pytest.mark.anyio
async def test_service_cancels_successful_unpaid_order_and_persists_state():
    repository = _PaymentRepository()
    provider = _PaymentProvider()
    service = EPAutoPurchaseService(
        repository,
        _PaymentAuthStore(),
        _Gate(),
        provider=provider,
    )

    result = await service.cancel_purchase("88")

    assert result == {"success": True, "state": "cancelled", "message": "ok"}
    assert provider.calls == [(
        {"account": "buyer", "key": "buyer-key", "user_id": "103"},
        "88",
    )]
    assert repository.cancel_finished == [("88", "cancelled", "ok")]


@pytest.mark.anyio
async def test_service_rejects_duplicate_purchase_cancellation():
    repository = _PaymentRepository(cancel_claimed=False, cancel_state="cancelled")
    provider = _PaymentProvider()
    service = EPAutoPurchaseService(
        repository,
        _PaymentAuthStore(),
        _Gate(),
        provider=provider,
    )

    with pytest.raises(ValueError):
        await service.cancel_purchase("88")

    assert provider.calls == []
    assert repository.cancel_finished == []


@pytest.mark.anyio
async def test_service_marks_cancel_transport_failure_as_unknown_without_retry():
    repository = _PaymentRepository()
    provider = _PaymentProvider(error=TimeoutError("timeout"))
    service = EPAutoPurchaseService(
        repository,
        _PaymentAuthStore(),
        _Gate(),
        provider=provider,
    )

    result = await service.cancel_purchase("88")

    assert result["success"] is False
    assert result["state"] == "unknown"
    assert repository.cancel_finished == [("88", "unknown", "timeout")]


@pytest.mark.anyio
async def test_service_disallows_purchase_cancellation_after_payment_confirmation():
    repository = _PaymentRepository(payment_state="confirmed")
    provider = _PaymentProvider()
    service = EPAutoPurchaseService(
        repository,
        _PaymentAuthStore(),
        _Gate(),
        provider=provider,
    )

    with pytest.raises(ValueError):
        await service.cancel_purchase("88")

    assert provider.calls == []
    assert repository.cancel_claimed is True


class _WorkerIntervalRepository:
    def __init__(self):
        self.claims = 0

    async def claim_next_poll(self, owner):
        self.claims += 1
        return {"account": "buyer", "interval_milliseconds": 1}


@pytest.mark.anyio
async def test_worker_does_not_impose_legacy_200ms_delay_on_subsecond_poll(monkeypatch):
    repository = _WorkerIntervalRepository()
    service = EPAutoPurchaseService(repository, _AuthStore(), _Gate())
    observed_timeouts = []

    async def finish_immediately(account):
        return None

    async def capture_wait(awaitable, timeout):
        awaitable.close()
        observed_timeouts.append(timeout)
        raise asyncio.CancelledError

    service._process_poll = finish_immediately
    monkeypatch.setattr(asyncio, "wait_for", capture_wait)

    with pytest.raises(asyncio.CancelledError):
        await service._run()

    assert repository.claims == 1
    assert observed_timeouts == [0.001]


class _MigrationConnection:
    def __init__(self):
        self.statements = []

    async def execute(self, statement, *args):
        self.statements.append((statement, args))
        return "OK"


class _MigrationPool:
    def __init__(self, connection):
        self.connection = connection

    @asynccontextmanager
    async def acquire(self):
        yield self.connection


@pytest.mark.anyio
async def test_repository_startup_backfills_only_unmigrated_intervals():
    connection = _MigrationConnection()
    repository = EPAutoPurchaseRepository(lambda: _MigrationPool(connection))

    await repository.ensure_ready()

    sql = "\n".join(statement for statement, _ in connection.statements)
    assert "ADD COLUMN IF NOT EXISTS interval_milliseconds BIGINT" in sql
    assert "COALESCE(interval_seconds, 1)::BIGINT * 1000" in sql
    assert "WHERE interval_milliseconds IS NULL" in sql
    assert "unique_listings_discovered" in sql
    assert "next_attempt_at" in sql
    assert "seller_lookup_state" in sql
    assert "notification_state" in sql
    assert "notification_next_at IS NULL" in sql
    assert "state IN ('claimed', 'sending')" in sql
    assert "trading_password TEXT NOT NULL DEFAULT ''" in sql
    assert "ep_auto_purchase_account_credentials" in sql
    assert "jsonb_array_elements(config.accounts_json)" in sql
    assert "SET trading_password = ''" in sql
    assert "payment_state TEXT NOT NULL DEFAULT 'pending'" in sql
    assert "WHERE payment_state = 'confirming'" in sql
    assert "cancel_state TEXT NOT NULL DEFAULT 'pending'" in sql
    assert "WHERE cancel_state = 'cancelling'" in sql
    assert "ep_auto_purchase_listing_diagnostics" not in sql


@pytest.mark.anyio
async def test_configure_rejects_account_without_input_or_saved_password():
    repository = _ConfigRepository([
        {"username": "buyer", "nickname": "", "has_password": False},
    ])
    service = EPAutoPurchaseService(repository, _AuthStore(), _Gate())

    with pytest.raises(ValueError, match="需要输入正确的登录密码"):
        await service.configure({
            "accounts": [{"account": "buyer", "password": ""}],
            "interval_seconds": 1,
            "enabled": False,
        })


@pytest.mark.anyio
async def test_dashboard_returns_password_status_without_password_value():
    repository = _ConfigRepository([
        {
            "username": "buyer",
            "nickname": "Buyer",
            "has_password": True,
            "password": "must-never-leak",
        },
    ])
    service = EPAutoPurchaseService(repository, _AuthStore(), _Gate())

    dashboard = await service.dashboard()

    assert dashboard["available_accounts"] == [
        {"username": "buyer", "nickname": "Buyer", "has_password": True},
    ]
    assert dashboard["config"]["account_rows"] == [
        {
            "account": "buyer",
            "enabled": True,
            "has_password": True,
            "password_required": False,
            "has_trading_password": False,
        },
    ]
    assert "must-never-leak" not in str(dashboard)


@pytest.mark.anyio
async def test_dashboard_forces_password_input_after_a_login_password_error():
    repository = _ConfigRepository([
        {"username": "buyer", "nickname": "Buyer", "has_password": True},
    ])
    repository.statuses = [{"account": "buyer", "state": "needs_password"}]
    service = EPAutoPurchaseService(repository, _AuthStore(), _Gate())

    dashboard = await service.dashboard()

    assert dashboard["config"]["account_rows"] == [
        {
            "account": "buyer",
            "enabled": True,
            "has_password": False,
            "password_required": True,
            "has_trading_password": False,
        },
    ]


@pytest.mark.anyio
async def test_external_gate_retries_while_background_gate_is_one_shot():
    class Repository:
        def __init__(self):
            self.results = [False, True]
            self.external_flags = []

        async def try_claim(self, identity, holder, external):
            self.external_flags.append(external)
            return self.results.pop(0)

        async def release(self, identity, holder):
            return None

    repository = Repository()
    gate = UpstreamRpcGate(repository)
    lease = await gate.reserve_external("user:1", wait_seconds=1)

    assert lease is not None
    assert repository.external_flags == [True, True]
