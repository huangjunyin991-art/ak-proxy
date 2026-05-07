import secrets
import time


class DbAuthSessionService:
    def __init__(self, secondary_password: str, token_ttl_seconds: int = 1800):
        self.secondary_password = secondary_password
        self.token_ttl_seconds = token_ttl_seconds
        self.tokens = {}

    def generate_token(self) -> str:
        token = secrets.token_urlsafe(32)
        self.tokens[token] = time.time() + self.token_ttl_seconds
        expired = [k for k, v in self.tokens.items() if v < time.time()]
        for k in expired:
            del self.tokens[k]
        return token

    def verify_token(self, token: str) -> bool:
        if not token:
            return False
        expire_time = self.tokens.get(token)
        if not expire_time or time.time() > expire_time:
            self.tokens.pop(token, None)
            return False
        return True

    def verify_password(self, password: str) -> bool:
        if not password or not isinstance(password, str):
            return False
        return secrets.compare_digest(password, self.secondary_password)
