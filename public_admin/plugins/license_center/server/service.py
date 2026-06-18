import asyncio
import base64
import hashlib
import hmac
import os
import re
import secrets
import string
import struct
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional

from .credential_guard import LicenseCredentialGuard
from .repository import LicenseCenterRepository


PUBLIC_LICENSE_SERVER_URL = 'https://ak2025.vip'
DEFAULT_PRODUCT_ID = 'ak_admin_panel'
PASSWORD_HASH_ITERATIONS = max(50000, min(200000, int(os.environ.get('LICENSE_PASSWORD_HASH_ITERATIONS', '100000') or '100000')))
PASSWORD_HASH_WORKERS = max(1, int(os.environ.get('LICENSE_PASSWORD_HASH_WORKERS', '2') or '2'))
TOTP_INTERVAL_SECONDS = 30
TOTP_DIGITS = 6
LICENSE_CREDENTIALS_ISSUER = 'AK授权中心'
LICENSE_RELEASE_DOWNLOAD_DIR = Path(__file__).resolve().parents[3] / 'downloads' / 'license'
LICENSE_RELEASE_UPLOAD_MAX_BYTES = 512 * 1024 * 1024
LICENSE_RELEASE_UPLOAD_EXTENSIONS = {
    '.exe', '.msi', '.zip', '.7z', '.rar', '.dmg', '.pkg', '.apk', '.ipa',
    '.tar', '.gz', '.tgz', '.xz', '.bz2',
}
LICENSE_RELEASE_UPLOAD_CHUNK_SIZE = 1024 * 1024
_PASSWORD_HASH_EXECUTOR = ThreadPoolExecutor(
    max_workers=PASSWORD_HASH_WORKERS,
    thread_name_prefix='license-pwd-hash',
)


