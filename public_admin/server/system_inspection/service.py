from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx

from ..monitoring.collectors.system_collector import collect_system_snapshot
from ..security.upstream_http import resolve_upstream_tls_verify


CheckSupplier = Callable[[], object]


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _elapsed_ms(started_at: float) -> int:
    return int(max(0.0, (time.perf_counter() - started_at) * 1000))


def _short_message(value: Any) -> str:
    return str(value or "")[:300]


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value or 0))
    except Exception:
        return default


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value or 0)
    except Exception:
        return default


def _check_result(
    check_id: str,
    title: str,
    group: str,
    status: str,
    message: str,
    *,
    detail: dict[str, Any] | None = None,
    suggestion: str = "",
    elapsed_ms: int = 0,
) -> dict[str, Any]:
    normalized_status = status if status in {"ok", "warn", "error"} else "warn"
    return {
        "id": check_id,
        "title": title,
        "group": group,
        "status": normalized_status,
        "message": _short_message(message),
        "suggestion": _short_message(suggestion),
        "detail": detail or {},
        "elapsed_ms": int(elapsed_ms or 0),
    }


class SystemInspectionService:
    def __init__(
        self,
        *,
        pool_supplier: CheckSupplier,
        im_server_internal_url: str = "",
        ak_upstream_url: str = "https://k937.com/pages/home.html?first=true",
        static_cache_supplier: CheckSupplier | None = None,
        request_metrics_supplier: CheckSupplier | None = None,
        ws_ticket_supplier: CheckSupplier | None = None,
        notify_center_supplier: CheckSupplier | None = None,
        notify_worker_supplier: CheckSupplier | None = None,
        timeout_seconds: float = 2.5,
    ):
        self.pool_supplier = pool_supplier
        self.im_server_internal_url = str(im_server_internal_url or "").rstrip("/")
        self.ak_upstream_url = str(ak_upstream_url or "").strip() or "https://k937.com/pages/home.html?first=true"
        self.static_cache_supplier = static_cache_supplier
        self.request_metrics_supplier = request_metrics_supplier
        self.ws_ticket_supplier = ws_ticket_supplier
        self.notify_center_supplier = notify_center_supplier
        self.notify_worker_supplier = notify_worker_supplier
        self.timeout_seconds = max(0.5, min(10.0, float(timeout_seconds or 2.5)))

    async def run(self) -> dict[str, Any]:
        started_at = time.perf_counter()
        checks = await asyncio.gather(
            self._run_check(self._check_system),
            self._run_check(self._check_database),
            self._run_check(self._check_im_server),
            self._run_check(self._check_ws_ticket),
            self._run_check(self._check_ak_upstream),
            self._run_check(self._check_static_cache),
            self._run_check(self._check_notify_center),
            self._run_check(self._check_request_metrics),
        )
        normalized = [item for item in checks if isinstance(item, dict)]
        severity = self._overall_status(normalized)
        return {
            "success": True,
            "generated_at": _utc_now_iso(),
            "elapsed_ms": _elapsed_ms(started_at),
            "summary": self._summary(normalized, severity),
            "groups": self._groups(normalized),
            "checks": normalized,
        }

    async def _run_check(self, check: Callable[[], Awaitable[dict[str, Any]]]) -> dict[str, Any]:
        try:
            return await check()
        except Exception as exc:
            return _check_result(
                "inspection_internal",
                "巡检执行器",
                "基础服务",
                "error",
                f"巡检项执行失败：{exc}",
                suggestion="查看 ak-proxy 日志，确认巡检检查器是否抛出未处理异常。",
            )

    async def _check_system(self) -> dict[str, Any]:
        started = time.perf_counter()
        snapshot = collect_system_snapshot()
        status = "ok"
        message = "服务器负载正常"
        suggestion = ""
        if not snapshot.get("available", True):
            status = "warn"
            message = "系统指标采集不可用"
            suggestion = "确认 psutil 或 /proc 指标是否可读取。"
        elif snapshot.get("high_load"):
            status = "warn"
            reasons = "；".join(str(item) for item in snapshot.get("high_load_reasons") or [])
            message = reasons or "服务器处于高负载状态"
            suggestion = "优先查看 CPU、内存、负载和最近慢请求，必要时临时降低重统计或后台任务频率。"
        memory = snapshot.get("memory") if isinstance(snapshot.get("memory"), dict) else {}
        disk = snapshot.get("disk") if isinstance(snapshot.get("disk"), dict) else {}
        detail = {
            "cpu_percent": snapshot.get("cpu_percent"),
            "memory_percent": memory.get("percent"),
            "disk_percent": disk.get("percent"),
            "process_uptime_seconds": snapshot.get("process_uptime_seconds"),
            "high_load_reasons": snapshot.get("high_load_reasons") or [],
        }
        return _check_result("system_load", "服务器负载", "基础服务", status, message, detail=detail, suggestion=suggestion, elapsed_ms=_elapsed_ms(started))

    async def _check_database(self) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            pool = self.pool_supplier()
            async with pool.acquire() as conn:
                value = await conn.fetchval("SELECT 1")
                table_count = await conn.fetchval("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public'")
            ok = value == 1
            return _check_result(
                "database",
                "数据库连接",
                "基础服务",
                "ok" if ok else "error",
                "数据库连接正常" if ok else "数据库响应异常",
                detail={"table_count": _as_int(table_count)},
                suggestion="" if ok else "检查 DATABASE_URL、PostgreSQL 服务状态和连接池耗尽情况。",
                elapsed_ms=_elapsed_ms(started),
            )
        except Exception as exc:
            return _check_result("database", "数据库连接", "基础服务", "error", f"数据库连接失败：{exc}", suggestion="检查 PostgreSQL 服务、账号密码、网络和连接池状态。", elapsed_ms=_elapsed_ms(started))

    async def _check_im_server(self) -> dict[str, Any]:
        started = time.perf_counter()
        if not self.im_server_internal_url:
            return _check_result("im_server", "IM 服务", "网络链路", "warn", "未配置 IM 内部服务地址", suggestion="确认 IM_SERVER_INTERNAL_URL 是否配置。", elapsed_ms=_elapsed_ms(started))
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds, trust_env=False) as client:
                response = await client.get(f"{self.im_server_internal_url}/healthz")
            ok = response.status_code < 400
            return _check_result(
                "im_server",
                "IM 服务",
                "网络链路",
                "ok" if ok else "error",
                "IM 服务健康接口正常" if ok else f"IM 服务响应异常：HTTP {response.status_code}",
                detail={"url": self.im_server_internal_url, "status_code": response.status_code},
                suggestion="" if ok else "检查 im-server 进程、端口、反向代理和 /healthz 接口。",
                elapsed_ms=_elapsed_ms(started),
            )
        except Exception as exc:
            return _check_result("im_server", "IM 服务", "网络链路", "error", f"IM 服务不可达：{exc}", detail={"url": self.im_server_internal_url}, suggestion="检查 im-server 是否启动，以及 ak-proxy 到 IM 内部地址是否连通。", elapsed_ms=_elapsed_ms(started))

    async def _check_ak_upstream(self) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds, follow_redirects=True, trust_env=False, verify=resolve_upstream_tls_verify("system_inspection", default=False)) as client:
                response = await client.get(self.ak_upstream_url)
            status_code = int(response.status_code)
            ok = status_code < 500
            warn = status_code >= 400
            return _check_result(
                "ak_upstream",
                "AK 上游网页",
                "网络链路",
                "ok" if ok and not warn else ("warn" if ok else "error"),
                "AK 上游网页可访问" if ok and not warn else f"AK 上游返回 HTTP {status_code}",
                detail={"url": self.ak_upstream_url, "status_code": status_code, "bytes": len(response.content or b"")},
                suggestion="" if ok and not warn else "检查上游站点状态、出口网络、TLS 配置和风控返回。",
                elapsed_ms=_elapsed_ms(started),
            )
        except Exception as exc:
            return _check_result("ak_upstream", "AK 上游网页", "网络链路", "error", f"AK 上游不可达：{exc}", detail={"url": self.ak_upstream_url}, suggestion="检查服务器出口网络、DNS、TLS 证书配置和上游站点可用性。", elapsed_ms=_elapsed_ms(started))

    async def _check_ws_ticket(self) -> dict[str, Any]:
        started = time.perf_counter()
        service = self.ws_ticket_supplier() if self.ws_ticket_supplier else None
        if service is None:
            return _check_result("ws_ticket", "WebSocket 短票", "网络链路", "error", "WebSocket 短票服务未初始化", suggestion="检查 ws_ticket_service 初始化和路由注册日志。", elapsed_ms=_elapsed_ms(started))
        try:
            pool = self.pool_supplier()
            async with pool.acquire() as conn:
                table_name = await conn.fetchval("SELECT to_regclass('public.ws_tickets')::text")
                event_table_name = await conn.fetchval("SELECT to_regclass('public.ws_ticket_events')::text")
            repository = getattr(service, "repository", None)
            ttl_seconds = _as_int(getattr(service, "ttl_seconds", 0))
            has_repository = bool(repository is not None and hasattr(repository, "insert_ticket") and hasattr(repository, "consume_ticket"))
            ok = bool(table_name and has_repository and ttl_seconds > 0)
            warn = ok and not bool(event_table_name)
            status = "ok" if ok and not warn else ("warn" if ok else "error")
            message = "WebSocket 短票服务正常" if status == "ok" else ("短票事件表未就绪" if warn else "WebSocket 短票服务不完整")
            suggestion = "" if status == "ok" else "检查 ws_tickets 表初始化、WsTicketRepository 和 ak-proxy 启动日志。"
            detail = {
                "ttl_seconds": ttl_seconds,
                "has_repository": has_repository,
                "ws_tickets_table": table_name or "",
                "ws_ticket_events_table": event_table_name or "",
            }
            return _check_result("ws_ticket", "WebSocket 短票", "网络链路", status, message, detail=detail, suggestion=suggestion, elapsed_ms=_elapsed_ms(started))
        except Exception as exc:
            return _check_result("ws_ticket", "WebSocket 短票", "网络链路", "error", f"WebSocket 短票检查失败：{exc}", suggestion="检查数据库表、连接池和短票服务对象。", elapsed_ms=_elapsed_ms(started))

    async def _check_static_cache(self) -> dict[str, Any]:
        started = time.perf_counter()
        service = self.static_cache_supplier() if self.static_cache_supplier else None
        if service is None:
            return _check_result("static_cache", "上游静态缓存", "缓存与通知", "warn", "静态缓存服务未启用", suggestion="确认 AK 静态资源缓存服务是否初始化。", elapsed_ms=_elapsed_ms(started))
        try:
            snapshot = service.snapshot() if hasattr(service, "snapshot") else {}
            memory = snapshot.get("memory_cache") if isinstance(snapshot.get("memory_cache"), dict) else {}
            browser = snapshot.get("browser_policy") if isinstance(snapshot.get("browser_policy"), dict) else {}
            lock_count = _as_int(snapshot.get("lock_count"))
            status = "ok"
            message = "静态缓存服务正常"
            suggestion = ""
            if lock_count >= 50:
                status = "warn"
                message = f"静态缓存锁数量偏高：{lock_count}"
                suggestion = "如果锁长期不释放，执行运行时维护或检查上游资源请求是否卡住。"
            detail = {
                "lock_count": lock_count,
                "memory_entries": _as_int(memory.get("entry_count") or memory.get("entries")),
                "memory_bytes": _as_int(memory.get("total_bytes") or memory.get("bytes")),
                "browser_enabled": browser.get("enabled"),
                "cache_version": browser.get("version"),
            }
            return _check_result("static_cache", "上游静态缓存", "缓存与通知", status, message, detail=detail, suggestion=suggestion, elapsed_ms=_elapsed_ms(started))
        except Exception as exc:
            return _check_result("static_cache", "上游静态缓存", "缓存与通知", "error", f"静态缓存状态读取失败：{exc}", suggestion="检查静态缓存服务对象和缓存目录权限。", elapsed_ms=_elapsed_ms(started))

    async def _check_notify_center(self) -> dict[str, Any]:
        started = time.perf_counter()
        service = self.notify_center_supplier() if self.notify_center_supplier else None
        worker = self.notify_worker_supplier() if self.notify_worker_supplier else None
        if service is None:
            return _check_result("notify_center", "通知中心", "缓存与通知", "warn", "通知中心未启用", suggestion="如果需要 ntfy/Web Push 通知，请检查通知中心环境变量和模块初始化日志。", elapsed_ms=_elapsed_ms(started))
        try:
            status_payload = await service.build_status() if hasattr(service, "build_status") else {}
            enabled = bool(status_payload.get("enabled"))
            ntfy_ready = bool(status_payload.get("ntfy_ready"))
            web_push_ready = bool(status_payload.get("web_push_ready"))
            worker_task = getattr(worker, "_task", None)
            worker_running = bool(worker_task is not None and not worker_task.done())
            status = "ok" if enabled and (ntfy_ready or web_push_ready) else "warn"
            message = "通知中心可用" if status == "ok" else "通知中心未完全就绪"
            suggestion = "" if status == "ok" else "检查 NOTIFY_CENTER_ENABLED、VAPID、ntfy 默认服务地址和 outbox worker 启动状态。"
            detail = {**status_payload, "worker_running": worker_running}
            return _check_result("notify_center", "通知中心", "缓存与通知", status, message, detail=detail, suggestion=suggestion, elapsed_ms=_elapsed_ms(started))
        except Exception as exc:
            return _check_result("notify_center", "通知中心", "缓存与通知", "error", f"通知中心状态读取失败：{exc}", suggestion="检查通知中心数据表、配置和 worker 日志。", elapsed_ms=_elapsed_ms(started))

    async def _check_request_metrics(self) -> dict[str, Any]:
        started = time.perf_counter()
        service = self.request_metrics_supplier() if self.request_metrics_supplier else None
        if service is None:
            return _check_result("request_metrics", "慢请求采集", "最近风险", "warn", "慢请求采集服务未启用", suggestion="需要排查接口耗时时可在性能监控中开启慢请求采集。", elapsed_ms=_elapsed_ms(started))
        try:
            snapshot = service.snapshot(limit=20) if hasattr(service, "snapshot") else {}
            policy = snapshot.get("policy") if isinstance(snapshot.get("policy"), dict) else {}
            summary = snapshot.get("summary") if isinstance(snapshot.get("summary"), dict) else {}
            enabled = bool(policy.get("enabled"))
            error_count = _as_int(summary.get("error_count"))
            slow_count = _as_int(summary.get("slow_count"))
            avg_total_ms = _as_float(summary.get("avg_total_ms"))
            if not enabled:
                status = "warn"
                message = "慢请求采集当前关闭"
                suggestion = "只有需要调试时再开启，平时关闭可以减少代理链路开销。"
            elif error_count > 0:
                status = "warn"
                message = f"最近记录到 {error_count} 条错误请求"
                suggestion = "展开性能监控中的慢请求与上游耗时，查看错误路径和出口。"
            elif slow_count > 0:
                status = "warn"
                message = f"最近记录到 {slow_count} 条慢请求"
                suggestion = "查看慢请求 Top，判断是上游耗时、重写注入还是缓存未命中导致。"
            else:
                status = "ok"
                message = "慢请求采集未发现风险样本"
                suggestion = ""
            detail = {"enabled": enabled, "error_count": error_count, "slow_count": slow_count, "avg_total_ms": avg_total_ms}
            return _check_result("request_metrics", "慢请求采集", "最近风险", status, message, detail=detail, suggestion=suggestion, elapsed_ms=_elapsed_ms(started))
        except Exception as exc:
            return _check_result("request_metrics", "慢请求采集", "最近风险", "error", f"慢请求状态读取失败：{exc}", suggestion="检查 request metrics 服务对象和性能监控配置。", elapsed_ms=_elapsed_ms(started))

    @staticmethod
    def _overall_status(checks: list[dict[str, Any]]) -> str:
        statuses = {str(item.get("status") or "") for item in checks}
        if "error" in statuses:
            return "error"
        if "warn" in statuses:
            return "warn"
        return "ok"

    @staticmethod
    def _summary(checks: list[dict[str, Any]], status: str) -> dict[str, Any]:
        counts = {"ok": 0, "warn": 0, "error": 0}
        for item in checks:
            key = str(item.get("status") or "warn")
            counts[key if key in counts else "warn"] += 1
        labels = {
            "ok": "系统巡检通过",
            "warn": "系统巡检存在提醒",
            "error": "系统巡检发现异常",
        }
        return {"status": status, "message": labels.get(status, "系统巡检完成"), "counts": counts, "total": len(checks)}

    @staticmethod
    def _groups(checks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        order = ["基础服务", "网络链路", "缓存与通知", "最近风险"]
        result = []
        for group in order:
            items = [item for item in checks if item.get("group") == group]
            if not items:
                continue
            status = SystemInspectionService._overall_status(items)
            result.append({"name": group, "status": status, "items": items})
        extra_groups = sorted({str(item.get("group") or "其他") for item in checks} - set(order))
        for group in extra_groups:
            items = [item for item in checks if item.get("group") == group]
            result.append({"name": group, "status": SystemInspectionService._overall_status(items), "items": items})
        return result
