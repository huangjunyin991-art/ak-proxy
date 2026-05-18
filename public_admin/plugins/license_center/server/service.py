import secrets
import string
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

from .repository import LicenseCenterRepository


class LicenseCenterService:
    def __init__(self, repository: LicenseCenterRepository):
        self.repository = repository

    async def ensure_schema(self) -> None:
        await self.repository.ensure_schema()

    def generate_license_key(self) -> str:
        alphabet = string.ascii_uppercase + string.digits
        groups = []
        for _ in range(4):
            groups.append(''.join(secrets.choice(alphabet) for _ in range(5)))
        return '-'.join(groups)

    def normalize_billing_mode(self, value: str) -> str:
        mode = str(value or 'unlimited').strip().lower()
        if mode in ('count', 'per_use'):
            return 'per_use'
        if mode in ('time', 'time_based'):
            return 'time_based'
        return 'unlimited'

    async def create_license(self, data: Dict[str, Any], operator: str = 'admin') -> Dict[str, Any]:
        product_id = str(data.get('product_id') or 'ak_admin_panel').strip() or 'ak_admin_panel'
        billing_mode = self.normalize_billing_mode(data.get('billing_mode'))
        expiry_days = max(1, int(data.get('expiry_days') or 365))
        max_devices = max(1, int(data.get('max_devices') or 1))
        license_key = str(data.get('license_key') or '').strip().upper()
        if not license_key:
            license_key = self.generate_license_key()
        existing = await self.repository.get_license(license_key)
        while existing is not None:
            license_key = self.generate_license_key()
            existing = await self.repository.get_license(license_key)
        max_uses = None
        remaining_uses = None
        usage_time = None
        if billing_mode == 'per_use':
            max_uses = max(1, int(data.get('max_uses') or 100))
            remaining_uses = max_uses
        elif billing_mode == 'time_based':
            usage_days = float(data.get('usage_time') or data.get('usage_days') or 30)
            usage_time = max(1, int(usage_days * 1440))
        expiry_date = datetime.now() + timedelta(days=expiry_days)
        detail = f"有效期{expiry_days}天"
        if billing_mode == 'per_use':
            detail += f"，次数{max_uses}"
        if billing_mode == 'time_based':
            detail += f"，使用时长{usage_time}分钟"
        row = await self.repository.create_license({
            'license_key': license_key,
            'product_id': product_id,
            'billing_mode': billing_mode,
            'status': 'inactive',
            'max_devices': max_devices,
            'max_uses': max_uses,
            'remaining_uses': remaining_uses,
            'usage_time': usage_time,
            'expiry_date': expiry_date,
            'created_by': operator,
            'detail': detail,
            'metadata': {},
        })
        return {'error': False, 'message': '创建成功', 'data': self.format_license(row)}

    async def list_licenses(self, limit: int = 50, offset: int = 0) -> Dict[str, Any]:
        result = await self.repository.list_licenses(max(1, min(int(limit or 50), 200)), max(0, int(offset or 0)))
        return {'error': False, 'data': {'total': result['total'], 'items': [self.format_license(row) for row in result['items']]}}

    async def get_license_info(self, license_key: str) -> Dict[str, Any]:
        row = await self.repository.get_license(str(license_key or '').strip().upper())
        if not row:
            return {'error': True, 'message': '激活码不存在'}
        return {'error': False, 'data': self.format_license(row)}

    async def revoke_license(self, license_key: str, reason: str = '', operator: str = 'admin') -> Dict[str, Any]:
        key = str(license_key or '').strip().upper()
        row = await self.repository.update_license(key, {'status': 'revoked'})
        if not row:
            return {'error': True, 'message': '激活码不存在'}
        await self.repository.add_legacy_log('revoke', key, row.get('product_id'), row.get('billing_mode'), reason or '撤销激活码', operator)
        return {'error': False, 'message': '撤销成功', 'data': self.format_license(row)}

    async def edit_license(self, data: Dict[str, Any], operator: str = 'admin') -> Dict[str, Any]:
        key = str(data.get('license_key') or '').strip().upper()
        if not key:
            return {'error': True, 'message': '缺少激活码'}
        fields = {}
        for name in ('product_id', 'max_devices', 'max_uses', 'remaining_uses', 'usage_time', 'status'):
            if name in data:
                fields[name] = data[name]
        if 'billing_mode' in data:
            fields['billing_mode'] = self.normalize_billing_mode(data.get('billing_mode'))
        if 'expiry_days' in data:
            fields['expiry_date'] = datetime.now() + timedelta(days=max(1, int(data.get('expiry_days') or 1)))
        row = await self.repository.update_license(key, fields)
        if not row:
            return {'error': True, 'message': '激活码不存在'}
        await self.repository.add_legacy_log('edit', key, row.get('product_id'), row.get('billing_mode'), '编辑激活码', operator)
        return {'error': False, 'message': '保存成功', 'data': self.format_license(row)}

    async def statistics(self) -> Dict[str, Any]:
        return {'error': False, 'data': await self.repository.statistics()}

    async def products(self) -> Dict[str, Any]:
        return {'error': False, 'data': {'items': await self.repository.list_products()}}

    async def health(self) -> Dict[str, Any]:
        return {'error': False, 'success': True, 'message': '授权中心正常', 'data': {'mode': 'local'}}

    async def admin_logs(self, limit: int = 100, offset: int = 0) -> Dict[str, Any]:
        result = await self.repository.list_verification_logs(max(1, min(int(limit or 100), 200)), max(0, int(offset or 0)))
        return {'error': False, 'data': result}

    async def list_clients(self, limit: int = 100, offset: int = 0) -> Dict[str, Any]:
        result = await self.repository.list_devices(max(1, min(int(limit or 100), 200)), max(0, int(offset or 0)))
        return {'error': False, 'data': {'total': result['total'], 'items': [self.format_device(row) for row in result['items']]}}

    async def client_detail(self, client_id: str) -> Dict[str, Any]:
        row = await self.repository.get_device(client_id)
        if not row:
            return {'error': True, 'message': '客户端不存在'}
        return {'error': False, 'data': self.format_device(row)}

    async def set_client_status(self, data: Dict[str, Any], status: str, operator: str = 'admin') -> Dict[str, Any]:
        device_id = str(data.get('client_id') or data.get('device_id') or data.get('machine_id') or '').strip()
        if not device_id:
            return {'error': True, 'message': '客户端标识不能为空'}
        row = await self.repository.set_device_status(device_id, status)
        if not row:
            return {'error': True, 'message': '客户端不存在'}
        await self.repository.add_legacy_log(status, row.get('license_key'), row.get('product_id'), None, row.get('machine_id'), operator)
        return {'error': False, 'message': '操作成功', 'data': self.format_device(row)}

    async def blacklist_add(self, data: Dict[str, Any], operator: str = 'admin') -> Dict[str, Any]:
        target_type = str(data.get('target_type') or data.get('type') or 'machine_id').strip()
        target_value = str(data.get('target_value') or data.get('value') or data.get('machine_id') or data.get('license_key') or '').strip()
        if not target_value:
            return {'error': True, 'message': '封禁目标不能为空'}
        row = await self.repository.add_blacklist(target_type, target_value, str(data.get('reason') or ''), operator)
        return {'error': False, 'message': '已加入黑名单', 'data': row}

    async def blacklist_remove(self, data: Dict[str, Any], operator: str = 'admin') -> Dict[str, Any]:
        target_type = str(data.get('target_type') or data.get('type') or 'machine_id').strip()
        target_value = str(data.get('target_value') or data.get('value') or data.get('machine_id') or data.get('license_key') or '').strip()
        if not target_value:
            return {'error': True, 'message': '解封目标不能为空'}
        ok = await self.repository.remove_blacklist(target_type, target_value, operator)
        return {'error': False, 'message': '已移出黑名单' if ok else '黑名单记录不存在'}

    async def blacklist_list(self) -> Dict[str, Any]:
        return {'error': False, 'data': {'items': await self.repository.list_blacklist()}}

    async def activate(self, data: Dict[str, Any], ip_address: str = '') -> Dict[str, Any]:
        return await self._verify_or_activate(data, ip_address, activate=True)

    async def verify(self, data: Dict[str, Any], ip_address: str = '') -> Dict[str, Any]:
        return await self._verify_or_activate(data, ip_address, activate=False)

    async def consume(self, data: Dict[str, Any], ip_address: str = '') -> Dict[str, Any]:
        verify_result = await self._verify_or_activate(data, ip_address, activate=False)
        if verify_result.get('error'):
            return verify_result
        key = str(data.get('license_key') or verify_result.get('data', {}).get('license_key') or '').strip().upper()
        row = await self.repository.get_license(key)
        if not row:
            return {'error': True, 'message': '激活码不存在'}
        if row.get('billing_mode') == 'per_use':
            remaining = row.get('remaining_uses')
            if remaining is not None and int(remaining) <= 0:
                return {'error': True, 'message': '使用次数已用完', 'error_code': 'LICENSE_EXPIRED'}
            row = await self.repository.update_license(key, {'remaining_uses': int(remaining or 0) - 1})
        await self.repository.add_verification_log(self._log_payload(data, ip_address, 'consume', 'success', '消耗成功'))
        return {'error': False, 'message': '消耗成功', 'data': self.format_license(row)}

    async def check_update(self, product_id: str, current_version: str, channel: str = 'stable') -> Dict[str, Any]:
        product_id = str(product_id or 'ak_admin_panel').strip()
        release = await self.repository.get_latest_release(product_id, channel or 'stable')
        if not release:
            return {'error': False, 'data': {'has_update': False}}
        has_update = self.compare_versions(str(release.get('version') or ''), str(current_version or '')) > 0
        if not has_update:
            return {'error': False, 'data': {'has_update': False}}
        data = self.format_update(release)
        data['has_update'] = True
        return {'error': False, 'data': data}

    async def _verify_or_activate(self, data: Dict[str, Any], ip_address: str, activate: bool) -> Dict[str, Any]:
        product_id = str(data.get('product_id') or 'ak_admin_panel').strip()
        license_key = str(data.get('license_key') or '').strip().upper()
        machine_id = str(data.get('machine_id') or '').strip()
        account_name = str(data.get('account_name') or '').strip()
        client_version = str(data.get('client_version') or '').strip()
        action = 'activate' if activate else 'verify'
        if not license_key and machine_id:
            found = await self.repository.find_license_by_machine(machine_id, product_id)
            if found:
                license_key = str(found.get('license_key') or '')
        if not license_key:
            result = {'error': True, 'message': '缺少激活码', 'error_code': 'LICENSE_REQUIRED'}
            await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
            return result
        row = await self.repository.get_license(license_key)
        if not row:
            result = {'error': True, 'message': '激活码不存在', 'error_code': 'LICENSE_NOT_FOUND'}
            await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
            return result
        if product_id and row.get('product_id') != product_id:
            result = {'error': True, 'message': '产品不匹配', 'error_code': 'PRODUCT_MISMATCH'}
            await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
            return result
        ban = await self.find_blacklist(row, machine_id, account_name, ip_address)
        if ban:
            result = {'error': True, 'message': ban.get('reason') or '设备或授权已被封禁', 'error_code': 'LICENSE_BANNED', 'data': {'banned': True, 'ban_reason': ban.get('reason') or ''}}
            await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
            return result
        validity_error = self.validate_license_time_and_count(row)
        if validity_error:
            await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', validity_error['message']))
            return validity_error
        if row.get('status') == 'revoked':
            result = {'error': True, 'message': '激活码已撤销', 'error_code': 'LICENSE_REVOKED'}
            await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
            return result
        if machine_id:
            bound_device = await self.repository.get_license_device(license_key, machine_id)
            if bound_device and bound_device.get('status') != 'active':
                result = {'error': True, 'message': '客户端已被禁用', 'error_code': 'CLIENT_DISABLED'}
                await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
                return result
            device_count = await self.repository.count_devices(license_key)
            existing = await self.repository.find_license_by_machine(machine_id, product_id)
            if device_count >= int(row.get('max_devices') or 1) and (not existing or existing.get('license_key') != license_key):
                result = {'error': True, 'message': '设备数量已达上限', 'error_code': 'DEVICE_LIMIT_EXCEEDED'}
                await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
                return result
            if row.get('status') == 'inactive' or activate:
                await self.repository.upsert_device(license_key, product_id, machine_id, data.get('hardware') or data.get('hardware_fingerprint') or {}, account_name, client_version, ip_address)
                if row.get('status') == 'inactive':
                    row = await self.repository.update_license(license_key, {'status': 'active', 'activated_at': datetime.now()})
            elif row.get('status') == 'active':
                await self.repository.upsert_device(license_key, product_id, machine_id, data.get('hardware') or data.get('hardware_fingerprint') or {}, account_name, client_version, ip_address)
        elif activate:
            result = {'error': True, 'message': '缺少机器码', 'error_code': 'MACHINE_ID_REQUIRED'}
            await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
            return result
        formatted = self.format_license(row)
        update_result = await self.check_update(product_id, client_version, str(data.get('channel') or 'stable'))
        if not update_result.get('error'):
            formatted['update_available'] = update_result.get('data') or {'has_update': False}
        await self.repository.add_verification_log(self._log_payload(dict(data, license_key=license_key), ip_address, action, 'success', '验证成功'))
        return {'error': False, 'message': '激活成功' if activate else '验证成功', 'data': formatted}

    async def find_blacklist(self, row: Dict[str, Any], machine_id: str, account_name: str, ip_address: str) -> Optional[Dict[str, Any]]:
        checks = [
            ('license_key', row.get('license_key')),
            ('machine_id', machine_id),
            ('account_name', account_name),
            ('ip', ip_address),
        ]
        for target_type, target_value in checks:
            ban = await self.repository.is_blacklisted(target_type, str(target_value or '').strip())
            if ban:
                return ban
        return None

    def validate_license_time_and_count(self, row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        status = str(row.get('status') or '')
        if status not in ('inactive', 'active'):
            return {'error': True, 'message': '激活码不可用', 'error_code': 'LICENSE_INVALID'}
        expiry_date = row.get('expiry_date')
        if expiry_date and expiry_date < datetime.now():
            return {'error': True, 'message': '激活码已过期', 'error_code': 'LICENSE_EXPIRED', 'data': {'expired': True}}
        if row.get('billing_mode') == 'per_use':
            remaining = row.get('remaining_uses')
            if remaining is not None and int(remaining) <= 0:
                return {'error': True, 'message': '使用次数已用完', 'error_code': 'LICENSE_EXPIRED', 'data': {'expired': True}}
        return None

    def format_license(self, row: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if not row:
            return {}
        result = dict(row)
        mode = self.normalize_billing_mode(result.get('billing_mode'))
        result['billing_mode'] = mode
        result['valid'] = result.get('status') == 'active'
        if mode == 'time_based':
            result['remaining_time'] = self.remaining_minutes(result.get('activated_at'), result.get('usage_time'), result.get('expiry_date'))
        elif mode == 'per_use':
            result['remaining_time'] = None
        else:
            result['remaining_time'] = None
            result['remaining_uses'] = None
        result['expiry_date'] = result.get('expiry_date')
        result['is_unlimited'] = mode == 'unlimited'
        return result

    def remaining_minutes(self, activated_at: Any, usage_time: Any, expiry_date: Any) -> int:
        now = datetime.now()
        candidates = []
        if activated_at and usage_time:
            candidates.append(activated_at + timedelta(minutes=int(usage_time or 0)))
        if expiry_date:
            candidates.append(expiry_date)
        if not candidates:
            return 0
        expires_at = min(candidates)
        return max(0, int((expires_at - now).total_seconds() / 60))

    def format_update(self, release: Dict[str, Any]) -> Dict[str, Any]:
        return {
            'latest_version': release.get('version'),
            'version': release.get('version'),
            'channel': release.get('channel') or 'stable',
            'update_type': release.get('update_type') or 'recommended',
            'is_mandatory': bool(release.get('is_mandatory')),
            'can_skip': bool(release.get('can_skip')),
            'announcement': release.get('announcement') or '',
            'announcement_content': release.get('announcement_content') or '',
            'release_notes': release.get('release_notes') or '',
            'download_url': release.get('download_url') or '',
            'file_size': release.get('file_size') or 0,
            'file_hash': release.get('file_hash') or '',
            'update_info': {
                'download_url': release.get('download_url') or '',
                'file_size': release.get('file_size') or 0,
                'file_hash': release.get('file_hash') or '',
            },
        }

    def format_device(self, row: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if not row:
            return {}
        result = dict(row)
        result['client_id'] = result.get('id')
        result['last_seen_at'] = result.get('last_verified_at')
        return result

    def compare_versions(self, latest: str, current: str) -> int:
        def parse(value: str):
            parts = []
            for item in str(value or '').replace('-', '.').split('.'):
                digits = ''.join(ch for ch in item if ch.isdigit())
                parts.append(int(digits or 0))
            return parts or [0]
        left = parse(latest)
        right = parse(current)
        size = max(len(left), len(right))
        left += [0] * (size - len(left))
        right += [0] * (size - len(right))
        if left > right:
            return 1
        if left < right:
            return -1
        return 0

    def _log_payload(self, data: Dict[str, Any], ip_address: str, action: str, result: str, message: str) -> Dict[str, Any]:
        return {
            'license_key': data.get('license_key') or '',
            'product_id': data.get('product_id') or '',
            'machine_id': data.get('machine_id') or '',
            'account_name': data.get('account_name') or '',
            'client_version': data.get('client_version') or '',
            'ip_address': ip_address or '',
            'action': action,
            'result': result,
            'message': message,
            'raw_payload': data,
        }
