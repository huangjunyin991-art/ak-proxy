import os
from typing import Iterable, Optional


PANEL_KEYS = (
    "monitoring",
    "meeting",
    "activeDefense",
    "riskIsolation",
    "recommendTree",
    "pointStats",
    "settings",
)


PANEL_VERSION_FILES = {
    "monitoring": (
        ("monitoring", "monitoring_panel.js"),
        ("monitoring", "monitoring_panel.css"),
    ),
    "meeting": (
        ("meeting_admin_panel.js",),
    ),
    "activeDefense": (
        ("active_defense_panel.js",),
    ),
    "riskIsolation": (
        ("risk_isolation_panel.js",),
    ),
    "recommendTree": (
        ("recommend_tree", "recommend_tree_api.js"),
        ("recommend_tree", "recommend_tree_panel.css"),
        ("recommend_tree", "recommend_tree_panel.js"),
        ("recommend_tree", "recommend_tree_renderer.js"),
        ("recommend_tree", "recommend_tree_store.js"),
        ("recommend_tree", "recommend_tree_utils.js"),
    ),
    "pointStats": (
        ("point_stats", "date_picker", "date_picker.css"),
        ("point_stats", "date_picker", "date_picker_controller.js"),
        ("point_stats", "date_picker", "date_picker_index.js"),
        ("point_stats", "date_picker", "date_picker_renderer.js"),
        ("point_stats", "date_picker", "date_picker_state.js"),
        ("point_stats", "date_picker", "date_picker_utils.js"),
        ("point_stats", "date_picker_options.html"),
        ("point_stats", "point_stats_api.js"),
        ("point_stats", "point_stats_panel.css"),
        ("point_stats", "point_stats_panel.js"),
        ("point_stats", "point_stats_renderer.js"),
        ("point_stats", "point_stats_store.js"),
    ),
    "settings": (
        ("settings_panel.js",),
    ),
}


def max_mtime(paths: Iterable[str]) -> float:
    latest = 0.0
    for path in paths:
        try:
            if os.path.isfile(path):
                latest = max(latest, os.path.getmtime(path))
        except OSError:
            pass
    return latest


def calculate_panel_versions(frontend_pages_dir: str, keys: Optional[Iterable[str]] = None) -> dict[str, float]:
    selected_keys = tuple(keys) if keys is not None else PANEL_KEYS
    versions = {}
    for key in selected_keys:
        relative_paths = PANEL_VERSION_FILES.get(key, ())
        versions[key] = max_mtime(os.path.join(frontend_pages_dir, *parts) for parts in relative_paths)
    return versions
