from __future__ import annotations

import asyncio
import hashlib
import time
import uuid
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Awaitable, Callable, Mapping

from ..notice_guidance.provider import make_v
from ..upstream_rpc_gate import RpcGateBusy
from .credentials import EPAutoPurchaseCredentials
from .internal_rpc import create_internal_rpc_token, is_trusted_internal_rpc_request
from .listing import EPListing, inspect_listing_payload, parse_listing
from .order_detail import extract_seller_account
from .provider import (
    EPAutoPurchaseCredentialError,
    EPAutoPurchaseProvider,
    EPAutoPurchaseUpstreamError,
    extract_auth_fields,
)


def parse_interval_milliseconds(value: Any) -> int:
    raw_value = 1 if value is None or str(value).strip() == "" else value
    try:
        seconds = Decimal(str(raw_value).strip())
    except (InvalidOperation, TypeError, ValueError):
        raise ValueError("抢分间隔必须是有效数字")
    if not seconds.is_finite() or seconds <= 0:
        raise ValueError("抢分间隔必须大于 0 秒")
    milliseconds = seconds * Decimal("1000")
    if milliseconds != milliseconds.to_integral_value():
        raise ValueError("抢分间隔最多支持三位小数，最小为 0.001 秒")
    return int(milliseconds)


class EPAutoPurchaseService:
    def __init__(
        self,
        repository,
        auth_store,
        rpc_gate,
        logger=None,
        provider=None,
        on_password_updated=None,
        notification_publisher: Callable[[Mapping[str, Any]], Awaitable[None]] | None = None,
    ) -> None:
        self.repository = repository
        self.auth_store = auth_store
        self.rpc_gate = rpc_gate
        self.logger = logger
        self.credentials = EPAutoPurchaseCredentials(
            repository,
            auth_store,
            on_password_updated=on_password_updated,
        )
        self._internal_rpc_token = create_internal_rpc_token()
        self.provider = provider or EPAutoPurchaseProvider(internal_token=self._internal_rpc_token)
        self.notification_publisher = notification_publisher
        self.instance_id = "ep-auto-purchase-" + uuid.uuid4().hex
        self._task: asyncio.Task | None = None
        self._stopping = asyncio.Event()
        self._wake = asyncio.Event()
        self._next_notification_dispatch_at = 0.0

    async def start(self) -> None:
        await self.repository.ensure_ready()
        if self._task is not None and not self._task.done():
            return
        self._stopping.clear()
        self._task = asyncio.create_task(self._run(), name="ep-auto-purchase-worker")

    async def stop(self) -> None:
        self._stopping.set()
        self._wake.set()
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def configure(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        raw_accounts = payload.get("accounts")
        accounts: list[str] = []
        account_rows: list[dict[str, Any]] = []
        password_updates: dict[str, str] = {}
        trading_password_updates: dict[str, str] = {}
        seen: set[str] = set()
        for value in raw_accounts if isinstance(raw_accounts, list) else []:
            if not isinstance(value, Mapping):
                continue
            account = str(value.get("account") or "").strip().lower()
            password = str(value.get("password") or "")
            trading_password = str(value.get("trading_password") or "")
            raw_enabled = value.get("enabled", True)
            if not account:
                continue
            if account in seen:
                raise ValueError(f"抢分账号不能重复：{account}")
            seen.add(account)
            accounts.append(account)
            account_enabled = (
                str(raw_enabled).strip().lower() not in {"0", "false", "no", "off"}
                if isinstance(raw_enabled, str)
                else bool(raw_enabled)
            )
            account_rows.append({"account": account, "enabled": account_enabled})
            if password:
                if len(password) > 512:
                    raise ValueError(f"账号 {account} 的登录密码长度超出限制")
                password_updates[account] = password
            if trading_password:
                if len(trading_password) < 6:
                    raise ValueError(f"账号 {account} 的交易密码至少需要 6 位")
                if len(trading_password) > 512:
                    raise ValueError(f"账号 {account} 的交易密码长度超出限制")
                trading_password_updates[account] = trading_password
        interval_milliseconds = parse_interval_milliseconds(payload.get("interval_seconds", 1))
        active_rows = await self.repository.list_active_accounts()
        active = {
            str(item.get("username") or "").strip().lower(): item
            for item in active_rows
        }
        invalid = [account for account in accounts if account not in active]
        if invalid:
            raise ValueError("以下账号不在有效白名单中：" + "、".join(invalid[:8]))
        enabled_accounts = [
            str(item["account"])
            for item in account_rows
            if bool(item["enabled"])
        ]
        missing_passwords = [
            account
            for account in enabled_accounts
            if account not in password_updates and not bool(active[account].get("has_password"))
        ]
        if missing_passwords:
            raise ValueError("以下账号需要输入正确的登录密码：" + "、".join(missing_passwords[:8]))
        enabled = bool(payload.get("enabled"))
        if enabled and not enabled_accounts:
            raise ValueError("启用前至少勾选一个抢分账号")
        for account, password in password_updates.items():
            if not await self.credentials.update_password(account, password):
                raise ValueError(f"账号 {account} 的密码更新失败")
        config = await self.repository.save_config(
            account_rows,
            interval_milliseconds,
            enabled,
            trading_password_updates,
        )
        clear_requirement = getattr(self.repository, "clear_password_requirement", None)
        if password_updates and callable(clear_requirement):
            await clear_requirement(list(password_updates))
        self._wake.set()
        return self._serialize(config)

    async def dashboard(self) -> dict[str, Any]:
        data = await self.repository.dashboard()
        active_accounts = [
            {
                "username": str(item.get("username") or "").strip().lower(),
                "nickname": str(item.get("nickname") or ""),
                "has_password": bool(item.get("has_password")),
            }
            for item in await self.repository.list_active_accounts()
        ]
        active_by_account = {
            str(item.get("username") or "").strip().lower(): item
            for item in active_accounts
        }
        password_required_accounts = {
            str(item.get("account") or "").strip().lower()
            for item in data.get("accounts") or []
            if str(item.get("state") or "") == "needs_password"
        }
        config = dict(data.get("config") or {})
        trading_password_accounts = await self.repository.list_trading_password_accounts(
            list(config.get("accounts") or [])
        )
        config["account_rows"] = [
            {
                "account": account,
                "enabled": bool((config.get("account_enabled") or {}).get(account, True)),
                "has_password": bool(active_by_account.get(account, {}).get("has_password"))
                and account not in password_required_accounts,
                "password_required": account in password_required_accounts,
                "has_trading_password": account in trading_password_accounts,
            }
            for account in config.get("accounts") or []
        ]
        return {
            "success": True,
            "config": self._serialize(config),
            "available_accounts": self._serialize(active_accounts),
            "accounts": self._serialize(data.get("accounts") or []),
            "orders": self._serialize(data.get("orders") or []),
            "summary": self._serialize(data.get("summary") or {}),
        }

    async def confirm_payment(self, sid: str) -> dict[str, Any]:
        normalized_sid = str(sid or "").strip()
        if not normalized_sid:
            raise ValueError("订单号不能为空")
        current = await self.repository.get_payment_order(normalized_sid)
        if current is None:
            raise ValueError("订单不存在")
        buyer_account = str(current.get("buyer_account") or "").strip().lower()
        current_cancel_state = str(current.get("cancel_state") or "pending")
        cancel_messages = {
            "cancelled": "该订单已经取消购买",
            "cancelling": "该订单正在取消购买",
            "unknown": "取消购买结果未知，请先人工核对",
        }
        if current_cancel_state in cancel_messages:
            raise ValueError(cancel_messages[current_cancel_state])
        current_payment_state = str(current.get("payment_state") or "pending")
        current_messages = {
            "confirmed": "该订单已经确认付款",
            "confirming": "该订单正在确认付款",
            "unknown": "该订单付款确认结果未知，请先人工核对",
        }
        if current_payment_state in current_messages:
            raise ValueError(current_messages[current_payment_state])
        if str(current.get("state") or "") != "success":
            raise ValueError("只有抢购成功的订单可以确认付款")
        trading_password = await self.repository.get_trading_password(buyer_account)
        if not trading_password:
            raise ValueError(f"请先为抢分账号 {buyer_account} 设置交易密码")

        order = await self.repository.begin_payment_confirmation(normalized_sid)
        if order is None:
            current = await self.repository.get_payment_order(normalized_sid)
            if current is None:
                raise ValueError("订单不存在")
            payment_state = str(current.get("payment_state") or "pending")
            cancel_state = str(current.get("cancel_state") or "pending")
            if cancel_state in cancel_messages:
                raise ValueError(cancel_messages[cancel_state])
            raise ValueError(current_messages.get(payment_state, "该订单当前不能确认付款"))
        buyer_account = str(order.get("buyer_account") or buyer_account).strip().lower()
        try:
            async with self.provider.build_client() as client:
                auth = await self._load_auth(buyer_account)
                if not auth.get("key") or not auth.get("user_id"):
                    auth = await self._refresh_auth(client, buyer_account)
                result = await self.provider.confirm_payment(
                    client,
                    auth,
                    normalized_sid,
                    trading_password,
                )
                if result.get("auth_error"):
                    auth = await self._refresh_auth(client, buyer_account)
                    result = await self.provider.confirm_payment(
                        client,
                        auth,
                        normalized_sid,
                        trading_password,
                    )
        except RpcGateBusy:
            await self.repository.finish_payment_confirmation(
                normalized_sid,
                "pending",
                "等待用户请求优先",
            )
            raise
        except Exception as exc:
            message = str(exc) or exc.__class__.__name__
            await self.repository.finish_payment_confirmation(normalized_sid, "unknown", message)
            self._log("payment result unknown account=%s sid=%s error=%s", buyer_account, normalized_sid, message[:200])
            return {"success": False, "state": "unknown", "message": "付款确认结果未知，请人工核对"}

        success = bool(result.get("success"))
        state = "confirmed" if success else "failed"
        message = str(result.get("message") or ("确认付款成功" if success else "确认付款失败"))
        await self.repository.finish_payment_confirmation(normalized_sid, state, message)
        return {"success": success, "state": state, "message": message}

    async def cancel_purchase(self, sid: str) -> dict[str, Any]:
        normalized_sid = str(sid or "").strip()
        if not normalized_sid:
            raise ValueError("订单号不能为空")
        current = await self.repository.get_cancellation_order(normalized_sid)
        if current is None:
            raise ValueError("订单不存在")
        cancel_state = str(current.get("cancel_state") or "pending")
        cancel_messages = {
            "cancelled": "该订单已经取消购买",
            "cancelling": "该订单正在取消购买",
            "unknown": "取消购买结果未知，请先人工核对",
        }
        if cancel_state in cancel_messages:
            raise ValueError(cancel_messages[cancel_state])
        if str(current.get("state") or "") != "success":
            raise ValueError("只有抢购成功的订单可以取消购买")
        current_payment_state = str(current.get("payment_state") or "pending")
        if current_payment_state == "confirmed":
            raise ValueError("已确认付款的订单不能取消购买")
        if current_payment_state == "confirming":
            raise ValueError("该订单正在确认付款")

        order = await self.repository.begin_purchase_cancellation(normalized_sid)
        if order is None:
            current = await self.repository.get_cancellation_order(normalized_sid)
            if current is None:
                raise ValueError("订单不存在")
            state = str(current.get("cancel_state") or "pending")
            current_payment_state = str(current.get("payment_state") or "pending")
            if current_payment_state == "confirmed":
                raise ValueError("已确认付款的订单不能取消购买")
            if current_payment_state == "confirming":
                raise ValueError("该订单正在确认付款")
            raise ValueError(cancel_messages.get(state, "该订单当前不能取消购买"))

        buyer_account = str(order.get("buyer_account") or current.get("buyer_account") or "").strip().lower()
        try:
            async with self.provider.build_client() as client:
                auth = await self._load_auth(buyer_account)
                if not auth.get("key") or not auth.get("user_id"):
                    auth = await self._refresh_auth(client, buyer_account)
                result = await self.provider.cancel_purchase(client, auth, normalized_sid)
                if result.get("auth_error"):
                    auth = await self._refresh_auth(client, buyer_account)
                    result = await self.provider.cancel_purchase(client, auth, normalized_sid)
        except RpcGateBusy:
            await self.repository.finish_purchase_cancellation(
                normalized_sid,
                "pending",
                "等待用户请求优先",
            )
            raise
        except Exception as exc:
            message = str(exc) or exc.__class__.__name__
            await self.repository.finish_purchase_cancellation(normalized_sid, "unknown", message)
            self._log("cancel result unknown account=%s sid=%s error=%s", buyer_account, normalized_sid, message[:200])
            return {"success": False, "state": "unknown", "message": "取消购买结果未知，请人工核对"}

        success = bool(result.get("success"))
        state = "cancelled" if success else "failed"
        message = str(result.get("message") or ("取消购买成功" if success else "取消购买失败"))
        await self.repository.finish_purchase_cancellation(normalized_sid, state, message)
        return {"success": success, "state": state, "message": message}

    async def _run(self) -> None:
        while not self._stopping.is_set():
            self._wake.clear()
            wait_seconds = 1.0
            try:
                await self._dispatch_one_success_notification()
                poll = await self.repository.claim_next_poll(self.instance_id)
                if poll is not None:
                    wait_seconds = max(
                        0.001,
                        int(poll.get("interval_milliseconds") or 1000) / 1000,
                    )
                    await self._process_poll(str(poll.get("account") or ""))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._log("worker iteration failed: %s", str(exc)[:500])
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=wait_seconds)
            except asyncio.TimeoutError:
                pass

    async def _process_poll(self, account: str) -> None:
        unique_listings_discovered = 0
        successes = 0
        error = ""
        retry_seconds = 0
        state = "ready"
        try:
            async with self.provider.build_client() as client:
                auth = await self._load_auth(account)
                payload, auth = await self._list_with_one_refresh(client, account, auth)
                inspection = inspect_listing_payload(payload)
                for row in inspection.rows:
                    listing = parse_listing(row)
                    if listing is None:
                        continue
                    is_new = await self.repository.register_listing(
                        listing.sid, account, listing.seller_account, listing.ep_amount, self._sokey_digest(listing),
                    )
                    if is_new:
                        unique_listings_discovered += 1
                    if await self._purchase_listing(client, account, auth, row, listing=listing, registered=True):
                        successes += 1
                await self._enrich_one_missing_seller(client, account, auth)
        except RpcGateBusy:
            state = "waiting"
        except EPAutoPurchaseCredentialError as exc:
            error = str(exc)
            state = "needs_password"
        except EPAutoPurchaseUpstreamError as exc:
            error = str(exc)
            state = "rate_limited" if exc.is_rate_limited else "error"
            retry_seconds = 300 if (exc.is_rate_limited or exc.is_auth_error) else 30
        except Exception as exc:
            error = str(exc) or exc.__class__.__name__
            state = "error"
            retry_seconds = 30
        finally:
            await self.repository.finish_poll(
                self.instance_id,
                account,
                state=state,
                unique_listings_discovered=unique_listings_discovered,
                purchase_successes=successes,
                error=error,
                retry_seconds=retry_seconds,
                count_poll=state != "waiting",
            )
        if error:
            self._log("poll failed account=%s error=%s", account, error[:300])

    async def _dispatch_one_success_notification(self) -> None:
        if self.notification_publisher is None:
            return
        now = time.monotonic()
        if now < self._next_notification_dispatch_at:
            return
        job = await self.repository.claim_next_success_notification()
        if job is None:
            self._next_notification_dispatch_at = now + 5.0
            return
        sid = str(job.get("sid") or "").strip()
        try:
            await self.notification_publisher(job)
            await self.repository.finish_success_notification(sid)
            self._next_notification_dispatch_at = time.monotonic()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            error = str(exc) or exc.__class__.__name__
            await self.repository.defer_success_notification(sid, error, retry_seconds=60)
            self._next_notification_dispatch_at = time.monotonic() + 1.0
            self._log("success notification deferred sid=%s error=%s", sid, error[:300])

    async def _list_with_one_refresh(
        self,
        client,
        account: str,
        auth: dict[str, str],
    ) -> tuple[dict[str, Any], dict[str, str]]:
        if not auth.get("key") or not auth.get("user_id"):
            auth = await self._refresh_auth(client, account)
        try:
            payload = await self.provider.fetch_pending_payload(client, auth)
            return payload, auth
        except EPAutoPurchaseUpstreamError as exc:
            if not exc.is_auth_error:
                raise
        auth = await self._refresh_auth(client, account)
        payload = await self.provider.fetch_pending_payload(client, auth)
        return payload, auth

    async def _purchase_listing(
        self,
        client,
        buyer_account: str,
        auth: Mapping[str, str],
        row: Mapping[str, Any],
        *,
        listing: EPListing | None = None,
        registered: bool = False,
    ) -> bool:
        listing = listing or parse_listing(row)
        if listing is None:
            return False
        digest = self._sokey_digest(listing)
        if not registered:
            await self.repository.register_listing(
                listing.sid, buyer_account, listing.seller_account, listing.ep_amount, digest,
            )
        sending = await self.repository.begin_order_attempt(
            listing.sid, buyer_account, listing.seller_account, listing.ep_amount, digest,
        )
        if not sending:
            return False
        try:
            result = await self.provider.buy(client, auth, listing.sid, listing.sokey)
        except RpcGateBusy:
            await self.repository.defer_order(listing.sid, buyer_account, "等待用户请求优先")
            raise
        except Exception as exc:
            await self.repository.finish_order(listing.sid, "unknown", str(exc) or exc.__class__.__name__)
            self._log("purchase result unknown account=%s sid=%s error=%s", buyer_account, listing.sid, str(exc)[:200])
            return False
        state = "success" if result.get("success") else "rejected"
        await self.repository.finish_order(listing.sid, state, str(result.get("message") or ""))
        return state == "success"

    async def _enrich_one_missing_seller(
        self,
        client,
        buyer_account: str,
        auth: Mapping[str, str],
    ) -> None:
        job = await self.repository.claim_next_seller_lookup(buyer_account)
        if job is None:
            return
        sid = str(job.get("sid") or "").strip()
        if not sid:
            return
        try:
            payload = await self._fetch_order_detail_with_one_refresh(client, buyer_account, dict(auth), sid)
            await self.repository.finish_seller_lookup(sid, extract_seller_account(payload))
        except RpcGateBusy:
            await self.repository.defer_seller_lookup(sid, "等待用户请求优先", retry_seconds=1)
            return
        except EPAutoPurchaseUpstreamError as exc:
            await self.repository.defer_seller_lookup(sid, str(exc), retry_seconds=60)
        except Exception as exc:
            await self.repository.defer_seller_lookup(sid, str(exc) or exc.__class__.__name__, retry_seconds=60)

    async def _fetch_order_detail_with_one_refresh(
        self,
        client,
        buyer_account: str,
        auth: dict[str, str],
        sid: str,
    ) -> dict[str, Any]:
        try:
            return await self.provider.fetch_order_detail(client, auth, sid)
        except EPAutoPurchaseUpstreamError as exc:
            if not exc.is_auth_error:
                raise
        refreshed_auth = await self._refresh_auth(client, buyer_account)
        return await self.provider.fetch_order_detail(client, refreshed_auth, sid)

    @staticmethod
    def _sokey_digest(listing: EPListing) -> str:
        return hashlib.sha256(listing.sokey.encode("utf-8")).hexdigest()

    async def _load_auth(self, account: str) -> dict[str, str]:
        try:
            state = await self.auth_store.get_ak_auth_state(account, allow_expired=True)
        except TypeError:
            state = await self.auth_store.get_ak_auth_state(account)
        if not isinstance(state, Mapping):
            return {"account": account, "key": "", "user_id": ""}
        payload = state.get("login_result") if isinstance(state.get("login_result"), Mapping) else {}
        fields = extract_auth_fields(payload, str(state.get("userkey") or ""))
        return {"account": account, **fields}

    async def _refresh_auth(self, client, account: str) -> dict[str, str]:
        password = await self.credentials.get_password(account)
        if not password:
            await self._mark_needs_password(account)
            raise EPAutoPurchaseCredentialError("请输入正确的登录密码")
        try:
            payload = await self.provider.post_rpc(
                client,
                "Login",
                {"account": account, "password": password, "v": make_v(), "lang": "cn"},
            )
        except EPAutoPurchaseUpstreamError as exc:
            if not exc.is_password_error:
                raise
            await self._mark_needs_password(account)
            raise EPAutoPurchaseCredentialError("请输入正确的登录密码") from exc
        fields = extract_auth_fields(payload)
        if not fields["key"] or not fields["user_id"]:
            raise EPAutoPurchaseUpstreamError("登录成功但未返回可用 Key 或 UserID")
        await self.auth_store.save_ak_auth_state(
            account,
            userkey=fields["key"],
            cookies={},
            login_payload=payload,
            ttl_seconds=3600,
        )
        return {"account": account, **fields}

    async def _mark_needs_password(self, account: str) -> None:
        marker = getattr(self.repository, "mark_needs_password", None)
        if callable(marker):
            await marker(account)

    async def _gated_call(self, identity: str, callback):
        lease = await self.rpc_gate.try_reserve_background(str(identity or "unknown"))
        if lease is None:
            raise RpcGateBusy()
        try:
            return await callback()
        finally:
            await self.rpc_gate.release(lease)

    def is_internal_rpc_request(self, request) -> bool:
        client = getattr(request, "client", None)
        return is_trusted_internal_rpc_request(
            request.headers,
            str(getattr(client, "host", "") or ""),
            self._internal_rpc_token,
        )

    @classmethod
    def _serialize(cls, value: Any) -> Any:
        if isinstance(value, datetime):
            return value.isoformat(sep=" ", timespec="seconds")
        if isinstance(value, Mapping):
            return {str(key): cls._serialize(item) for key, item in value.items()}
        if isinstance(value, list):
            return [cls._serialize(item) for item in value]
        return value

    def _log(self, message: str, *args: Any) -> None:
        if self.logger is not None:
            self.logger.warning("[EPAutoPurchase] " + message, *args)
