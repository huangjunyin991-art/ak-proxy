import json


class OperationScopeResolver:
    def __init__(self):
        self.exact = {
            ('POST', '/api/ban'): 'ban_ops',
            ('POST', '/api/unban'): 'ban_ops',
            ('POST', '/admin/api/ban/user'): 'ban_ops',
            ('POST', '/admin/api/unban/user'): 'ban_ops',
            ('POST', '/admin/api/ban/ip'): 'ban_ops',
            ('POST', '/admin/api/unban/ip'): 'ban_ops',
            ('POST', '/admin/api/kick'): 'moderate_ops',
            ('POST', '/admin/api/chat/send'): 'moderate_ops',
            ('POST', '/admin/api/chat/broadcast'): 'moderate_ops',
            ('POST', '/admin/api/user/real_name'): 'moderate_ops',
            ('POST', '/admin/api/whitelist/nickname'): 'moderate_ops',
            ('POST', '/admin/api/notifications/send'): 'moderate_ops',
            ('POST', '/api/db/delete'): 'db_write_ops',
            ('POST', '/api/dispatcher/add'): 'dispatcher_ops',
            ('POST', '/api/dispatcher/remove'): 'dispatcher_ops',
            ('POST', '/api/dispatcher/detect_ips'): 'dispatcher_ops',
            ('POST', '/api/dispatcher/probe_latency'): 'dispatcher_ops',
            ('POST', '/api/dispatcher/rate_limit'): 'dispatcher_ops',
            ('POST', '/api/dispatcher/policy'): 'dispatcher_ops',
            ('POST', '/api/dispatcher/max_login'): 'dispatcher_ops',
            ('POST', '/api/dispatcher/start_singbox'): 'dispatcher_ops',
            ('POST', '/api/dispatcher/parse_sub'): 'dispatcher_ops',
            ('POST', '/api/dispatcher/apply_sub'): 'dispatcher_ops',
            ('POST', '/api/dispatcher/reload_singbox'): 'dispatcher_ops',
            ('POST', '/admin/api/db/sql'): 'db_write_ops',
            ('POST', '/admin/api/license/create'): 'account_ops',
            ('POST', '/admin/api/license/revoke'): 'account_ops',
            ('POST', '/admin/api/license/edit'): 'account_ops',
            ('POST', '/admin/api/license/blacklist/add'): 'account_ops',
            ('POST', '/admin/api/license/blacklist/remove'): 'account_ops',
            ('POST', '/admin/api/license/disable-client'): 'account_ops',
            ('POST', '/admin/api/license/enable-client'): 'account_ops',
            ('POST', '/admin/api/credits/config'): 'account_ops',
            ('POST', '/admin/api/credits/topup'): 'account_ops',
            ('POST', '/admin/api/meeting/permissions'): 'account_ops',
            ('POST', '/admin/api/meeting/sub_admin_toggle'): 'account_ops',
            ('POST', '/admin/api/meeting/permissions/revoke'): 'account_ops',
            ('POST', '/admin/api/whitelist/add'): 'account_ops',
            ('POST', '/admin/api/whitelist/renew'): 'account_ops',
            ('POST', '/admin/api/whitelist/delete'): 'account_ops',
            ('POST', '/admin/api/whitelist/set_global'): 'account_ops',
            ('POST', '/admin/api/risk-isolation/isolate'): 'account_ops',
            ('POST', '/admin/api/risk-isolation/isolate_scope'): 'account_ops',
            ('POST', '/admin/api/risk-isolation/release'): 'account_ops',
            ('POST', '/admin/api/risk-isolation/release_scope'): 'account_ops',
            ('POST', '/admin/api/sub_admin/set'): 'account_ops',
            ('POST', '/admin/api/sub_admin/bind_account'): 'account_ops',
            ('POST', '/admin/api/sub_admin/update_permissions'): 'account_ops',
            ('POST', '/admin/api/sub_admin/delete'): 'account_ops',
            ('POST', '/admin/api/sub_admin/kick'): 'account_ops',
            ('POST', '/admin/api/sub_admin/set_monitoring'): 'account_ops',
            ('POST', '/admin/api/ak_auth/clear'): 'dispatcher_ops',
            ('POST', '/admin/api/browse_login'): 'dispatcher_ops',
            ('POST', '/admin/api/remote_assist/start'): 'moderate_ops',
            ('POST', '/admin/api/remote_assist/close'): 'moderate_ops',
            ('POST', '/admin/api/remote_voice/start'): 'moderate_ops',
            ('POST', '/admin/api/remote_voice/close'): 'moderate_ops',
            ('POST', '/admin/api/im/groups/owner/transfer'): 'im_admin_ops',
            ('POST', '/admin/api/im/groups/admins/replace'): 'im_admin_ops',
            ('POST', '/admin/api/im/emoji_assets/import'): 'im_admin_ops',
            ('POST', '/admin/api/im/emoji_assets/upload'): 'im_admin_ops',
            ('POST', '/admin/api/im/file_assets/config'): 'im_admin_ops',
            ('POST', '/admin/api/im/image_upload/config'): 'im_admin_ops',
            ('GET', '/admin/api/operation_auth/secrets'): 'totp_secret_ops',
            ('POST', '/admin/api/operation_auth/secrets/reset'): 'totp_secret_ops',
            ('POST', '/admin/api/point-stats/sync'): 'point_stats_ops',
            ('POST', '/admin/api/point-stats/backfill/run'): 'point_stats_ops',
            ('GET', '/admin/api/point-stats'): 'point_stats_ops',
            ('GET', '/admin/api/point-stats/backfill/status'): 'point_stats_ops',
        }
        self.prefixes = [
            ('POST', '/admin/api/db/insert/', 'db_write_ops'),
            ('PUT', '/admin/api/db/update/', 'db_write_ops'),
            ('DELETE', '/admin/api/db/delete/', 'db_write_ops'),
            ('DELETE', '/admin/api/credits/config/', 'account_ops'),
            ('DELETE', '/admin/api/subscription_groups/', 'dispatcher_ops'),
            ('POST', '/admin/api/subscription_groups/', 'dispatcher_ops'),
            ('PATCH', '/admin/api/subscription_groups/', 'dispatcher_ops'),
            ('POST', '/admin/ak-rpc/', 'dispatcher_ops'),
            ('POST', '/admin/ak-site/', 'dispatcher_ops'),
            ('POST', '/admin/ak-web/', 'dispatcher_ops'),
            ('GET', '/admin/api/recommend-tree/', 'recommend_tree_ops'),
            ('POST', '/admin/api/recommend-tree/', 'recommend_tree_ops'),
        ]

    def resolve(self, method: str, path: str, body: bytes | None = None) -> str:
        normalized_method = str(method or '').upper()
        normalized_path = self._normalize_path(path)
        if normalized_method == 'POST' and normalized_path == '/admin/api/db/sql':
            return self._resolve_sql_scope(body)
        scope = self.exact.get((normalized_method, normalized_path))
        if scope:
            return scope
        for prefix_method, prefix, prefix_scope in self.prefixes:
            if normalized_method == prefix_method and normalized_path.startswith(prefix):
                return prefix_scope
        return ''

    def needs_body(self, method: str, path: str) -> bool:
        return str(method or '').upper() == 'POST' and self._normalize_path(path) == '/admin/api/db/sql'

    def _normalize_path(self, path: str) -> str:
        normalized = str(path or '').split('?', 1)[0]
        if len(normalized) > 1:
            normalized = normalized.rstrip('/')
        return normalized or '/'

    def _resolve_sql_scope(self, body: bytes | None) -> str:
        sql = ''
        if body:
            try:
                data = json.loads(body.decode('utf-8'))
                sql = str(data.get('sql') or '')
            except Exception:
                sql = ''
        token = self._first_sql_token(sql)
        if token in {'select', 'show', 'explain', 'describe'}:
            return 'db_read_ops'
        return 'db_write_ops'

    def _first_sql_token(self, sql: str) -> str:
        text = str(sql or '').lstrip()
        while text.startswith('--') or text.startswith('/*'):
            if text.startswith('--'):
                _, _, text = text.partition('\n')
                text = text.lstrip()
                continue
            end_index = text.find('*/')
            if end_index < 0:
                return ''
            text = text[end_index + 2:].lstrip()
        return text.split(None, 1)[0].strip('(').lower() if text else ''
