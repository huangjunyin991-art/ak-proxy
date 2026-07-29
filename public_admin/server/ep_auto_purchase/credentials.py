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
        return await self.repository.get_account_password(account)

    async def update_password(self, account: str, password: str) -> bool:
        normalized_account = str(account or "").strip().lower()
        new_password = str(password or "")
        if not normalized_account or not new_password.strip():
            return False

        old_password = await self.repository.get_account_password(normalized_account)
        updater = getattr(self.auth_store, "update_user_saved_password", None)
        if not callable(updater) or not await updater(normalized_account, new_password):
            return False

        if old_password != new_password:
            clearer = getattr(self.auth_store, "clear_ak_auth_state", None)
            if callable(clearer):
                await clearer(normalized_account)
            if callable(self.on_password_updated):
                callback_result = self.on_password_updated(normalized_account)
                if inspect.isawaitable(callback_result):
                    await callback_result
        return True
