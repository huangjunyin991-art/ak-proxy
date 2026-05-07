import secrets
from typing import Optional, Tuple


class AdminPasswordVerifier:
    def __init__(self, admin_password: str, sub_admins: dict, super_admin_role: str, sub_admin_role: str):
        self.admin_password = admin_password
        self.sub_admins = sub_admins
        self.super_admin_role = super_admin_role
        self.sub_admin_role = sub_admin_role

    def verify(self, password: str) -> Tuple[bool, Optional[str], Optional[str]]:
        if not password or not isinstance(password, str):
            return False, None, None
        if secrets.compare_digest(password, self.admin_password):
            return True, self.super_admin_role, None
        for sub_name, sub_data in self.sub_admins.items():
            sub_pwd = sub_data.get('password', '') if isinstance(sub_data, dict) else sub_data
            if sub_pwd and secrets.compare_digest(password, sub_pwd):
                return True, self.sub_admin_role, sub_name
        return False, None, None

    def is_super_admin_password(self, password: str) -> bool:
        return bool(password) and secrets.compare_digest(password, self.admin_password)

    def get_sub_admin_permissions(self, sub_name: str) -> dict:
        sub_data = self.sub_admins.get(sub_name, {})
        return sub_data.get('permissions', {}) if isinstance(sub_data, dict) else {}
