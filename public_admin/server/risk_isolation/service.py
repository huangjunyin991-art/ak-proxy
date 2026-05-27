from typing import Any, Awaitable, Callable

from .repository import RiskIsolationRepository
from .schema import RiskIsolationScope, normalize_username


class RiskIsolationService:
    def __init__(self, repository: RiskIsolationRepository,
                 super_admin_role: str, sub_admin_role: str,
                 sub_admin_exists: Callable[[str], bool],
                 on_isolated: Callable[[list[str]], Awaitable[dict[str, Any]]] | None = None,
                 load_404_page_enabled: Callable[[], Awaitable[bool]] | None = None,
                 save_404_page_enabled: Callable[[bool], Awaitable[bool]] | None = None):
        self.repository = repository
        self.super_admin_role = super_admin_role
        self.sub_admin_role = sub_admin_role
        self.sub_admin_exists = sub_admin_exists
        self.on_isolated = on_isolated
        self.load_404_page_enabled = load_404_page_enabled
        self.save_404_page_enabled = save_404_page_enabled
        self.initialized = False

    async def initialize(self) -> None:
        await self.repository.ensure_schema()
        self.initialized = True

    def resolve_scope(self, role: str, sub_name: str = '', requested_sub_admin: str = '') -> RiskIsolationScope:
        normalized_role = str(role or '').strip()
        normalized_sub_name = str(sub_name or '').strip()
        requested = str(requested_sub_admin or '').strip()
        if normalized_role == self.super_admin_role:
            added_by = requested if requested and self.sub_admin_exists(requested) else ''
            return RiskIsolationScope(
                role=normalized_role,
                sub_name=normalized_sub_name,
                added_by=added_by,
                requested_sub_admin=requested,
                is_super_admin=True,
            )
        if normalized_role == self.sub_admin_role and normalized_sub_name:
            return RiskIsolationScope(
                role=normalized_role,
                sub_name=normalized_sub_name,
                added_by=normalized_sub_name,
                requested_sub_admin=normalized_sub_name,
                is_super_admin=False,
            )
        return RiskIsolationScope(
            role=normalized_role,
            sub_name=normalized_sub_name,
            added_by='__deny__',
            requested_sub_admin=requested,
            is_super_admin=False,
        )

    async def list_sub_admin_scopes(self, role: str) -> list[dict[str, Any]]:
        if not self.initialized:
            return []
        if role != self.super_admin_role:
            return []
        return await self.repository.list_sub_admin_scopes()

    async def get_404_page_enabled(self) -> bool:
        if self.load_404_page_enabled is None:
            return True
        return bool(await self.load_404_page_enabled())

    async def set_404_page_enabled(self, enabled: bool) -> bool:
        if self.save_404_page_enabled is None:
            return False
        return bool(await self.save_404_page_enabled(bool(enabled)))

    async def list_accounts(self, scope: RiskIsolationScope, search: str = '',
                            limit: int = 200, offset: int = 0) -> dict[str, Any]:
        if scope.added_by == '__deny__':
            return {'total': 0, 'isolated_total': 0, 'rows': []}
        added_by = scope.added_by or None
        result = await self.repository.list_accounts(
            added_by=added_by,
            search=str(search or '').strip() or None,
            limit=limit,
            offset=offset,
        )
        result['scope'] = {
            'is_super_admin': scope.is_super_admin,
            'added_by': scope.added_by,
            'requested_sub_admin': scope.requested_sub_admin,
        }
        return result

    async def isolate_usernames(self, scope: RiskIsolationScope, usernames: list[str],
                                operator: str, operator_role: str, reason: str = '') -> dict[str, Any]:
        if scope.added_by == '__deny__':
            return {'updated': 0, 'usernames': []}
        allowed = await self.repository.filter_allowed_usernames(
            usernames,
            added_by=scope.added_by or None,
        )
        result = await self.repository.isolate_usernames(
            allowed,
            operator=operator,
            operator_role=operator_role,
            reason=reason,
        )
        await self._notify_isolated(result)
        return result

    async def isolate_scope(self, scope: RiskIsolationScope, operator: str,
                            operator_role: str, reason: str = '') -> dict[str, Any]:
        if scope.added_by == '__deny__':
            return {'updated': 0, 'usernames': []}
        usernames = await self.repository.usernames_by_added_by(scope.added_by or None)
        result = await self.repository.isolate_usernames(
            usernames,
            operator=operator,
            operator_role=operator_role,
            reason=reason,
        )
        await self._notify_isolated(result)
        return result

    async def _notify_isolated(self, result: dict[str, Any]) -> None:
        if self.on_isolated is None:
            return
        usernames = result.get('usernames') or []
        if not usernames:
            return
        result['userkey_refresh'] = await self.on_isolated(usernames)

    async def release_usernames(self, scope: RiskIsolationScope, usernames: list[str]) -> dict[str, Any]:
        if scope.added_by == '__deny__':
            return {'updated': 0, 'usernames': []}
        return await self.repository.release_usernames(
            [normalize_username(username) for username in usernames or []],
            added_by=scope.added_by or None,
        )

    async def release_scope(self, scope: RiskIsolationScope) -> dict[str, Any]:
        if scope.added_by == '__deny__':
            return {'updated': 0, 'usernames': []}
        return await self.repository.release_scope(
            added_by=scope.added_by or None,
        )

    async def should_hide_login(self, username: str) -> bool:
        if not self.initialized:
            return False
        return await self.repository.is_isolated(username)
