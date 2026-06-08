from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import unquote, urlsplit, urlunsplit


_ALLOWED_IMAGE_PREFIXES = ("/im/assets/image/", "/im/assets/image-preview/")
_ALLOWED_STORAGE_EXTENSIONS = (
    ".avif",
    ".bmp",
    ".gif",
    ".heic",
    ".heif",
    ".jpeg",
    ".jpg",
    ".png",
    ".webp",
)


@dataclass(frozen=True)
class ImagePreviewSourceResult:
    allowed: bool
    src: str = ""
    reason: str = ""


def _reject(reason: str) -> ImagePreviewSourceResult:
    return ImagePreviewSourceResult(allowed=False, reason=reason)


def _normalize_origin(origin: str) -> str:
    parsed = urlsplit(str(origin or "").strip())
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def _contains_control_chars(value: str) -> bool:
    return any(ord(ch) < 32 or ord(ch) == 127 for ch in value)


def _is_safe_storage_name(storage_name: str) -> bool:
    decoded = unquote(str(storage_name or "").strip())
    if not decoded or ".." in decoded or "/" in decoded or "\\" in decoded:
        return False
    if not decoded.lower().endswith(_ALLOWED_STORAGE_EXTENSIONS):
        return False
    for ch in decoded:
        if ch.isascii() and (ch.isalnum() or ch in ".-_"):
            continue
        return False
    return True


def _validate_im_asset_path(path: str, query: str = "") -> ImagePreviewSourceResult:
    if not path.startswith("/") or path.startswith("//") or "\\" in path:
        return _reject("invalid_path")
    for prefix in _ALLOWED_IMAGE_PREFIXES:
        if path.startswith(prefix):
            storage_name = path[len(prefix):]
            if not _is_safe_storage_name(storage_name):
                return _reject("invalid_storage_name")
            normalized = urlunsplit(("", "", path, query, ""))
            return ImagePreviewSourceResult(allowed=True, src=normalized)
    return _reject("path_not_allowed")


def validate_im_image_preview_src(src: str, same_origin: str = "") -> ImagePreviewSourceResult:
    """Allow only IM image assets and same-origin blob previews for the preview page."""

    value = str(src or "").strip()
    if not value:
        return _reject("empty")
    if _contains_control_chars(value):
        return _reject("control_chars")

    parsed = urlsplit(value)
    scheme = parsed.scheme.lower()
    allowed_origin = _normalize_origin(same_origin)

    if scheme in ("http", "https"):
        origin = f"{scheme}://{parsed.netloc.lower()}"
        if not allowed_origin or origin != allowed_origin:
            return _reject("external_origin")
        return _validate_im_asset_path(parsed.path or "/", parsed.query)

    if scheme == "blob":
        inner = value[len("blob:"):]
        inner_parsed = urlsplit(inner)
        if allowed_origin and inner_parsed.scheme in ("http", "https") and inner_parsed.netloc:
            inner_origin = f"{inner_parsed.scheme.lower()}://{inner_parsed.netloc.lower()}"
            if inner_origin != allowed_origin:
                return _reject("external_blob_origin")
        return ImagePreviewSourceResult(allowed=True, src=value)

    if scheme:
        return _reject("scheme_not_allowed")
    if parsed.netloc:
        return _reject("network_path_not_allowed")
    return _validate_im_asset_path(parsed.path or "", parsed.query)


def build_im_image_preview_headers(nonce: str) -> dict[str, str]:
    safe_nonce = str(nonce or "").strip()
    return {
        "Cache-Control": "no-store",
        "Content-Security-Policy": (
            "default-src 'none'; "
            "base-uri 'none'; "
            "form-action 'none'; "
            "frame-ancestors 'none'; "
            "img-src 'self' blob:; "
            f"style-src 'nonce-{safe_nonce}'; "
            f"script-src 'nonce-{safe_nonce}'"
        ),
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
    }
