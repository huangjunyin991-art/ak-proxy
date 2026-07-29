from __future__ import annotations

import asyncio
import hashlib
import time
import uuid
from datetime import datetime
from typing import Any, Mapping

from ..notice_guidance.provider import make_v
from ..upstream_rpc_gate import RpcGateBusy
from .provider import EPAutoPurchaseProvider, EPAutoPurchaseUpstreamError, extract_auth_fields


class EPAutoPurchaseService:
    def __init__(self, repository, auth_store, rpc_gate, logger=None) -> None:
        self.repository = repository
        self.auth_store = auth_store
        self.rpc_gate = rpc_gate
        self.logger = logger
        self.provider = EPAutoPurchaseProvider()
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
        seen: set[str] = set()
        for value in raw_accounts if isinstance(raw_accounts, list) else []:
            account = str(value or "").strip().lower()
            if account and account not in seen:
                seen.add(account)
                accounts.append(account)
        try:
            interval_seconds = int(payload.get("interval_seconds") or 1)
        except (TypeError, ValueError):
            raise ValueError("抢分间隔必须是整数秒")
        if not 1 <= interval_seconds <= 3600:
            raise ValueError("抢分间隔必须在 1 到 3600 秒之间")
        active = {str(item.get("username") or "").strip().lower() for item in await self.repository.list_active_accounts()}
        invalid = [account for account in accounts if account not in active]
        if invalid:
            raise ValueError("以下账号不在有效白名单中：" + "、".join(invalid[:8]))
        enabled = bool(payload.get("enabled"))
        if enabled and not accounts:
            raise ValueError("启用前至少配置一个抢分账号")
        config = await self.repository.save_config(accounts, interval_seconds, enabled)
        self._wake.set()
        return self._serialize(config)

    async def dashboard(self) -> dict[str, Any]:
        data = await self.repository.dashboard()
        active_accounts = await self.repository.list_active_accounts()
        return {
            "success": True,
            "config": self._serialize(data.get("config") or {}),
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
            rows = await self._gated_call(
                auth.get("user_id") or account,
                lambda: self.provider.list_pending(client, auth),
            )
            return rows, auth
        except EPAutoPurchaseUpstreamError as exc:
            if not exc.is_auth_error:
                raise
        auth = await self._refresh_auth(client, account)
        rows = await self._gated_call(
            auth.get("user_id") or account,
            lambda: self.provider.list_pending(client, auth),
        )
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
        lease = await self.rpc_gate.try_reserve_background(auth.get("user_id") or buyer_account)
        if lease is None:
            raise RpcGateBusy()
        try:
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
            except Exception as exc:
                await self.repository.finish_order(sid, "unknown", str(exc) or exc.__class__.__name__)
                self._log("purchase result unknown account=%s sid=%s error=%s", buyer_account, sid, str(exc)[:200])
                return False
            state = "success" if result.get("success") else "rejected"
            await self.repository.finish_order(sid, state, str(result.get("message") or ""))
            return state == "success"
        finally:
            await self.rpc_gate.release(lease)

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
        password = ""
        getter = getattr(self.auth_store, "get_user_password", None)
        if callable(getter):
            password = str(await getter(account) or "").strip()
        if not password:
            password = await self.repository.get_account_password(account)
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
