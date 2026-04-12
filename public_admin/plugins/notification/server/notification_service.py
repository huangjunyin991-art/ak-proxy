from __future__ import annotations

from typing import Any, Awaitable, Callable

from server import database_pg as db
from .notification_providers import NotificationProviderError, normalize_notification_payload


PushUserPayloadCallable = Callable[[str, dict[str, Any]], Awaitable[bool]]
BroadcastAdminEventCallable = Callable[[dict[str, Any]], Awaitable[Any]]
OnlineUsersSupplierCallable = Callable[[], list[dict[str, Any]]]


class NotificationService:
    def __init__(
        self,
        push_user_payload: PushUserPayloadCallable | None = None,
        broadcast_admin_event: BroadcastAdminEventCallable | None = None,
        online_users_supplier: OnlineUsersSupplierCallable | None = None,
    ):
        self._push_user_payload = push_user_payload
        self._broadcast_admin_event = broadcast_admin_event
        self._online_users_supplier = online_users_supplier

    async def publish_notification(
        self,
        *,
        notification_type: str,
        title: str,
        content: str,
        raw_payload: dict[str, Any],
        audience_mode: str,
        audience_options: dict[str, Any],
        created_by: str,
        role: str,
        sub_name: str,
    ) -> dict[str, Any]:
        normalized = normalize_notification_payload(notification_type, title, content, raw_payload)
        target_usernames = await self.resolve_audience(
            audience_mode=audience_mode,
            audience_options=audience_options,
            role=role,
            sub_name=sub_name,
        )
        if not target_usernames:
            raise NotificationProviderError('未选择任何可发送的目标用户')
        campaign = await db.create_notification_campaign(
            notification_type=normalized['notification_type'],
            title=normalized['title'],
            content=normalized['content'],
            payload=normalized.get('payload') or {},
            audience_mode=str(audience_mode or 'manual').strip().lower() or 'manual',
            audience_snapshot={
                'mode': str(audience_mode or 'manual').strip().lower() or 'manual',
                'options': audience_options or {},
            },
            created_by=created_by or 'system',
            usernames=target_usernames,
        )
        notification_item = await self.get_campaign_notification_item(int(campaign.get('id') or 0))
        if notification_item and self._push_user_payload:
            for username in target_usernames:
                await self._push_user_payload(username, {
                    'type': 'notification_new',
                    'notification': notification_item,
                })
        if self._broadcast_admin_event:
            await self._broadcast_admin_event({
                'type': 'notification_campaign_created',
                'data': {
                    'id': campaign.get('id'),
                    'notification_type': campaign.get('notification_type'),
                    'title': campaign.get('title'),
                    'target_count': campaign.get('target_count', len(target_usernames)),
                    'created_by': campaign.get('created_by'),
                    'time': campaign.get('created_at'),
                },
            })
        return {
            'campaign': campaign,
            'notification': notification_item,
            'target_count': len(target_usernames),
            'targets': target_usernames,
        }

    async def resolve_audience(
        self,
        *,
        audience_mode: str,
        audience_options: dict[str, Any],
        role: str,
        sub_name: str,
    ) -> list[str]:
        normalized_mode = str(audience_mode or 'manual').strip().lower() or 'manual'
        selected_usernames = _normalize_usernames(audience_options.get('usernames'))
        accessible_usernames = await self._get_accessible_usernames(role=role, sub_name=sub_name)
        if normalized_mode == 'manual':
            manual_usernames = _normalize_usernames(selected_usernames or audience_options.get('usernames_text'))
            return _apply_access_scope(manual_usernames, accessible_usernames)
        if normalized_mode == 'online':
            online_usernames = []
            if self._online_users_supplier:
                online_usernames = _normalize_usernames([
                    item.get('username') for item in (self._online_users_supplier() or []) if isinstance(item, dict)
                ])
            if selected_usernames:
                online_set = set(online_usernames)
                online_usernames = [username for username in selected_usernames if username in online_set]
            return _apply_access_scope(online_usernames, accessible_usernames)
        if normalized_mode == 'whitelist':
            search = str(audience_options.get('search') or '').strip() or None
            status = str(audience_options.get('status') or 'active').strip() or None
            added_by = sub_name if role == 'sub_admin' and sub_name else None
            whitelist_data = await db.get_authorized_accounts(
                added_by=added_by,
                status=status,
                limit=5000,
                offset=0,
                search=search,
            )
            whitelist_usernames = _normalize_usernames([
                item.get('username') for item in (whitelist_data.get('rows') or []) if isinstance(item, dict)
            ])
            if selected_usernames:
                whitelist_set = set(whitelist_usernames)
                whitelist_usernames = [username for username in selected_usernames if username in whitelist_set]
            return whitelist_usernames
        raise NotificationProviderError(f'不支持的用户选择方式: {audience_mode}')

    async def build_snapshot(self, username: str, limit: int = 20) -> dict[str, Any]:
        normalized_username = _normalize_username(username)
        if not normalized_username:
            return {'items': [], 'unread_count': 0}
        items = await db.get_user_notification_items(normalized_username, limit=limit)
        unread_count = await db.get_notification_unread_count(normalized_username)
        return {'items': items, 'unread_count': unread_count}

    async def push_snapshot_to_user(self, username: str, reason: str = 'sync') -> bool:
        normalized_username = _normalize_username(username)
        if not normalized_username or not self._push_user_payload:
            return False
        snapshot = await self.build_snapshot(normalized_username)
        return await self._push_user_payload(normalized_username, {
            'type': 'notification_snapshot',
            'items': snapshot['items'],
            'unread_count': snapshot['unread_count'],
            'reason': reason,
        })

    async def mark_all_read(self, username: str) -> dict[str, Any]:
        normalized_username = _normalize_username(username)
        if not normalized_username:
            return {'campaign_ids': [], 'unread_count': 0}
        campaign_ids = await db.mark_all_notifications_read(normalized_username)
        unread_count = await db.get_notification_unread_count(normalized_username)
        if self._push_user_payload:
            await self._push_user_payload(normalized_username, {
                'type': 'notification_read_sync',
                'campaign_ids': campaign_ids,
                'unread_count': unread_count,
                'read_all': True,
            })
        return {'campaign_ids': campaign_ids, 'unread_count': unread_count}

    async def list_campaigns(self, *, limit: int, offset: int, role: str, sub_name: str) -> dict[str, Any]:
        created_by = sub_name if role == 'sub_admin' and sub_name else None
        return await db.get_notification_campaigns(limit=limit, offset=offset, created_by=created_by)

    async def get_campaign_notification_item(self, campaign_id: int) -> dict[str, Any] | None:
        if not campaign_id:
            return None
        return await db.get_notification_campaign_item(campaign_id)

    async def _get_accessible_usernames(self, *, role: str, sub_name: str) -> set[str] | None:
        if role != 'sub_admin' or not sub_name:
            return None
        rows = await db.get_authorized_accounts(added_by=sub_name, status='active', limit=5000, offset=0)
        return set(_normalize_usernames([item.get('username') for item in (rows.get('rows') or []) if isinstance(item, dict)]))


def _normalize_username(value: Any) -> str:
    username = str(value or '').strip().lower()
    return username


def _normalize_usernames(value: Any) -> list[str]:
    if isinstance(value, str):
        raw_items = [part.strip() for part in value.replace(';', ',').replace('\n', ',').split(',')]
    elif isinstance(value, (list, tuple, set)):
        raw_items = [str(item or '').strip() for item in value]
    else:
        raw_items = []
    seen: set[str] = set()
    normalized: list[str] = []
    for item in raw_items:
        username = _normalize_username(item)
        if not username or username in seen:
            continue
        seen.add(username)
        normalized.append(username)
    return normalized


def _apply_access_scope(usernames: list[str], accessible_usernames: set[str] | None) -> list[str]:
    if accessible_usernames is None:
        return usernames
    return [username for username in usernames if username in accessible_usernames]
