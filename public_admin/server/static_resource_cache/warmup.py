import re
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Sequence
from urllib.parse import urljoin, urlsplit, urlunsplit


DEFAULT_PREWARM_PAGES = (
    "/pages/home.html?first=true",
    "/pages/center.html",
    "/pages/ep.list.html",
    "/pages/ace.list.html",
    "/pages/center/security-settings.html",
    "/pages/center/financial_management.html",
)

STATIC_RESOURCE_EXTENSIONS = {
    ".js", ".mjs", ".css",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".mp3", ".mp4", ".webm", ".wasm", ".map",
}

_ATTR_URL_RE = re.compile(
    r"""(?:src|href|poster|data-src|data-original)\s*=\s*["']([^"'\r\n<>]+)["']""",
    re.IGNORECASE,
)
_CSS_URL_RE = re.compile(r"""url\(\s*["']?([^"')\r\n]+)["']?\s*\)""", re.IGNORECASE)
_STRING_STATIC_RE = re.compile(
    r"""["']((?:/admin/ak-web/|/ak-web/|/assets/|/content/|assets/|content/)[^"'\s<>)]+)["']""",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class WarmupFetchResult:
    path: str
    status_code: int
    content_type: str
    text: str
    elapsed_ms: int = 0
    error: str = ""


@dataclass(frozen=True)
class WarmupAssetResult:
    path: str
    state: str
    status_code: int = 0
    content_type: str = ""
    body_size: int = 0
    elapsed_ms: int = 0
    text: str = ""
    error: str = ""


class StaticResourceWarmupService:
    def __init__(
        self,
        fetch_page: Callable[[str], Awaitable[WarmupFetchResult]],
        cache_asset: Callable[[str], Awaitable[WarmupAssetResult]],
        default_pages: Sequence[str] | None = None,
    ):
        self.fetch_page = fetch_page
        self.cache_asset = cache_asset
        self.default_pages = tuple(default_pages or DEFAULT_PREWARM_PAGES)

    async def prewarm_default(self, pages: Sequence[str] | None = None, max_assets: int = 180) -> dict:
        started_at = time.perf_counter()
        page_paths = [normalize_page_path(path) for path in (pages or self.default_pages)]
        page_paths = [path for path in dict.fromkeys(page_paths) if path]
        max_assets = max(1, min(int(max_assets or 180), 500))
        discovered: list[str] = []
        seen_assets: set[str] = set()
        page_results: list[dict] = []

        for page_path in page_paths:
            page_started = len(discovered)
            try:
                page = await self.fetch_page(page_path)
                if page.status_code == 200 and page.text:
                    for asset in extract_static_resource_paths(page.text, page.path):
                        if asset not in seen_assets:
                            seen_assets.add(asset)
                            discovered.append(asset)
                            if len(discovered) >= max_assets:
                                break
                page_results.append({
                    "path": page_path,
                    "status_code": page.status_code,
                    "content_type": page.content_type,
                    "elapsed_ms": page.elapsed_ms,
                    "asset_count": max(0, len(discovered) - page_started),
                    "error": page.error,
                })
            except Exception as exc:
                page_results.append({
                    "path": page_path,
                    "status_code": 0,
                    "content_type": "",
                    "elapsed_ms": 0,
                    "asset_count": 0,
                    "error": str(exc)[:220],
                })
            if len(discovered) >= max_assets:
                break

        asset_results: list[dict] = []
        cursor = 0
        while cursor < len(discovered) and cursor < max_assets:
            asset_path = discovered[cursor]
            cursor += 1
            try:
                result = await self.cache_asset(asset_path)
            except Exception as exc:
                result = WarmupAssetResult(path=asset_path, state="ERROR", error=str(exc)[:220])
            asset_results.append(_asset_result_to_dict(result))
            if _can_extract_nested_assets(result):
                for nested in extract_static_resource_paths(result.text, result.path):
                    if nested not in seen_assets and len(discovered) < max_assets:
                        seen_assets.add(nested)
                        discovered.append(nested)

        summary = _summarize(asset_results)
        summary.update({
            "pages": len(page_results),
            "discovered": len(discovered),
            "attempted": len(asset_results),
            "elapsed_ms": max(0, int((time.perf_counter() - started_at) * 1000)),
            "max_assets": max_assets,
        })
        return {
            "summary": summary,
            "pages": page_results,
            "assets": asset_results[:120],
            "default_pages": list(self.default_pages),
        }


def normalize_page_path(path: str) -> str:
    value = str(path or "").strip()
    if not value:
        return ""
    parsed = urlsplit(value)
    path_value = parsed.path or value.split("?", 1)[0]
    if not path_value.startswith("/"):
        path_value = "/" + path_value
    if not path_value.startswith("/pages/") or ".." in path_value.split("/"):
        return ""
    query = parsed.query or (value.split("?", 1)[1] if "?" in value and not parsed.query else "")
    return urlunsplit(("", "", path_value, query, ""))


def extract_static_resource_paths(text: str, base_path: str = "") -> list[str]:
    if not text:
        return []
    candidates: list[str] = []
    for pattern in (_ATTR_URL_RE, _CSS_URL_RE, _STRING_STATIC_RE):
        candidates.extend(match.group(1) for match in pattern.finditer(text))
    result: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        normalized = normalize_static_resource_path(candidate, base_path)
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


def normalize_static_resource_path(raw_url: str, base_path: str = "") -> str:
    value = str(raw_url or "").strip()
    if not value or value.startswith(("#", "data:", "blob:", "javascript:", "mailto:", "tel:")):
        return ""
    if value.startswith("//"):
        return ""
    if value.startswith(("http://", "https://")):
        parsed_absolute = urlsplit(value)
        if str(parsed_absolute.hostname or "").lower() not in {"k937.com", "www.k937.com", "ak2025.vip"}:
            return ""
    elif value.startswith("/"):
        value = "https://k937.com" + value
    else:
        base = "https://k937.com" + (base_path if str(base_path or "").startswith("/") else "/" + str(base_path or ""))
        value = urljoin(base, value)
    parsed = urlsplit(value)
    path = parsed.path or ""
    if path.startswith("/admin/ak-web/"):
        path = path[len("/admin/ak-web"):]
    elif path.startswith("/ak-web/"):
        path = path[len("/ak-web"):]
    if not path.startswith(("/assets/", "/content/")):
        return ""
    if ".." in path.split("/"):
        return ""
    extension = _extension(path)
    if extension not in STATIC_RESOURCE_EXTENSIONS:
        return ""
    query = _safe_query(parsed.query)
    return urlunsplit(("", "", path, query, ""))


def _safe_query(query: str) -> str:
    denied = {"token", "auth", "session", "sid", "key", "userkey", "userid", "user_id", "bs", "ak_static_v"}
    pairs = []
    for part in str(query or "").split("&"):
        if not part:
            continue
        key = part.split("=", 1)[0].lower()
        if key in denied:
            continue
        pairs.append(part)
    return "&".join(pairs)


def _extension(path: str) -> str:
    clean_path = str(path or "").split("?", 1)[0].lower()
    dot = clean_path.rfind(".")
    slash = clean_path.rfind("/")
    if dot <= slash:
        return ""
    return clean_path[dot:]


def _can_extract_nested_assets(result: WarmupAssetResult) -> bool:
    content_type = str(result.content_type or "").lower()
    path = str(result.path or "").lower()
    if not result.text:
        return False
    return "text/css" in content_type or "javascript" in content_type or path.endswith((".css", ".js", ".mjs"))


def _asset_result_to_dict(result: WarmupAssetResult) -> dict:
    return {
        "path": result.path,
        "state": result.state,
        "status_code": result.status_code,
        "content_type": result.content_type,
        "body_size": result.body_size,
        "elapsed_ms": result.elapsed_ms,
        "error": result.error,
    }


def _summarize(items: list[dict]) -> dict:
    states: dict[str, int] = {}
    for item in items:
        state = str(item.get("state") or "UNKNOWN").upper()
        states[state] = states.get(state, 0) + 1
    return {
        "hit": states.get("HIT", 0),
        "miss": states.get("MISS", 0),
        "bypass": states.get("BYPASS", 0),
        "error": states.get("ERROR", 0),
        "states": states,
    }
