from .fallback import PANEL_KEYS, calculate_panel_versions


def get_admin_panel_versions(frontend_pages_dir: str) -> dict[str, float]:
    """统一使用 panel 资源文件 mtime 生成版本，避免手工版本号压住新资源。"""
    calculated_versions = calculate_panel_versions(frontend_pages_dir)
    return {key: float(calculated_versions.get(key) or 0.0) for key in PANEL_KEYS}
