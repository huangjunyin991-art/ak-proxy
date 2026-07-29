from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import datetime
from typing import Any, Mapping

from ..notice_guidance.provider import make_v
from ..upstream_rpc_gate import RpcGateBusy
from .credentials import EPAutoPurchaseCredentials
from .internal_rpc import create_internal_rpc_token, is_trusted_internal_rpc_request
from .provider import EPAutoPurchaseProvider, EPAutoPurchaseUpstreamError, extract_auth_fields


class EPAutoPurchaseService:
    def __init__(
        self,
        repository,
        auth_store,
        rpc_gate,
        logger=None,
        provider=None,
        on_password_updated=None,
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
        self.instance_id = "ep-auto-purchase-" + uuid.uuid4().hex
        self._task: asyncio.Task | None = None
        self._stopping = asyncio.Event()
        self._wake = asyncio.Event()

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
        if isinstance(raw_accounts, str):
            raw_accounts = raw_accounts.replace(",", "\n").splitlines()
        accounts: list[str] = []
        password_updates: dict[str, str] = {}
        seen: set[str] = set()
        for value in raw_accounts if isinstance(raw_accounts, list) else []:
            if isinstance(value, Mapping):
                account = str(value.get("account") or value.get("username") or "").strip().lower()
                password = str(value.get("password") or "")
            else:
                account = str(value or "").strip().lower()
                password = ""
            if not account:
                continue
            if account in seen:
                raise ValueError(f"抢分账号不能重复：{account}")
            seen.add(account)
            accounts.append(account)
            if password.strip():
                password_updates[account] = password
        try:
            interval_seconds = int(payload.get("interval_seconds") or 1)
        except (TypeError, ValueError):
            raise ValueError("抢分间隔必须是整数秒")
        if not 1 <= interval_seconds <= 3600:
            raise ValueError("抢分间隔必须在 1 到 3600 秒之间")
        active_rows = await self.repository.list_active_accounts()
        active = {
            str(item.get("username") or "").strip().lower(): item
            for item in active_rows
        }
        invalid = [account for account in accounts if account not in active]
        if invalid:
            raise ValueError("以下账号不在有效白名单中：" + "、".join(invalid[:8]))
        missing_passwords = [
            account
            for account in accounts
            if account not in password_updates and not bool(active[account].get("has_password"))
        ]
        if missing_passwords:
            raise ValueError("以下账号没有已保存密码，请先输入密码：" + "、".join(missing_passwords[:8]))
        enabled = bool(payload.get("enabled"))
        if enabled and not accounts:
            raise ValueError("启用前至少配置一个抢分账号")
        for account, password in password_updates.items():
            if not await self.credentials.update_password(account, password):
                raise ValueError(f"账号 {account} 的密码更新失败")
        config = await self.repository.save_config(accounts, interval_seconds, enabled)
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
        config = dict(data.get("config") or {})
        config["account_rows"] = [
            {
                "account": account,
                "has_password": bool(active_by_account.get(account, {}).get("has_password")),
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

    async def _run(self) -> None:
        while not self._stopping.is_set():
            did_work = False
            try:
                poll = await self.repository.claim_next_poll(self.instance_id)
                if poll is not None:
                    did_work = True
                    await self._process_poll(str(poll.get("account") or ""))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._log("worker iteration failed: %s", str(exc)[:500])
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=0.2 if did_work else 1.0)
            except asyncio.TimeoutError:
                pass

    async def _process_poll(self, account: str) -> None:
        listings_seen = 0
        successes = 0
        error = ""
        retry_seconds = 0
        state = "ready"
        try:
            async with self.provider.build_client() as client:
                auth = await self._load_auth(account)
                rows, auth = await self._list_with_one_refresh(client, account, auth)
                listings_seen = len(rows)
                for row in rows:
                    if await self._purchase_listing(client, account, auth, row):
                        successes += 1
        except RpcGateBusy:
            state = "waiting"
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
                listings_seen=listings_seen,
                purchase_successes=successes,
                error=error,
                retry_seconds=retry_seconds,
                count_poll=state != "waiting",
            )
        if error:
            self._log("poll failed account=%s error=%s", account, error[:300])

    async def _list_with_one_refresh(
        self,
        client,
        account: str,
        auth: dict[str, str],
    ) -> tuple[list[dict[str, Any]], dict[str, str]]:
        if not auth.get("key") or not auth.get("user_id"):
            auth = await self._refresh_auth(client, account)
        try:
            rows = await self.provider.list_pending(client, auth)
            return rows, auth
        except EPAutoPurchaseUpstreamError as exc:
            if not exc.is_auth_error:
                raise
        auth = await self._refresh_auth(client, account)
        rows = await self.provider.list_pending(client, auth)
        return rows, auth

    async def _purchase_listing(
        self,
        client,
        buyer_account: str,
        auth: Mapping[str, str],
        row: Mapping[str, Any],
    ) -> bool:
        sid = str(row.get("sId") or row.get("SId") or row.get("id") or "").strip()
        sokey = str(row.get("Sokey") or row.get("SoKey") or "").strip()
        if not sid or not sokey:
            return False
        claimed = await self.repository.claim_order(
            sid,
            buyer_account,
            str(row.get("Account") or row.get("account") or "").strip(),
            str(row.get("EPAmount") or row.get("epAmount") or "").strip(),
            hashlib.sha256(sokey.encode("utf-8")).hexdigest(),
        )
        if not claimed:
            return False
        try:
            result = await self.provider.buy(client, auth, sid, sokey)
        except RpcGateBusy:
            await self.repository.release_order_claim(sid, buyer_account)
            raise
        except Exception as exc:
            await self.repository.finish_order(sid, "unknown", str(exc) or exc.__class__.__name__)
            self._log("purchase result unknown account=%s sid=%s error=%s", buyer_account, sid, str(exc)[:200])
            return False
        state = "success" if result.get("success") else "rejected"
        await self.repository.finish_order(sid, state, str(result.get("message") or ""))
        return state == "success"

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
            raise EPAutoPurchaseUpstreamError("账号缺少可用登录密码")
        payload = await self._gated_call(
            account,
            lambda: self.provider.post_rpc(
                client,
                "Login",
                {"account": account, "password": password, "v": make_v(), "lang": "cn"},
            ),
        )
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
