from .fallback import PANEL_KEYS, calculate_panel_versions
from .manifest import load_manifest_versions


def get_admin_panel_versions(frontend_pages_dir: str) -> dict[str, float]:
    manifest_versions = load_manifest_versions(frontend_pages_dir) or {}
    missing_keys = [key for key in PANEL_KEYS if key not in manifest_versions]
    if missing_keys:
        manifest_versions.update(calculate_panel_versions(frontend_pages_dir, missing_keys))
    return {key: float(manifest_versions.get(key) or 0.0) for key in PANEL_KEYS}
