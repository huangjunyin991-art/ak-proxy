from typing import Any, Mapping

from ..context import SecurityContext
from ..result import SecurityResult
from .redactor import is_sensitive_key, redact_log_value


class SecurityAuditLogger:
    def __init__(self, logger):
        self.logger = logger

    def record(self, context: SecurityContext, result: SecurityResult, metadata: Mapping[str, Any] = None):
        try:
            payload = {
                'event': result.event,
                'success': result.success,
                'reason': result.reason,
                'role': result.role or '',
                'sub_name': result.sub_name or '',
                'client_ip': context.client_ip,
                'method': context.method,
                'path': context.path,
                'user_agent_hash': context.user_agent_hash,
                'request_id': context.request_id,
            }
            if metadata:
                payload.update(self._sanitize_metadata(metadata))
            if result.success:
                self.logger.info(f"[SecurityAudit] {payload}")
            else:
                self.logger.warning(f"[SecurityAudit] {payload}")
        except Exception:
            return

    def _sanitize_metadata(self, metadata: Mapping[str, Any]) -> dict:
        sanitized = {}
        for key, value in metadata.items():
            if is_sensitive_key(key):
                continue
            if isinstance(value, (str, int, float, bool)) or value is None:
                sanitized[str(key)] = redact_log_value(value)
        return sanitized
