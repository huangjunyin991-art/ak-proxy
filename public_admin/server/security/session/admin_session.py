import secrets
import time


class AdminSessionService:
    def __init__(self, db_module, sub_admin_role: str, token_ttl_seconds: int = 86400):
        self.db = db_module
        self.sub_admin_role = sub_admin_role
        self.token_ttl_seconds = token_ttl_seconds
        self.tokens = {}

    async def load_from_db(self, logger):
        try:
            loaded_tokens = await self.db.load_all_admin_tokens()
            self.tokens.clear()
            self.tokens.update(loaded_tokens)
            logger.info(f"[Token] 从数据库恢复了 {len(self.tokens)} 个有效Token")
        except Exception as e:
            logger.warning(f"[Token] 加载Token失败: {e}")
            self.tokens.clear()

    async def generate_token(self, role: str, sub_name: str = '', ttl_seconds: int | None = None) -> str:
        if role == self.sub_admin_role and sub_name:
            tokens_to_remove = [t for t, d in self.tokens.items()
                                if d.get('role') == self.sub_admin_role and d.get('sub_name') == sub_name]
            for t in tokens_to_remove:
                self.tokens.pop(t, None)
            await self.db.delete_admin_tokens_by_sub_name(sub_name, reason='replaced')
        else:
            tokens_to_remove = [t for t, d in self.tokens.items() if d.get('role') == role]
            for t in tokens_to_remove:
                self.tokens.pop(t, None)
            await self.db.delete_admin_tokens_by_role(role, reason='replaced')

        token = secrets.token_urlsafe(32)
        expire = time.time() + int(ttl_seconds or self.token_ttl_seconds)
        self.tokens[token] = {'expire': expire, 'role': role, 'sub_name': sub_name}
        await self.db.save_admin_token(token, role, expire, sub_name)
        return token

    async def verify_token(self, token: str) -> bool:
        detail = await self.verify_token_detail(token)
        return bool(detail.get('valid'))

    async def verify_token_detail(self, token: str) -> dict:
        if not token:
            return {'valid': False, 'reason': 'missing'}
        token_data = self.tokens.get(token)
        if not token_data:
            token_data = await self.db.get_admin_token(token)
            if token_data:
                self.tokens[token] = token_data
        if not token_data:
            invalidation = await self.db.get_admin_token_invalidation(token)
            if invalidation:
                return {
                    'valid': False,
                    'reason': invalidation.get('reason') or 'invalid',
                    'role': invalidation.get('role') or '',
                    'sub_name': invalidation.get('sub_name') or '',
                    'invalidated_at': invalidation.get('invalidated_at'),
                }
            return {'valid': False, 'reason': 'invalid'}
        if time.time() > token_data.get('expire', 0):
            self.tokens.pop(token, None)
            await self.db.delete_admin_token(token, reason='expired')
            return {
                'valid': False,
                'reason': 'expired',
                'role': token_data.get('role') or '',
                'sub_name': token_data.get('sub_name') or '',
            }
        return {
            'valid': True,
            'reason': 'ok',
            'role': token_data.get('role') or '',
            'sub_name': token_data.get('sub_name') or '',
            'expire': token_data.get('expire', 0),
        }

    def get_role(self, token: str):
        if not token:
            return None
        token_data = self.tokens.get(token)
        if token_data and time.time() <= token_data.get('expire', 0):
            return token_data.get('role')
        return None

    def get_sub_name(self, token: str) -> str:
        if not token:
            return ''
        token_data = self.tokens.get(token)
        if token_data and time.time() <= token_data.get('expire', 0):
            return token_data.get('sub_name', '')
        return ''

    async def kick_sub_admins(self, target_name: str = None) -> int:
        if target_name:
            tokens_to_remove = [t for t, d in self.tokens.items()
                                if d.get('role') == self.sub_admin_role and d.get('sub_name') == target_name]
            for t in tokens_to_remove:
                self.tokens.pop(t, None)
            count = await self.db.delete_admin_tokens_by_sub_name(target_name, reason='kicked')
            return max(len(tokens_to_remove), count)

        tokens_to_remove = [t for t, d in self.tokens.items() if d.get('role') == self.sub_admin_role]
        for t in tokens_to_remove:
            self.tokens.pop(t, None)
        count = await self.db.delete_admin_tokens_by_role(self.sub_admin_role, reason='kicked')
        return max(len(tokens_to_remove), count)

    async def cleanup_expired(self):
        expired = [k for k, v in self.tokens.items() if v.get('expire', 0) < time.time()]
        for k in expired:
            self.tokens.pop(k, None)
        await self.db.cleanup_expired_tokens()
