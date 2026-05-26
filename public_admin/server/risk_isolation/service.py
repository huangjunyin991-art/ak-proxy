from typing import Any, Callable

from .repository import RiskIsolationRepository
from .schema import RiskIsolationScope, normalize_username


class RiskIsolationService:
    def __init__(self, repository: RiskIsolationRepository,
                 super_admin_role: str, sub_admin_role: str,
                 sub_admin_exists: Callable[[str], bool]):
        self.repository = repository
        self.super_admin_role = super_admin_role
        self.sub_admin_role = sub_admin_role
        self.sub_admin_exists = sub_admin_exists

    async def initialize(self) -> None:
        await self.repository.ensure_schema()

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
        if role != self.super_admin_role:
            return []
        return await self.repository.list_sub_admin_scopes()

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
        return await self.repository.isolate_usernames(
            allowed,
            operator=operator,
            operator_role=operator_role,
            reason=reason,
        )

    async def isolate_scope(self, scope: RiskIsolationScope, operator: str,
                            operator_role: str, reason: str = '') -> dict[str, Any]:
        if scope.added_by == '__deny__':
            return {'updated': 0, 'usernames': []}
        usernames = await self.repository.usernames_by_added_by(scope.added_by or None)
        return await self.repository.isolate_usernames(
            usernames,
            operator=operator,
            operator_role=operator_role,
            reason=reason,
        )

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
        return await self.repository.is_isolated(username)
