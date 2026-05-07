class OperationAuthRepository:
    def __init__(self, db_module):
        self.db = db_module

    async def get_totp_secret(self, identity: str):
        return await self.db.get_admin_totp_secret(identity)

    async def upsert_totp_secret(self, identity: str, role: str, sub_name: str, secret: str):
        return await self.db.upsert_admin_totp_secret(identity, role, sub_name, secret)

    async def list_totp_secrets(self):
        return await self.db.list_admin_totp_secrets()

    async def save_lease(self, lease_token: str, admin_token: str, role: str, sub_name: str,
                         scope: str, expire: float, client_ip: str = '', user_agent: str = ''):
        return await self.db.save_admin_operation_lease(
            lease_token, admin_token, role, sub_name, scope, expire, client_ip, user_agent
        )

    async def get_lease(self, lease_token: str):
        return await self.db.get_admin_operation_lease(lease_token)

    async def touch_lease(self, lease_token: str):
        await self.db.touch_admin_operation_lease(lease_token)

    async def delete_lease(self, lease_token: str):
        await self.db.delete_admin_operation_lease(lease_token)

    async def cleanup_expired_leases(self, now_ts: float | None = None) -> int:
        return await self.db.cleanup_expired_admin_operation_leases(now_ts)
