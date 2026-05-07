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

    async def generate_token(self, role: str, sub_name: str = '') -> str:
        if role == self.sub_admin_role and sub_name:
            tokens_to_remove = [t for t, d in self.tokens.items()
                                if d.get('role') == self.sub_admin_role and d.get('sub_name') == sub_name]
            for t in tokens_to_remove:
                self.tokens.pop(t, None)
            await self.db.delete_admin_tokens_by_sub_name(sub_name)
        else:
            tokens_to_remove = [t for t, d in self.tokens.items() if d.get('role') == role]
            for t in tokens_to_remove:
                self.tokens.pop(t, None)
            await self.db.delete_admin_tokens_by_role(role)

        token = secrets.token_urlsafe(32)
        expire = time.time() + self.token_ttl_seconds
        self.tokens[token] = {'expire': expire, 'role': role, 'sub_name': sub_name}
        await self.db.save_admin_token(token, role, expire, sub_name)
        return token

    async def verify_token(self, token: str) -> bool:
        if not token:
            return False
        token_data = self.tokens.get(token)
        if not token_data:
            token_data = await self.db.get_admin_token(token)
            if token_data:
                self.tokens[token] = token_data
        if not token_data:
            return False
        if time.time() > token_data.get('expire', 0):
            self.tokens.pop(token, None)
            await self.db.delete_admin_token(token)
            return False
        return True

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
            count = await self.db.delete_admin_tokens_by_sub_name(target_name)
            return max(len(tokens_to_remove), count)

        tokens_to_remove = [t for t, d in self.tokens.items() if d.get('role') == self.sub_admin_role]
        for t in tokens_to_remove:
            self.tokens.pop(t, None)
        count = await self.db.delete_admin_tokens_by_role(self.sub_admin_role)
        return max(len(tokens_to_remove), count)

    async def cleanup_expired(self):
        expired = [k for k, v in self.tokens.items() if v.get('expire', 0) < time.time()]
        for k in expired:
            self.tokens.pop(k, None)
        await self.db.cleanup_expired_tokens()
