from __future__ import annotations

import json
import os
import tempfile
import time
from typing import Any


DEFAULT_MAX_ACTIVE_SESSIONS = 10


class RemoteVoiceSettingsStore:
    def __init__(self, base_dir: str | None = None):
        self.base_dir = base_dir or os.path.dirname(__file__)
        self.file_path = os.path.join(self.base_dir, 'voice_settings.json')

    def load(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            'max_active_sessions': DEFAULT_MAX_ACTIVE_SESSIONS,
            'updated_at': 0,
            'updated_by': '',
        }
        try:
            if not os.path.exists(self.file_path):
                return data
            with open(self.file_path, 'r', encoding='utf-8') as f:
                loaded = json.load(f) or {}
            value = int(loaded.get('max_active_sessions') or DEFAULT_MAX_ACTIVE_SESSIONS)
            data['max_active_sessions'] = max(1, value)
            data['updated_at'] = float(loaded.get('updated_at') or 0)
            data['updated_by'] = str(loaded.get('updated_by') or '')
        except Exception:
            return data
        return data

    def save(self, max_active_sessions: int, updated_by: str = '') -> dict[str, Any]:
        payload = {
            'max_active_sessions': max(1, int(max_active_sessions)),
            'updated_at': time.time(),
            'updated_by': str(updated_by or ''),
        }
        os.makedirs(self.base_dir, exist_ok=True)
        fd, temp_path = tempfile.mkstemp(prefix='voice_settings_', suffix='.json', dir=self.base_dir)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            os.replace(temp_path, self.file_path)
        except Exception:
            try:
                os.unlink(temp_path)
            except Exception:
                pass
            raise
        return payload
