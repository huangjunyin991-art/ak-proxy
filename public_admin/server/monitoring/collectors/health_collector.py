from datetime import datetime, timezone

import httpx


async def collect_health_snapshot(pool, im_server_internal_url: str = "", timeout_seconds: float = 2.0) -> dict:
    data = {
        "available": True,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "database": {"ok": False, "message": ""},
        "im_server": {"ok": False, "message": "", "url": str(im_server_internal_url or "")},
    }
    try:
        async with pool.acquire() as conn:
            value = await conn.fetchval("SELECT 1")
        data["database"] = {"ok": value == 1, "message": "数据库连接正常" if value == 1 else "数据库响应异常"}
    except Exception as exc:
        data["database"] = {"ok": False, "message": str(exc)[:300]}
    normalized_url = str(im_server_internal_url or "").rstrip("/")
    if not normalized_url:
        data["im_server"] = {"ok": False, "message": "未配置 IM 服务地址", "url": ""}
        return data
    try:
        async with httpx.AsyncClient(timeout=timeout_seconds, trust_env=False) as client:
            response = await client.get(f"{normalized_url}/healthz")
        ok = response.status_code < 400
        data["im_server"] = {
            "ok": ok,
            "message": "IM 服务正常" if ok else f"IM 服务响应异常: {response.status_code}",
            "url": normalized_url,
            "status_code": response.status_code,
        }
    except Exception as exc:
        data["im_server"] = {"ok": False, "message": str(exc)[:300], "url": normalized_url}
    return data
