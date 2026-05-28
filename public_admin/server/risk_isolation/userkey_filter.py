import asyncio
from typing import Any

from .repository import RiskIsolationRepository
from .schema import normalize_username


class RiskIsolationUserKeyFilter:
    KEY_FIELDS = ('key', 'Key', 'Userkey', 'UserKey', 'userkey', 'user_key', 'ukey', 'usekey', 'UseKey', 'Usekey')

    def __init__(self, repository: RiskIsolationRepository, logger=None):
        self.repository = repository
        self.logger = logger
        self._keys: set[str] = set()
        self._username_by_key: dict[str, str] = {}
        self._ready = False
        self._lock = asyncio.Lock()

    async def initialize(self) -> None:
        await self.repository.ensure_ready()
        usernames = await self.repository.list_active_isolated_usernames()
        if usernames:
            await self.repository.sync_userkeys_from_local_auth(usernames, source='startup_active_isolation')
        await self.reload()
        self._ready = True

    @property
    def ready(self) -> bool:
        return self._ready

    def is_empty(self) -> bool:
        return not self._keys

    async def reload(self) -> dict[str, Any]:
        rows = await self.repository.list_active_userkeys()
        keys: set[str] = set()
        username_by_key: dict[str, str] = {}
        for row in rows:
            userkey = self.normalize_userkey(row.get('userkey'))
            if not userkey:
                continue
            keys.add(userkey)
            username_by_key[userkey] = normalize_username(row.get('username'))
        async with self._lock:
            self._keys = keys
            self._username_by_key = username_by_key
        if self.logger:
            self.logger.info(f"[RiskIsolationUserKeyFilter] 已加载隔离key total={len(keys)}")
        return {'total': len(keys)}

    async def on_accounts_isolated(self, usernames: list[str]) -> dict[str, Any]:
        result = await self.repository.sync_userkeys_from_local_auth(usernames)
        for item in result.get('keys') or []:
            userkey = self.normalize_userkey(item.get('userkey'))
            username = normalize_username(item.get('username'))
            if not userkey:
                continue
            async with self._lock:
                self._keys.add(userkey)
                self._username_by_key[userkey] = username
        if self.logger:
            self.logger.info(
                f"[RiskIsolationUserKeyFilter] 隔离同步本地key usernames={len(usernames or [])} keys={result.get('updated', 0)}"
            )
        return result

    async def on_accounts_released(self, usernames: list[str]) -> dict[str, Any]:
        normalized = [normalize_username(username) for username in usernames or [] if normalize_username(username)]
        result = await self.repository.release_userkeys_by_usernames(normalized)
        if normalized:
            normalized_set = set(normalized)
            async with self._lock:
                stale_keys = [key for key, username in self._username_by_key.items() if username in normalized_set]
                for key in stale_keys:
                    self._keys.discard(key)
                    self._username_by_key.pop(key, None)
        if self.logger:
            self.logger.info(
                f"[RiskIsolationUserKeyFilter] 解除隔离同步key usernames={len(normalized)} keys={result.get('updated', 0)}"
            )
        return result

    def match_params(self, params: dict[str, Any] | None) -> dict[str, Any] | None:
        if not self._keys or not isinstance(params, dict):
            return None
        for field in self.KEY_FIELDS:
            userkey = self.normalize_userkey(params.get(field))
            if userkey and userkey in self._keys:
                return {'userkey': userkey, 'username': self._username_by_key.get(userkey, '')}
        return None

    @staticmethod
    def normalize_userkey(value: Any) -> str:
        return str(value or '').strip()
