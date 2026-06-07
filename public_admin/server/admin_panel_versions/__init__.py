import os

from .fallback import PANEL_KEYS, calculate_panel_versions
from .manifest import load_manifest_versions, manifest_path


def _manifest_mtime(frontend_pages_dir: str) -> float:
    try:
        return os.path.getmtime(manifest_path(frontend_pages_dir))
    except OSError:
        return 0.0


def get_admin_panel_versions(frontend_pages_dir: str) -> dict[str, float]:
    manifest_versions = load_manifest_versions(frontend_pages_dir) or {}
    calculated_versions = calculate_panel_versions(frontend_pages_dir)
    manifest_updated_at = _manifest_mtime(frontend_pages_dir)
    versions = {}
    for key in PANEL_KEYS:
        calculated = float(calculated_versions.get(key) or 0.0)
        manifest = float(manifest_versions.get(key) or 0.0)
        # 旧 manifest 不应该压住更晚修改的拆分面板文件，否则浏览器会继续加载旧 panel。
        versions[key] = manifest if manifest and manifest_updated_at >= calculated else calculated
    return versions
