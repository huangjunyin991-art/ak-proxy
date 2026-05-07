import secrets
import time

from .totp import TotpProvider


class OperationAuthService:
    MAX_LEASE_SECONDS = 3 * 60 * 60
    DEFAULT_LEASE_SECONDS = 30 * 60
    MIN_LEASE_SECONDS = 60

    def __init__(self, repository, super_admin_role: str, sub_admin_role: str,
                 issuer: str = 'AK Proxy Admin'):
        self.repository = repository
        self.super_admin_role = super_admin_role
        self.sub_admin_role = sub_admin_role
        self.issuer = issuer
        self.totp = TotpProvider()

    def identity_for(self, role: str, sub_name: str = '') -> str:
        if role == self.super_admin_role:
            return '__super__'
        return str(sub_name or '').strip()

    def display_name_for(self, role: str, sub_name: str = '') -> str:
        if role == self.super_admin_role:
            return 'super_admin'
        return str(sub_name or '').strip()

    async def ensure_secret(self, role: str, sub_name: str = ''):
        identity = self.identity_for(role, sub_name)
        if not identity:
            return None
        row = await self.repository.get_totp_secret(identity)
        if row:
            return self._secret_payload(row)
        return await self.reset_secret(role, sub_name)

    async def reset_secret(self, role: str, sub_name: str = ''):
        identity = self.identity_for(role, sub_name)
        if not identity:
            return None
        secret = self.totp.generate_secret()
        row = await self.repository.upsert_totp_secret(identity, role, sub_name or '', secret)
        return self._secret_payload(row)

    async def list_secrets(self):
        rows = await self.repository.list_totp_secrets()
        return [self._secret_payload(row) for row in rows]

    async def issue_lease(self, admin_token: str, role: str, sub_name: str, scope: str,
                          code: str, duration_seconds: int | None = None,
                          client_ip: str = '', user_agent: str = ''):
        code_result = await self.verify_code(role, sub_name, code)
        if not code_result.get('success'):
            return code_result
        ttl = self._normalize_duration(duration_seconds)
        lease_token = secrets.token_urlsafe(32)
        expire = time.time() + ttl
        row = await self.repository.save_lease(
            lease_token=lease_token,
            admin_token=admin_token,
            role=role,
            sub_name=sub_name or '',
            scope=scope,
            expire=expire,
            client_ip=client_ip,
            user_agent=user_agent,
        )
        return {
            'success': True,
            'lease_token': lease_token,
            'scope': scope,
            'expires_in': ttl,
            'expire': row.get('expire'),
        }

    async def verify_code(self, role: str, sub_name: str, code: str):
        secret_payload = await self.ensure_secret(role, sub_name)
        if not secret_payload:
            return {'success': False, 'message': '管理员身份无效'}
        if not self.totp.verify(secret_payload['secret'], code):
            return {'success': False, 'message': '请输入正确的谷歌验证码，若还未绑定谷歌验证器请联系总管理员获取谷歌密钥进行绑定！'}
        return {'success': True}

    async def verify_login_code(self, code: str):
        rows = await self.repository.list_totp_secrets()
        matches = []
        for row in rows:
            secret = str(row.get('secret') or '')
            if secret and self.totp.verify(secret, code):
                matches.append(self._secret_payload(row))
        if len(matches) == 1:
            return {'success': True, 'item': matches[0]}
        if len(matches) > 1:
            return {'success': False, 'message': '谷歌验证码匹配到多个管理员，请使用动态密码登录'}
        return {'success': False, 'message': '请输入正确的谷歌验证码，若还未绑定谷歌验证器请联系总管理员获取谷歌密钥进行绑定！'}

    async def verify_lease(self, admin_token: str, role: str, sub_name: str, scope: str,
                           lease_token: str) -> bool:
        if not admin_token or not lease_token or not scope:
            return False
        row = await self.repository.get_lease(lease_token)
        if not row:
            return False
        if time.time() > float(row.get('expire') or 0):
            await self.repository.delete_lease(lease_token)
            return False
        if str(row.get('admin_token') or '') != admin_token:
            return False
        if str(row.get('role') or '') != role:
            return False
        if str(row.get('sub_name') or '') != str(sub_name or ''):
            return False
        if str(row.get('scope') or '') != scope:
            return False
        await self.repository.touch_lease(lease_token)
        return True

    async def cleanup_expired(self) -> int:
        return await self.repository.cleanup_expired_leases(time.time())

    def _normalize_duration(self, duration_seconds: int | None) -> int:
        try:
            value = int(duration_seconds or self.DEFAULT_LEASE_SECONDS)
        except Exception:
            value = self.DEFAULT_LEASE_SECONDS
        return max(self.MIN_LEASE_SECONDS, min(value, self.MAX_LEASE_SECONDS))

    def _secret_payload(self, row: dict):
        role = str(row.get('role') or '')
        sub_name = str(row.get('sub_name') or '')
        secret = str(row.get('secret') or '')
        account_name = self.display_name_for(role, sub_name)
        return {
            'identity': str(row.get('identity') or ''),
            'role': role,
            'sub_name': sub_name,
            'secret': secret,
            'otpauth_uri': self.totp.otpauth_uri(self.issuer, account_name, secret),
            'created_at': row.get('created_at'),
            'updated_at': row.get('updated_at'),
        }