class LicenseCenterService:
    def __init__(self, repository: LicenseCenterRepository):
        self.repository = repository
        self.credential_guard = LicenseCredentialGuard(repository.pool_supplier)

    async def ensure_schema(self) -> None:
        await self.repository.ensure_schema()
        await self.credential_guard.ensure_schema()

    async def _credential_guard_error(self, action: str, license_key: str, machine_id: str, ip_address: str = '') -> Optional[Dict[str, Any]]:
        try:
            decision = await self.credential_guard.ensure_allowed(
                action=action,
                license_key=license_key,
                machine_id=machine_id,
                ip_address=ip_address,
            )
        except Exception:
            return None
        if decision.allowed:
            return None
        return decision.to_error()

    async def _record_credential_failure(self, action: str, license_key: str, machine_id: str, ip_address: str = '') -> Optional[Dict[str, Any]]:
        try:
            decision = await self.credential_guard.record_failure(
                action=action,
                license_key=license_key,
                machine_id=machine_id,
                ip_address=ip_address,
            )
        except Exception:
            return None
        if decision.allowed:
            return None
        return decision.to_error()

    async def _record_credential_success(self, action: str, license_key: str, machine_id: str, ip_address: str = '') -> None:
        try:
            await self.credential_guard.record_success(
                action=action,
                license_key=license_key,
                machine_id=machine_id,
                ip_address=ip_address,
            )
        except Exception:
            return

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

    def normalize_product_id(self, value: str) -> str:
        return DEFAULT_PRODUCT_ID

    def public_url(self, value: str) -> str:
        url = str(value or '').strip()
        if not url:
            return ''
        if url.startswith('http://') or url.startswith('https://'):
            return url
        if not url.startswith('/'):
            url = f'/{url}'
        return f'{PUBLIC_LICENSE_SERVER_URL}{url}'

    def _normalize_release_filename(self, filename: str) -> tuple[str, str]:
        original = os.path.basename(str(filename or '').strip())
        stem, ext = os.path.splitext(original)
        ext = ext.lower()
        if not original or not stem:
            raise ValueError('文件名无效')
        if ext not in LICENSE_RELEASE_UPLOAD_EXTENSIONS:
            raise ValueError('不支持的文件类型')
        safe_stem = re.sub(r'[^A-Za-z0-9._-]+', '_', stem).strip('._-')
        if not safe_stem:
            safe_stem = 'release'
        stored_name = f'{safe_stem}-{int(time.time())}-{secrets.token_hex(4)}{ext}'
        return original, stored_name

    def resolve_release_download_path(self, filename: str) -> Optional[Path]:
        safe_name = os.path.basename(str(filename or '').strip())
        if not safe_name or safe_name != str(filename or '').strip():
            return None
        path = (LICENSE_RELEASE_DOWNLOAD_DIR / safe_name).resolve()
        root = LICENSE_RELEASE_DOWNLOAD_DIR.resolve()
        try:
            path.relative_to(root)
        except ValueError:
            return None
        if not path.is_file():
            return None
        return path

    async def upload_release_file(self, upload_file, operator: str = 'admin') -> Dict[str, Any]:
        try:
            original_name, stored_name = self._normalize_release_filename(getattr(upload_file, 'filename', '') or '')
        except ValueError as exc:
            return {'error': True, 'success': False, 'message': str(exc)}

        LICENSE_RELEASE_DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
        target = (LICENSE_RELEASE_DOWNLOAD_DIR / stored_name).resolve()
        digest = hashlib.sha256()
        total = 0

        try:
            with open(target, 'wb') as f:
                while True:
                    chunk = await upload_file.read(LICENSE_RELEASE_UPLOAD_CHUNK_SIZE)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > LICENSE_RELEASE_UPLOAD_MAX_BYTES:
                        f.close()
                        try:
                            target.unlink(missing_ok=True)
                        except Exception:
                            pass
                        return {'error': True, 'success': False, 'message': '文件过大，最大支持 512MB'}
                    digest.update(chunk)
                    f.write(chunk)
        except Exception as exc:
            try:
                target.unlink(missing_ok=True)
            except Exception:
                pass
            return {'error': True, 'success': False, 'message': f'上传失败: {exc}'}
        finally:
            try:
                await upload_file.close()
            except Exception:
                pass

        if total <= 0:
            try:
                target.unlink(missing_ok=True)
            except Exception:
                pass
            return {'error': True, 'success': False, 'message': '文件为空'}

        download_url = f'/downloads/license/{stored_name}'
        return {
            'error': False,
            'success': True,
            'message': '上传成功',
            'data': {
                'file_name': original_name,
                'stored_name': stored_name,
                'download_url': download_url,
                'public_url': self.public_url(download_url),
                'file_size': total,
                'file_hash': digest.hexdigest(),
                'uploaded_by': operator,
            },
        }

    def hash_password(self, password: str) -> str:
        salt = secrets.token_hex(16)
        digest = hashlib.pbkdf2_hmac('sha256', str(password or '').encode('utf-8'), salt.encode('ascii'), PASSWORD_HASH_ITERATIONS).hex()
        return f'pbkdf2_sha256${PASSWORD_HASH_ITERATIONS}${salt}${digest}'

    async def hash_password_async(self, password: str) -> str:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(_PASSWORD_HASH_EXECUTOR, self.hash_password, password)

    def generate_client_password(self, length: int = 10) -> str:
        length = max(10, int(length or 10))
        groups = [
            string.ascii_uppercase,
            string.ascii_lowercase,
            string.digits,
            '!@#$%^&*',
        ]
        chars = [secrets.choice(group) for group in groups]
        alphabet = ''.join(groups)
        chars.extend(secrets.choice(alphabet) for _ in range(length - len(chars)))
        secrets.SystemRandom().shuffle(chars)
        return ''.join(chars)

    def verify_password_hash(self, password: str, stored_hash: str) -> bool:
        value = str(stored_hash or '')
        parts = value.split('$')
        if len(parts) != 4 or parts[0] != 'pbkdf2_sha256':
            return False
        try:
            iterations = int(parts[1])
            salt = parts[2]
            expected = parts[3]
            digest = hashlib.pbkdf2_hmac('sha256', str(password or '').encode('utf-8'), salt.encode('ascii'), iterations).hex()
            return hmac.compare_digest(digest, expected)
        except Exception:
            return False

    async def verify_password_hash_async(self, password: str, stored_hash: str) -> bool:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(_PASSWORD_HASH_EXECUTOR, self.verify_password_hash, password, stored_hash)

    def password_hash_iterations(self, stored_hash: str) -> int:
        parts = str(stored_hash or '').split('$')
        if len(parts) != 4 or parts[0] != 'pbkdf2_sha256':
            return 0
        try:
            return int(parts[1])
        except Exception:
            return 0

    def password_hash_needs_rehash(self, stored_hash: str) -> bool:
        return self.password_hash_iterations(stored_hash) != PASSWORD_HASH_ITERATIONS

    def generate_google_secret(self) -> str:
        return base64.b32encode(secrets.token_bytes(20)).decode('ascii').rstrip('=')

    def google_otpauth_uri(self, license_key: str, machine_id: str, secret: str) -> str:
        label = urllib.parse.quote(f'{LICENSE_CREDENTIALS_ISSUER}:{license_key[-8:]}-{machine_id[-6:]}')
        issuer = urllib.parse.quote(LICENSE_CREDENTIALS_ISSUER)
        return f'otpauth://totp/{label}?secret={secret}&issuer={issuer}&digits={TOTP_DIGITS}&period={TOTP_INTERVAL_SECONDS}'

    def verify_totp_code(self, secret: str, code: str) -> bool:
        normalized = str(code or '').strip()
        if len(normalized) != TOTP_DIGITS or not normalized.isdigit() or not secret:
            return False
        now_step = int(time.time() // TOTP_INTERVAL_SECONDS)
        for step in (now_step - 1, now_step, now_step + 1):
            if hmac.compare_digest(self.generate_totp_code(secret, step), normalized):
                return True
        return False

    def generate_totp_code(self, secret: str, step: int) -> str:
        padded = str(secret or '').strip().upper()
        padded += '=' * ((8 - len(padded) % 8) % 8)
        key = base64.b32decode(padded, casefold=True)
        msg = struct.pack('>Q', int(step))
        digest = hmac.new(key, msg, hashlib.sha1).digest()
        offset = digest[-1] & 0x0F
        value = struct.unpack('>I', digest[offset:offset + 4])[0] & 0x7FFFFFFF
        return str(value % (10 ** TOTP_DIGITS)).zfill(TOTP_DIGITS)

    def format_credentials_status(self, row: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        has_login = bool(row and row.get('login_password_hash'))
        has_verify = bool(row and row.get('verify_password_hash'))
        has_google = bool(row and row.get('google_enabled') and row.get('google_secret'))
        return {
            'is_initialized': has_login,
            'has_password': has_login,
            'has_login_password': has_login,
            'has_verify_password': has_verify,
            'has_google': has_google,
            'google_enabled': has_google,
            'google_verified': has_google,
            'verified': has_google,
            'requires_google_confirm': bool(row and row.get('google_secret') and not has_google),
            'has_email': bool(row and row.get('email')),
            'has_phone': bool(row and row.get('phone')),
            'email': row.get('email') if row else '',
            'phone': row.get('phone') if row else '',
        }

    async def require_license_device(self, data: Dict[str, Any]) -> tuple[Optional[Dict[str, Any]], str, str, Optional[Dict[str, Any]]]:
        license_key = str(data.get('license_key') or data.get('activation_code') or '').strip().upper()
        machine_id = str(data.get('machine_id') or '').strip()
        if not license_key:
            return None, license_key, machine_id, {'error': True, 'success': False, 'message': '缺少激活码', 'error_code': 'LICENSE_REQUIRED'}
        if not machine_id:
            return None, license_key, machine_id, {'error': True, 'success': False, 'message': '缺少机器码', 'error_code': 'MACHINE_ID_REQUIRED'}
        row = await self.repository.get_license(license_key)
        if not row:
            return None, license_key, machine_id, {'error': True, 'success': False, 'message': '激活码不存在', 'error_code': 'LICENSE_NOT_FOUND'}
        validity_error = self.validate_license_time_and_count(row)
        if validity_error:
            return None, license_key, machine_id, validity_error
        device = await self.repository.get_license_device(license_key, machine_id)
        if not device:
            return None, license_key, machine_id, {'error': True, 'success': False, 'message': '机器码未绑定该激活码', 'error_code': 'MACHINE_ID_MISMATCH'}
        if device.get('status') != 'active':
            return None, license_key, machine_id, {'error': True, 'success': False, 'message': '客户端已被禁用', 'error_code': 'DEVICE_BLACKLISTED'}
        return row, license_key, machine_id, None

    async def create_license(self, data: Dict[str, Any], operator: str = 'admin') -> Dict[str, Any]:
        product_id = self.normalize_product_id(data.get('product_id'))
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
        return {'error': False, 'success': True, 'message': '创建成功', 'data': self.format_license(row)}

    async def list_licenses(self, limit: int = 50, offset: int = 0) -> Dict[str, Any]:
        result = await self.repository.list_licenses(max(1, min(int(limit or 50), 200)), max(0, int(offset or 0)))
        return {'error': False, 'success': True, 'data': {'total': result['total'], 'items': [self.format_license(row) for row in result['items']]}}

    async def get_license_info(self, license_key: str) -> Dict[str, Any]:
        row = await self.repository.get_license(str(license_key or '').strip().upper())
        if not row:
            return {'error': True, 'success': False, 'message': '激活码不存在'}
        return {'error': False, 'success': True, 'data': self.format_license(row)}

    async def revoke_license(self, license_key: str, reason: str = '', operator: str = 'admin') -> Dict[str, Any]:
        key = str(license_key or '').strip().upper()
        row = await self.repository.update_license(key, {'status': 'revoked'})
        if not row:
            return {'error': True, 'success': False, 'message': '激活码不存在'}
        await self.repository.add_legacy_log('revoke', key, row.get('product_id'), row.get('billing_mode'), reason or '撤销激活码', operator)
        return {'error': False, 'success': True, 'message': '撤销成功', 'data': self.format_license(row)}

    async def edit_license(self, data: Dict[str, Any], operator: str = 'admin') -> Dict[str, Any]:
        key = str(data.get('license_key') or '').strip().upper()
        if not key:
            return {'error': True, 'success': False, 'message': '缺少激活码'}
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
            return {'error': True, 'success': False, 'message': '激活码不存在'}
        await self.repository.add_legacy_log('edit', key, row.get('product_id'), row.get('billing_mode'), '编辑激活码', operator)
        return {'error': False, 'success': True, 'message': '保存成功', 'data': self.format_license(row)}

    async def statistics(self) -> Dict[str, Any]:
        return {'error': False, 'success': True, 'data': await self.repository.statistics()}

    async def products(self) -> Dict[str, Any]:
        return {'error': False, 'success': True, 'data': {'items': await self.repository.list_products()}}

    async def health(self) -> Dict[str, Any]:
        return {'error': False, 'success': True, 'message': '授权中心正常', 'data': {'mode': 'local', 'server_url': PUBLIC_LICENSE_SERVER_URL, 'product_id': DEFAULT_PRODUCT_ID}}

    async def admin_logs(self, limit: int = 100, offset: int = 0) -> Dict[str, Any]:
        result = await self.repository.list_verification_logs(max(1, min(int(limit or 100), 200)), max(0, int(offset or 0)))
        return {'error': False, 'success': True, 'data': result}

    async def list_clients(self, limit: int = 100, offset: int = 0) -> Dict[str, Any]:
        result = await self.repository.list_devices(max(1, min(int(limit or 100), 200)), max(0, int(offset or 0)))
        return {'error': False, 'success': True, 'data': {'total': result['total'], 'items': [self.format_device(row) for row in result['items']]}}

    async def client_detail(self, client_id: str) -> Dict[str, Any]:
        row = await self.repository.get_device(client_id)
        if not row:
            return {'error': True, 'success': False, 'message': '客户端不存在'}
        return {'error': False, 'success': True, 'data': self.format_device(row)}

    async def set_client_status(self, data: Dict[str, Any], status: str, operator: str = 'admin') -> Dict[str, Any]:
        device_id = str(data.get('client_id') or data.get('device_id') or data.get('machine_id') or '').strip()
        if not device_id:
            return {'error': True, 'success': False, 'message': '客户端标识不能为空'}
        row = await self.repository.set_device_status(device_id, status)
        if not row:
            return {'error': True, 'success': False, 'message': '客户端不存在'}
        await self.repository.add_legacy_log(status, row.get('license_key'), row.get('product_id'), None, row.get('machine_id'), operator)
        return {'error': False, 'success': True, 'message': '操作成功', 'data': self.format_device(row)}

    async def blacklist_add(self, data: Dict[str, Any], operator: str = 'admin') -> Dict[str, Any]:
        target_type = str(data.get('target_type') or data.get('type') or 'machine_id').strip()
        target_value = str(data.get('target_value') or data.get('value') or data.get('machine_id') or data.get('license_key') or '').strip()
        if not target_value:
            return {'error': True, 'success': False, 'message': '封禁目标不能为空'}
        row = await self.repository.add_blacklist(target_type, target_value, str(data.get('reason') or ''), operator)
        return {'error': False, 'success': True, 'message': '已加入黑名单', 'data': row}

    async def blacklist_remove(self, data: Dict[str, Any], operator: str = 'admin') -> Dict[str, Any]:
        target_type = str(data.get('target_type') or data.get('type') or 'machine_id').strip()
        target_value = str(data.get('target_value') or data.get('value') or data.get('machine_id') or data.get('license_key') or '').strip()
        if not target_value:
            return {'error': True, 'success': False, 'message': '解封目标不能为空'}
        ok = await self.repository.remove_blacklist(target_type, target_value, operator)
        return {'error': False, 'success': True, 'message': '已移出黑名单' if ok else '黑名单记录不存在'}

    async def blacklist_list(self) -> Dict[str, Any]:
        return {'error': False, 'success': True, 'data': {'items': await self.repository.list_blacklist()}}

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
            return {'error': True, 'success': False, 'message': '激活码不存在'}
        if row.get('billing_mode') == 'per_use':
            remaining = row.get('remaining_uses')
            if remaining is not None and int(remaining) <= 0:
                return {'error': True, 'success': False, 'message': '使用次数已用完', 'error_code': 'LICENSE_EXPIRED'}
            row = await self.repository.update_license(key, {'remaining_uses': int(remaining or 0) - 1})
        await self.repository.add_verification_log(self._log_payload(data, ip_address, 'consume', 'success', '消耗成功'))
        return {'error': False, 'success': True, 'message': '消耗成功', 'data': self.format_license(row)}

    async def check_credentials_initialized(self, data: Dict[str, Any]) -> Dict[str, Any]:
        payload = dict(data or {})
        license_key = str(payload.get('license_key') or payload.get('activation_code') or '').strip().upper()
        machine_id = str(payload.get('machine_id') or '').strip()
        if not license_key and machine_id:
            found = await self.repository.find_license_by_machine(machine_id, self.normalize_product_id(payload.get('product_id')))
            if found:
                payload['license_key'] = str(found.get('license_key') or '')
        _, license_key, machine_id, error = await self.require_license_device(payload)
        if error:
            return {'error': False, 'success': True, 'data': self.format_credentials_status(None)}
        credentials = await self.repository.get_credentials(license_key, machine_id)
        return {'error': False, 'success': True, 'data': self.format_credentials_status(credentials)}

    async def setup_credentials(self, data: Dict[str, Any]) -> Dict[str, Any]:
        _, license_key, machine_id, error = await self.require_license_device(data)
        if error:
            return error
        login_password = str(data.get('login_password') or '')
        verify_password = str(data.get('verify_password') or '')
        if len(login_password) < 6:
            return {'error': True, 'success': False, 'message': '登录密码至少需要6位字符'}
        if verify_password and len(verify_password) < 6:
            return {'error': True, 'success': False, 'message': '二次验证码至少需要6位字符'}
        existing = await self.repository.get_credentials(license_key, machine_id)
        if existing and existing.get('login_password_hash'):
            return {'error': True, 'success': False, 'message': '安全凭证已初始化，请使用重置功能修改'}
        google_secret = self.generate_google_secret()
        credentials = await self.repository.upsert_credentials({
            'license_key': license_key,
            'machine_id': machine_id,
            'login_password_hash': await self.hash_password_async(login_password),
            'verify_password_hash': await self.hash_password_async(verify_password) if verify_password else '',
            'google_secret': google_secret,
            'google_enabled': False,
            'email': str(data.get('email') or '').strip(),
            'phone': str(data.get('phone') or '').strip(),
        })
        status = self.format_credentials_status(credentials)
        status['google_secret'] = google_secret
        status['otpauth_uri'] = self.google_otpauth_uri(license_key, machine_id, google_secret)
        status['requires_google_confirm'] = True
        return {'error': False, 'success': True, 'message': '安全凭证保存成功，请绑定 Google Authenticator', 'data': status}

    async def login_credentials(self, data: Dict[str, Any], ip_address: str = '') -> Dict[str, Any]:
        _, license_key, machine_id, error = await self.require_license_device(data)
        if error:
            return error
        guard_error = await self._credential_guard_error('login', license_key, machine_id, ip_address)
        if guard_error:
            return guard_error
        credentials = await self.repository.get_credentials(license_key, machine_id)
        if not credentials or not credentials.get('login_password_hash'):
            return {'error': True, 'success': False, 'message': '尚未设置登录密码'}
        locked_until = credentials.get('locked_until')
        if locked_until and locked_until > datetime.now():
            return {
                'error': True,
                'success': False,
                'message': '密码错误次数过多，账号已临时锁定',
                'data': {'is_locked': True, 'locked_until': locked_until, 'remaining_attempts': 0}
            }
        login_password_value = str(data.get('login_password') or data.get('password') or '')
        if not await self.verify_password_hash_async(login_password_value, credentials.get('login_password_hash')):
            guard_block = await self._record_credential_failure('login', license_key, machine_id, ip_address)
            if guard_block:
                return guard_block
            failed_attempts = int(credentials.get('failed_attempts') or 0) + 1
            fields = {'failed_attempts': failed_attempts}
            if failed_attempts >= 5:
                fields['locked_until'] = datetime.now() + timedelta(minutes=15)
            await self.repository.update_credentials(license_key, machine_id, fields)
            remaining = max(0, 5 - failed_attempts)
            return {
                'error': True,
                'success': False,
                'message': '密码错误',
                'data': {
                    'failed_attempts': failed_attempts,
                    'remaining_attempts': remaining,
                    'is_locked': failed_attempts >= 5,
                    'locked_reason': '密码错误次数过多' if failed_attempts >= 5 else '',
                }
            }
        login_update_fields = {
            'login_count': int(credentials.get('login_count') or 0) + 1,
            'failed_attempts': 0,
            'locked_until': None,
            'last_login_at': datetime.now(),
        }
        if self.password_hash_needs_rehash(credentials.get('login_password_hash')):
            login_update_fields['login_password_hash'] = await self.hash_password_async(login_password_value)
        credentials = await self.repository.update_credentials(license_key, machine_id, login_update_fields)
        await self._record_credential_success('login', license_key, machine_id, ip_address)
        return {'error': False, 'success': True, 'message': '登录成功', 'data': self.format_credentials_status(credentials)}

    async def verify_secondary_password(self, data: Dict[str, Any], ip_address: str = '') -> Dict[str, Any]:
        _, license_key, machine_id, error = await self.require_license_device(data)
        if error:
            return error
        guard_error = await self._credential_guard_error('verify_password', license_key, machine_id, ip_address)
        if guard_error:
            return guard_error
        credentials = await self.repository.get_credentials(license_key, machine_id)
        if not credentials or not credentials.get('verify_password_hash'):
            return {'error': True, 'success': False, 'message': '尚未设置二次验证码'}
        verify_password_value = str(data.get('verify_password') or '')
        if not await self.verify_password_hash_async(verify_password_value, credentials.get('verify_password_hash')):
            guard_block = await self._record_credential_failure('verify_password', license_key, machine_id, ip_address)
            if guard_block:
                return guard_block
            return {'error': True, 'success': False, 'message': '二次验证码错误'}
        result = self.format_credentials_status(credentials)
        result['verified'] = True
        if self.password_hash_needs_rehash(credentials.get('verify_password_hash')):
            await self.repository.update_credentials(license_key, machine_id, {
                'verify_password_hash': await self.hash_password_async(verify_password_value),
            })
        await self._record_credential_success('verify_password', license_key, machine_id, ip_address)
        return {'error': False, 'success': True, 'message': '验证成功', 'data': result}

    async def begin_google_binding(self, data: Dict[str, Any]) -> Dict[str, Any]:
        _, license_key, machine_id, error = await self.require_license_device(data)
        if error:
            return error
        credentials = await self.repository.get_credentials(license_key, machine_id)
        if not credentials or not credentials.get('login_password_hash'):
            return {'error': True, 'success': False, 'message': '请先初始化登录密码'}
        should_reset = bool(data.get('force_reset') or data.get('reset'))
        if credentials.get('google_secret') and not should_reset:
            result = self.format_credentials_status(credentials)
            result['google_secret'] = credentials.get('google_secret') or ''
            result['otpauth_uri'] = self.google_otpauth_uri(license_key, machine_id, credentials.get('google_secret') or '')
            if result.get('google_enabled'):
                result['requires_google_confirm'] = False
                return {'error': False, 'success': True, 'message': 'Google Authenticator 已绑定', 'data': result}
            result['requires_google_confirm'] = True
            return {'error': False, 'success': True, 'message': '请使用已有 Google Authenticator 密钥完成绑定', 'data': result}
        secret = self.generate_google_secret()
        credentials = await self.repository.update_credentials(license_key, machine_id, {
            'google_secret': secret,
            'google_enabled': False,
        })
        result = self.format_credentials_status(credentials)
        result['google_secret'] = secret
        result['otpauth_uri'] = self.google_otpauth_uri(license_key, machine_id, secret)
        return {'error': False, 'success': True, 'message': '请使用 Google Authenticator 扫码绑定', 'data': result}

    async def confirm_google_binding(self, data: Dict[str, Any], ip_address: str = '') -> Dict[str, Any]:
        _, license_key, machine_id, error = await self.require_license_device(data)
        if error:
            return error
        guard_error = await self._credential_guard_error('google_confirm', license_key, machine_id, ip_address)
        if guard_error:
            return guard_error
        credentials = await self.repository.get_credentials(license_key, machine_id)
        if not credentials or not credentials.get('google_secret'):
            return {'error': True, 'success': False, 'message': '请先生成 Google Authenticator 绑定密钥'}
        if not self.verify_totp_code(credentials.get('google_secret'), str(data.get('google_code') or data.get('code') or '')):
            guard_block = await self._record_credential_failure('google_confirm', license_key, machine_id, ip_address)
            if guard_block:
                return guard_block
            return {'error': True, 'success': False, 'message': 'Google Authenticator 动态码错误'}
        credentials = await self.repository.update_credentials(license_key, machine_id, {'google_enabled': True})
        await self._record_credential_success('google_confirm', license_key, machine_id, ip_address)
        return {'error': False, 'success': True, 'message': 'Google Authenticator 绑定成功', 'data': self.format_credentials_status(credentials)}

    async def reset_passwords_with_google(self, data: Dict[str, Any], ip_address: str = '') -> Dict[str, Any]:
        _, license_key, machine_id, error = await self.require_license_device(data)
        if error:
            return error
        guard_error = await self._credential_guard_error('google_reset', license_key, machine_id, ip_address)
        if guard_error:
            return guard_error
        credentials = await self.repository.get_credentials(license_key, machine_id)
        if not credentials or not credentials.get('login_password_hash'):
            return {'error': True, 'success': False, 'message': '尚未初始化安全凭证'}
        if not credentials.get('google_enabled') or not credentials.get('google_secret'):
            return {'error': True, 'success': False, 'message': '尚未绑定 Google Authenticator'}
        if not self.verify_totp_code(credentials.get('google_secret'), str(data.get('google_code') or data.get('code') or '')):
            guard_block = await self._record_credential_failure('google_reset', license_key, machine_id, ip_address)
            if guard_block:
                return guard_block
            return {'error': True, 'success': False, 'message': 'Google Authenticator 动态码错误'}
        login_password = str(data.get('login_password') or '')
        verify_password = str(data.get('verify_password') or '')
        fields = {}
        if login_password:
            if len(login_password) < 6:
                return {'error': True, 'success': False, 'message': '登录密码至少需要6位字符'}
            fields['login_password_hash'] = await self.hash_password_async(login_password)
        if verify_password:
            if len(verify_password) < 6:
                return {'error': True, 'success': False, 'message': '二次验证码至少需要6位字符'}
            fields['verify_password_hash'] = await self.hash_password_async(verify_password)
        if not fields:
            return {'error': True, 'success': False, 'message': '请至少填写一个需要重置的密码'}
        fields['failed_attempts'] = 0
        fields['locked_until'] = None
        credentials = await self.repository.update_credentials(license_key, machine_id, fields)
        await self._record_credential_success('google_reset', license_key, machine_id, ip_address)
        return {'error': False, 'success': True, 'message': '重置成功', 'data': self.format_credentials_status(credentials)}

    async def admin_reset_login_password(self, data: Dict[str, Any], operator: str = 'admin') -> Dict[str, Any]:
        license_key = str(data.get('license_key') or '').strip().upper()
        machine_id = str(data.get('machine_id') or '').strip()
        if not license_key:
            return {'error': True, 'success': False, 'message': '缺少激活码'}
        if not machine_id:
            return {'error': True, 'success': False, 'message': '该激活码尚未绑定机器，无法重置密码'}
        row = await self.repository.get_license(license_key)
        if not row:
            return {'error': True, 'success': False, 'message': '激活码不存在'}
        device = await self.repository.get_license_device(license_key, machine_id)
        if not device:
            return {'error': True, 'success': False, 'message': '机器码未绑定该激活码'}

        password = self.generate_client_password(10)
        password_hash = await self.hash_password_async(password)
        existing = await self.repository.get_credentials(license_key, machine_id)
        fields = {
            'login_password_hash': password_hash,
            'failed_attempts': 0,
            'locked_until': None,
        }
        if existing:
            credentials = await self.repository.update_credentials(license_key, machine_id, fields)
        else:
            credentials = await self.repository.upsert_credentials({
                'license_key': license_key,
                'machine_id': machine_id,
                'login_password_hash': password_hash,
            })
        await self.repository.add_legacy_log('reset_password', license_key, row.get('product_id'), row.get('billing_mode'), f'重置机器 {machine_id} 登录密码', operator)
        status = self.format_credentials_status(credentials)
        status.update({'machine_id': machine_id, 'password': password})
        return {'error': False, 'success': True, 'message': '重置成功', 'data': status}

    async def check_update(self, product_id: str, current_version: str, channel: str = 'stable') -> Dict[str, Any]:
        product_id = self.normalize_product_id(product_id)
        release = await self.repository.get_latest_release(product_id, channel or 'stable')
        if not release:
            return {'error': False, 'success': True, 'data': {'has_update': False, 'server_url': PUBLIC_LICENSE_SERVER_URL}}
        has_update = self.compare_versions(str(release.get('version') or ''), str(current_version or '')) > 0
        if not has_update:
            return {'error': False, 'success': True, 'data': {'has_update': False, 'server_url': PUBLIC_LICENSE_SERVER_URL}}
        data = self.format_update(release)
        data['has_update'] = True
        return {'error': False, 'success': True, 'data': data}

    async def publish_release(self, data: Dict[str, Any], operator: str = 'admin') -> Dict[str, Any]:
        version = str(data.get('version') or '').strip()
        if not version:
            return {'error': True, 'success': False, 'message': '版本号不能为空'}
        update_type = str(data.get('update_type') or 'recommended').strip().lower()
        is_mandatory = bool(data.get('is_mandatory')) or update_type == 'mandatory'
        can_skip = False if is_mandatory else bool(data.get('can_skip', True))
        release = await self.repository.upsert_release({
            'product_id': self.normalize_product_id(data.get('product_id')),
            'version': version,
            'channel': str(data.get('channel') or 'stable').strip() or 'stable',
            'update_type': update_type,
            'is_mandatory': is_mandatory,
            'can_skip': can_skip,
            'download_url': str(data.get('download_url') or '').strip(),
            'file_size': int(data.get('file_size') or 0),
            'file_hash': str(data.get('file_hash') or '').strip(),
            'announcement': str(data.get('announcement') or '').strip(),
            'announcement_content': str(data.get('announcement_content') or '').strip(),
            'release_notes': str(data.get('release_notes') or '').strip(),
            'published': bool(data.get('published', True)),
            'created_by': operator,
        })
        return {'error': False, 'success': True, 'message': '更新发布已保存', 'data': self.format_update(release)}

    async def list_releases(self, product_id: str = '', channel: str = '', limit: int = 50, offset: int = 0) -> Dict[str, Any]:
        result = await self.repository.list_releases(
            product_id=self.normalize_product_id(product_id) if product_id else '',
            channel=str(channel or '').strip(),
            limit=max(1, min(int(limit or 50), 200)),
            offset=max(0, int(offset or 0)),
        )
        return {'error': False, 'success': True, 'data': {'total': result['total'], 'items': [self.format_update(row) for row in result['items']]}}

    async def _verify_or_activate(self, data: Dict[str, Any], ip_address: str, activate: bool) -> Dict[str, Any]:
        product_id = self.normalize_product_id(data.get('product_id'))
        license_key = str(data.get('license_key') or data.get('activation_code') or '').strip().upper()
        machine_id = str(data.get('machine_id') or '').strip()
        account_name = str(data.get('account_name') or '').strip()
        client_version = str(data.get('client_version') or '').strip()
        action = 'activate' if activate else 'verify'
        if not license_key and machine_id:
            found = await self.repository.find_license_by_machine(machine_id, product_id)
            if found:
                license_key = str(found.get('license_key') or '')
        if not license_key:
            result = {'error': True, 'success': False, 'message': '缺少激活码', 'error_code': 'LICENSE_REQUIRED'}
            await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
            return result
        row = await self.repository.get_license(license_key)
        if not row:
            result = {'error': True, 'success': False, 'message': '激活码不存在', 'error_code': 'LICENSE_NOT_FOUND'}
            await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
            return result
        if product_id and row.get('product_id') != product_id:
            result = {'error': True, 'success': False, 'message': '产品不匹配', 'error_code': 'PRODUCT_MISMATCH'}
            await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
            return result
        ban = await self.find_blacklist(row, machine_id, account_name, ip_address)
        if ban:
            result = {'error': True, 'success': False, 'message': ban.get('reason') or '设备或授权已被封禁', 'error_code': 'DEVICE_BLACKLISTED', 'data': {'banned': True, 'ban_reason': ban.get('reason') or '', 'blacklist_reason': ban.get('reason') or ''}}
            await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
            return result
        validity_error = self.validate_license_time_and_count(row)
        if validity_error:
            await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', validity_error['message']))
            return validity_error
        if row.get('status') == 'revoked':
            result = {'error': True, 'success': False, 'message': '激活码已撤销', 'error_code': 'LICENSE_REVOKED'}
            await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
            return result
        if machine_id:
            bound_device = await self.repository.get_license_device(license_key, machine_id)
            if bound_device and bound_device.get('status') != 'active':
                result = {'error': True, 'success': False, 'message': '客户端已被禁用', 'error_code': 'DEVICE_BLACKLISTED', 'data': {'banned': True, 'ban_reason': '客户端已被禁用'}}
                await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
                return result
            device_count = await self.repository.count_devices(license_key)
            existing = await self.repository.find_license_by_machine(machine_id, product_id)
            if device_count >= int(row.get('max_devices') or 1) and (not existing or existing.get('license_key') != license_key):
                result = {'error': True, 'success': False, 'message': '设备数量已达上限', 'error_code': 'DEVICE_LIMIT_EXCEEDED'}
                await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
                return result
            if row.get('status') == 'inactive' or activate:
                await self.repository.upsert_device(license_key, product_id, machine_id, data.get('hardware') or data.get('hardware_fingerprint') or {}, account_name, client_version, ip_address)
                if row.get('status') == 'inactive':
                    row = await self.repository.update_license(license_key, {'status': 'active', 'activated_at': datetime.now()})
            elif row.get('status') == 'active':
                await self.repository.upsert_device(license_key, product_id, machine_id, data.get('hardware') or data.get('hardware_fingerprint') or {}, account_name, client_version, ip_address)
        elif activate:
            result = {'error': True, 'success': False, 'message': '缺少机器码', 'error_code': 'MACHINE_ID_REQUIRED'}
            await self.repository.add_verification_log(self._log_payload(data, ip_address, action, 'failed', result['message']))
            return result
        formatted = self.format_license(row)
        if machine_id:
            credentials = await self.repository.get_credentials(license_key, machine_id)
            formatted.update(self.format_credentials_status(credentials))
        update_result = await self.check_update(product_id, client_version, str(data.get('channel') or 'stable'))
        if not update_result.get('error'):
            formatted['update_available'] = update_result.get('data') or {'has_update': False}
        await self.repository.add_verification_log(self._log_payload(dict(data, license_key=license_key), ip_address, action, 'success', '验证成功'))
        result = {'error': False, 'success': True, 'message': '激活成功' if activate else '验证成功', 'data': formatted}
        result.update({
            'valid': formatted.get('valid'),
            'license_key': formatted.get('license_key'),
            'billing_mode': formatted.get('billing_mode'),
            'mode': formatted.get('billing_mode'),
            'unlimited': formatted.get('billing_mode') == 'unlimited',
            'expire_date': formatted.get('expiry_date'),
            'expiry_date': formatted.get('expiry_date'),
            'remaining_uses': formatted.get('remaining_uses'),
            'remaining_time': formatted.get('remaining_time'),
            'has_login_password': formatted.get('has_login_password', False),
            'has_verify_password': formatted.get('has_verify_password', False),
            'has_google': formatted.get('has_google', False),
            'google_enabled': formatted.get('google_enabled', False),
        })
        return result

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
            return {'error': True, 'success': False, 'message': '激活码不可用', 'error_code': 'LICENSE_INVALID'}
        expiry_date = row.get('expiry_date')
        if expiry_date and expiry_date < datetime.now():
            return {'error': True, 'success': False, 'message': '激活码已过期', 'error_code': 'LICENSE_EXPIRED', 'data': {'expired': True}}
        if row.get('billing_mode') == 'per_use':
            remaining = row.get('remaining_uses')
            if remaining is not None and int(remaining) <= 0:
                return {'error': True, 'success': False, 'message': '使用次数已用完', 'error_code': 'LICENSE_EXPIRED', 'data': {'expired': True}}
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
        download_url = self.public_url(release.get('download_url') or '')
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
            'download_url': download_url,
            'file_size': release.get('file_size') or 0,
            'file_hash': release.get('file_hash') or '',
            'server_url': PUBLIC_LICENSE_SERVER_URL,
            'product_id': DEFAULT_PRODUCT_ID,
            'update_info': {
                'download_url': download_url,
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
