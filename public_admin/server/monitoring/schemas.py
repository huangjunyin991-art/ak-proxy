from datetime import datetime, timezone


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def error_item(source: str, message: str) -> dict:
    return {"source": str(source or ""), "message": str(message or "")[:300]}


def unavailable(source: str, message: str) -> dict:
    return {
        "available": False,
        "source": str(source or ""),
        "message": str(message or "")[:300],
        "generated_at": utc_now_iso(),
    }
