from .audit import SecurityAuditLogger
from .identity import AdminPasswordVerifier
from .risk import LockoutStore
from .session import AdminSessionService, DbAuthSessionService


class AdminSecurityFacade:
    def __init__(self, db_module, admin_password: str, secondary_password: str,
                 super_admin_role: str, sub_admin_role: str,
                 sub_admins: dict, login_max_fails: int, login_lockout_seconds: int,
                 db_auth_max_fails: int, logger=None):
        self.super_admin_role = super_admin_role
        self.sub_admin_role = sub_admin_role
        self.sub_admins = sub_admins
        self.passwords = AdminPasswordVerifier(
            admin_password=admin_password,
            sub_admins=self.sub_admins,
            super_admin_role=super_admin_role,
            sub_admin_role=sub_admin_role,
        )
        self.admin_sessions = AdminSessionService(db_module, sub_admin_role=sub_admin_role)
        self.db_auth_sessions = DbAuthSessionService(secondary_password)
        self.login_lockouts = LockoutStore(login_max_fails, login_lockout_seconds)
        self.db_auth_failures = LockoutStore(db_auth_max_fails, 0)
        self.audit = SecurityAuditLogger(logger) if logger is not None else None

    def bind_sub_admins(self, sub_admins: dict):
        self.sub_admins = sub_admins
        self.passwords.sub_admins = sub_admins

    def record_audit(self, context, result, metadata=None):
        if self.audit is not None:
            self.audit.record(context, result, metadata=metadata)
