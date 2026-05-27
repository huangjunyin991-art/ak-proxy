import json
import os
from typing import Any, Optional

from .fallback import PANEL_KEYS


MANIFEST_FILE_NAME = "panel_versions.json"


def manifest_path(frontend_pages_dir: str) -> str:
    return os.path.join(frontend_pages_dir, MANIFEST_FILE_NAME)


def parse_version_value(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        raw = value.strip()
        if raw.startswith("mt-"):
            raw = raw[3:]
        try:
            return float(raw)
        except ValueError:
            return None
    return None


def load_manifest_versions(frontend_pages_dir: str) -> Optional[dict[str, float]]:
    path = manifest_path(frontend_pages_dir)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    versions = {}
    for key in PANEL_KEYS:
        value = parse_version_value(data.get(key))
        if value is not None:
            versions[key] = value
    return versions
