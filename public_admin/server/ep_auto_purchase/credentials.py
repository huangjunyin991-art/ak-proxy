from __future__ import annotations

import inspect


class EPAutoPurchaseCredentials:
    """Keep EP configuration separate from the central account credential store."""

    def __init__(self, repository, auth_store, on_password_updated=None) -> None:
        self.repository = repository
        self.auth_store = auth_store
        self.on_password_updated = on_password_updated

    async def get_password(self, account: str) -> str:
        getter = getattr(self.auth_store, "get_user_password", None)
        if callable(getter):
            password = str(await getter(account) or "")
            if password:
                return password
        password = await self.repository.get_account_password(account)
        return password

    async def update_password(self, account: str, password: str) -> bool:
        normalized_account = str(account or "").strip().lower()
        new_password = str(password or "")
        if not normalized_account or not new_password:
            return False

        updater = getattr(self.auth_store, "update_user_saved_password", None)
        if not callable(updater) or not await updater(normalized_account, new_password):
            return False

        # An AK Key remains usable independently of a later password update. Keep the
        # persisted login state; the worker refreshes it only after an upstream auth error.
        if callable(self.on_password_updated):
            callback_result = self.on_password_updated(normalized_account)
            if inspect.isawaitable(callback_result):
                await callback_result
        return True
