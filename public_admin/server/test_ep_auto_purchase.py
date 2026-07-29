import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

import pytest

from .ep_auto_purchase.provider import EPAutoPurchaseProvider
from .ep_auto_purchase.repository import EPAutoPurchaseRepository
from .ep_auto_purchase.service import EPAutoPurchaseService, parse_interval_milliseconds
from .ep_auto_purchase.diagnostics import ListingDiagnosticSnapshot
from .ep_auto_purchase.listing import inspect_listing_payload, parse_listing
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


def test_listing_diagnostic_is_process_memory_only_and_expires():
    snapshot = ListingDiagnosticSnapshot(ttl_seconds=10)
    now = datetime(2026, 7, 30, 12, 0, 0)
    payload = {"Data": {"List": [{"sId": 88, "Sokey": "temporary-secret"}]}}

    assert snapshot.capture("buyer", payload, {"row_count": 1}, now=now) is True
    assert snapshot.payload(now=now)["payload"] == payload
    assert snapshot.summary(now=now)["available"] is True
    assert snapshot.payload(now=now + timedelta(seconds=10)) == {"available": False}


class _ConfigRepository:
    def __init__(self, active_accounts):
        self.active_accounts = active_accounts
        self.saved = None

    async def list_active_accounts(self):
        return [dict(item) for item in self.active_accounts]

    async def save_config(self, accounts, interval_milliseconds, enabled):
        self.saved = (list(accounts), interval_milliseconds, enabled)
        return {
            "accounts": list(accounts),
            "interval_milliseconds": interval_milliseconds,
            "interval_seconds": interval_milliseconds / 1000,
            "enabled": enabled,
        }

    async def get_account_password(self, account):
        item = next((row for row in self.active_accounts if row["username"] == account), {})
        return "saved-password" if item.get("has_password") else ""

    async def dashboard(self):
        return {
            "config": {"accounts": [row["username"] for row in self.active_accounts]},
            "accounts": [],
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
    assert repository.saved == (["buyer1", "buyer2"], 2000, True)
    assert auth_store.updated == [("buyer2", "new-password")]
    assert auth_store.cleared == ["buyer2"]
    assert invalidated == ["buyer2"]
    assert "password" not in str(result).lower()


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

    assert repository.saved == (["buyer"], 100, True)
    assert result["interval_seconds"] == 0.1


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
    assert "state IN ('claimed', 'sending')" in sql
    assert "ep_auto_purchase_listing_diagnostics" not in sql


@pytest.mark.anyio
async def test_configure_rejects_account_without_input_or_saved_password():
    repository = _ConfigRepository([
        {"username": "buyer", "nickname": "", "has_password": False},
    ])
    service = EPAutoPurchaseService(repository, _AuthStore(), _Gate())

    with pytest.raises(ValueError, match="没有已保存密码"):
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
        {"account": "buyer", "has_password": True},
    ]
    assert "must-never-leak" not in str(dashboard)


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
