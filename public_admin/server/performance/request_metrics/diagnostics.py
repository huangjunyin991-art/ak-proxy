from collections import Counter, defaultdict
from typing import Any

from .models import RequestMetricsPolicy


def build_request_metrics_diagnostics(items: list[dict[str, Any]], policy: RequestMetricsPolicy) -> dict[str, Any]:
    rows = [dict(item or {}) for item in items if isinstance(item, dict)]
    if not rows:
        return {
            "sample_count": 0,
            "top_paths": [],
            "top_exits": [],
            "timing": _empty_timing(),
            "cache_states": {},
            "anomalies": {},
            "advice": [{"code": "no_samples", "severity": "info"}],
        }

    path_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    exit_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    cache_counts = Counter()
    anomaly_counts = Counter()
    for row in rows:
        method = _text(row.get("method") or "-").upper()
        path = _text(row.get("path") or "-")
        path_groups[f"{method} {path}"].append(row)
        exit_name = _text(row.get("exit_name") or "-") or "-"
        exit_groups[exit_name].append(row)
        cache_counts[_text(row.get("cache_state") or "NONE").upper() or "NONE"] += 1
        for code in _detect_anomalies(row):
            anomaly_counts[code] += 1

    timing = _summarize_timing(rows)
    top_paths = _top_groups(path_groups, limit=6)
    top_exits = _top_groups(exit_groups, limit=6, include_kind=False)
    advice = _build_advice(rows, top_paths, top_exits, timing, cache_counts, anomaly_counts, policy)
    return {
        "sample_count": len(rows),
        "top_paths": top_paths,
        "top_exits": top_exits,
        "timing": timing,
        "cache_states": dict(cache_counts),
        "anomalies": dict(anomaly_counts),
        "advice": advice,
    }


def _top_groups(groups: dict[str, list[dict[str, Any]]], limit: int = 6, include_kind: bool = True) -> list[dict[str, Any]]:
    result = []
    for key, rows in groups.items():
        total_values = [_int(row.get("total_ms")) for row in rows]
        upstream_values = [_int(row.get("upstream_ms")) for row in rows]
        total = sum(total_values)
        count = len(rows)
        item = {
            "key": key,
            "count": count,
            "avg_total_ms": round(total / count, 1) if count else 0,
            "max_total_ms": max(total_values) if total_values else 0,
            "avg_upstream_ms": round(sum(upstream_values) / count, 1) if count else 0,
            "error_count": sum(1 for row in rows if _is_error(row)),
            "html_rpc_count": sum(1 for row in rows if _is_rpc_html(row)),
        }
        if include_kind:
            item["kind"] = _text(rows[0].get("kind") or "")
            item["method"] = _text(rows[0].get("method") or "")
            item["path"] = _text(rows[0].get("path") or "")
        result.append(item)
    result.sort(key=lambda item: (item["count"], item["avg_total_ms"], item["max_total_ms"]), reverse=True)
    return result[:limit]


def _summarize_timing(rows: list[dict[str, Any]]) -> dict[str, Any]:
    count = len(rows)
    if not count:
        return _empty_timing()
    total_ms = sum(_int(row.get("total_ms")) for row in rows)
    upstream_ms = sum(_int(row.get("upstream_ms")) for row in rows)
    rewrite_ms = sum(_int(row.get("rewrite_ms")) for row in rows)
    inject_ms = sum(_int(row.get("inject_ms")) for row in rows)
    return {
        "avg_total_ms": round(total_ms / count, 1),
        "avg_upstream_ms": round(upstream_ms / count, 1),
        "avg_rewrite_ms": round(rewrite_ms / count, 1),
        "avg_inject_ms": round(inject_ms / count, 1),
        "upstream_ratio": _ratio(upstream_ms, total_ms),
        "rewrite_ratio": _ratio(rewrite_ms, total_ms),
        "inject_ratio": _ratio(inject_ms, total_ms),
    }


def _build_advice(
    rows: list[dict[str, Any]],
    top_paths: list[dict[str, Any]],
    top_exits: list[dict[str, Any]],
    timing: dict[str, Any],
    cache_counts: Counter,
    anomaly_counts: Counter,
    policy: RequestMetricsPolicy,
) -> list[dict[str, Any]]:
    advice = []
    sample_count = len(rows)
    if timing.get("upstream_ratio", 0) >= 0.8:
        advice.append({
            "code": "upstream_dominant",
            "severity": "warning",
            "ratio": timing.get("upstream_ratio", 0),
        })
    if top_paths:
        top = top_paths[0]
        if top.get("count", 0) >= max(3, sample_count * 0.35):
            advice.append({
                "code": "path_hotspot",
                "severity": "warning",
                "path": top.get("key", ""),
                "count": top.get("count", 0),
                "avg_total_ms": top.get("avg_total_ms", 0),
            })
    if top_exits:
        top_exit = top_exits[0]
        if top_exit.get("count", 0) >= max(3, sample_count * 0.35):
            advice.append({
                "code": "exit_hotspot",
                "severity": "warning",
                "exit_name": top_exit.get("key", ""),
                "count": top_exit.get("count", 0),
                "avg_total_ms": top_exit.get("avg_total_ms", 0),
            })
    if anomaly_counts.get("rpc_html_response", 0):
        advice.append({
            "code": "rpc_html_response",
            "severity": "danger",
            "count": anomaly_counts.get("rpc_html_response", 0),
        })
    if anomaly_counts.get("server_error", 0):
        advice.append({
            "code": "server_error",
            "severity": "danger",
            "count": anomaly_counts.get("server_error", 0),
        })
    static_cache_miss = cache_counts.get("MISS", 0) + cache_counts.get("BYPASS", 0)
    if static_cache_miss >= max(3, sample_count * 0.35):
        advice.append({
            "code": "cache_miss_hotspot",
            "severity": "info",
            "count": static_cache_miss,
        })
    if not advice:
        advice.append({
            "code": "samples_normal",
            "severity": "info",
            "threshold_ms": policy.slow_threshold_ms,
        })
    return advice[:5]


def _detect_anomalies(row: dict[str, Any]) -> list[str]:
    result = []
    if _is_rpc_html(row):
        result.append("rpc_html_response")
    if _is_error(row):
        result.append("server_error")
    if _int(row.get("total_ms")) > 0 and _int(row.get("upstream_ms")) <= 0 and _text(row.get("kind")) != "static_asset":
        result.append("missing_upstream_timing")
    return result


def _is_rpc_html(row: dict[str, Any]) -> bool:
    return _text(row.get("kind")).lower() == "rpc" and "text/html" in _text(row.get("content_type")).lower()


def _is_error(row: dict[str, Any]) -> bool:
    return bool(row.get("error")) or _int(row.get("status_code")) >= 500


def _empty_timing() -> dict[str, Any]:
    return {
        "avg_total_ms": 0,
        "avg_upstream_ms": 0,
        "avg_rewrite_ms": 0,
        "avg_inject_ms": 0,
        "upstream_ratio": 0,
        "rewrite_ratio": 0,
        "inject_ratio": 0,
    }


def _ratio(value: int | float, total: int | float) -> float:
    if not total:
        return 0
    return round(max(0.0, min(1.0, float(value) / float(total))), 3)


def _int(value: Any) -> int:
    try:
        return max(0, int(float(value or 0)))
    except Exception:
        return 0


def _text(value: Any) -> str:
    return str(value or "").strip()
