# -*- coding: utf-8 -*-
"""
出口IP调度器模块
管理多个出站通道（直连 + sing-box SOCKS5隧道），实现负载均衡。

核心设计:
- 异常安全: 所有调度方法 try/except 包裹，任何故障自动降级直连，绝不中断服务
- 均匀分配: 使用最少活跃连接数(least-connections)调度，保证每个IP同时使用人数接近
- Login限流: 每个出口IP限制 MAX_LOGIN_PER_MIN 次/分钟，超出轮换
- 403/429告警: 上游返回风控状态码时记录WARNING日志并统计
- 健康检查: 定期检测隧道存活，自动剔除/恢复
- 降级保底: 所有隧道故障时 fallback 直连
"""

import time
import asyncio
import logging
from typing import Optional

import httpx

logger = logging.getLogger("TransparentProxy")

# 需要告警的HTTP状态码
ALERT_STATUS_CODES = {
    403: "Forbidden(IP可能被封)",
    429: "Too Many Requests(请求过于频繁)",
    503: "Service Unavailable",
}


class OutboundExit:
    """单个出口通道"""
    __slots__ = ('name', 'proxy_url', 'healthy', 'total', 'login_count', 'errors',
                 'warn_403', 'warn_429', 'active', 'exit_ip', '_login_timestamps',
                 '_error_logs', '_req_timestamps', 'rate_limit', '_rate_lock',
                 '_inflight_logins', '_frozen_until')

    def __init__(self, name: str, proxy_url: Optional[str] = None):
        self.name = name
        self.proxy_url = proxy_url  # None=直连, "socks5://127.0.0.1:port"=隧道
        self.healthy = True
        self.total = 0          # 历史总请求
        self.login_count = 0    # 历史登录数
        self.errors = 0         # 连接错误数
        self.warn_403 = 0       # 403次数
        self.warn_429 = 0       # 429次数
        self.active = 0         # 当前正在处理的并发请求数
        self.exit_ip = ""       # 检测到的出口IP
        self._login_timestamps: list[float] = []
        self._error_logs: list[dict] = []  # [{time, msg}] 最多保留50条
        self._req_timestamps: list[float] = []  # 最近60秒请求时间戳
        self.rate_limit: int = 0  # 每分钟最大请求数, 0=不限速
        self._rate_lock = asyncio.Lock()
        self._inflight_logins: int = 0  # 正在飞行中的登录请求数
        self._frozen_until: float = 0    # 403后冻结截止时间戳

    @property
    def is_direct(self) -> bool:
        return self.proxy_url is None

    @property
    def is_frozen(self) -> bool:
        """403后是否处于冻结期(硬性等待1分钟)"""
        return time.time() < self._frozen_until

    @property
    def frozen_remaining(self) -> float:
        """冻结剩余秒数"""
        return max(0, self._frozen_until - time.time())

    def freeze_for_403(self, duration: float = 60.0):
        """收到403后冻结该出口, 不允许发任何请求"""
        self._frozen_until = time.time() + duration
        logger.warning(f"[Dispatcher] {self.name} 收到403, 冻结{duration}秒")

    def count_recent_logins(self, window: float = 60.0) -> int:
        """统计最近 window 秒内的登录次数(含飞行中的)"""
        now = time.time()
        cutoff = now - window
        self._login_timestamps = [t for t in self._login_timestamps if t > cutoff]
        return len(self._login_timestamps) + self._inflight_logins

    def get_login_cooldown_detail(self, max_per_min: int, window: float = 60.0) -> dict:
        """获取登录冷却详情，用于前端进度条"""
        now = time.time()
        cutoff = now - window
        self._login_timestamps = [t for t in self._login_timestamps if t > cutoff]
        used = len(self._login_timestamps) + self._inflight_logins
        # 最早那条记录还有多久过期
        if self._login_timestamps and used >= max_per_min:
            oldest = min(self._login_timestamps)
            next_available_in = max(0, oldest + window - now)
        else:
            next_available_in = 0
        return {
            "used": used,
            "max": max_per_min,
            "remaining": max(0, max_per_min - used),
            "next_available_in": round(next_available_in, 1),
        }

    def reserve_login(self):
        """[Phase 1] 预留登录名额(请求发出前), 防并发超发"""
        self._inflight_logins += 1
        self.login_count += 1

    def confirm_login(self):
        """[Phase 2] 响应收到后记录时间戳, 窗口比服务器慢 -> 永不超发"""
        self._inflight_logins = max(0, self._inflight_logins - 1)
        self._login_timestamps.append(time.time())

    def cancel_login(self):
        """[异常] 请求失败时释放预留名额"""
        self._inflight_logins = max(0, self._inflight_logins - 1)

    def record_request(self):
        self.total += 1
        self._req_timestamps.append(time.time())

    def get_current_rpm(self, window: float = 60.0) -> int:
        """获取最近1分钟的请求速率"""
        now = time.time()
        cutoff = now - window
        self._req_timestamps = [t for t in self._req_timestamps if t > cutoff]
        return len(self._req_timestamps)

    def auto_throttle_on_403(self):
        """收到403时自动限速:
        - 不限速时: 取当前RPM的90%作为限速值
        - 已限速时: 在当前限速值基础上再降10%
        """
        old_limit = self.rate_limit
        if self.rate_limit == 0:
            # 不限速 → 以当前峰值速率的90%为限速
            current_rpm = self.get_current_rpm()
            if current_rpm > 5:
                new_limit = max(5, int(current_rpm * 0.9))
                self.rate_limit = new_limit
                logger.info(f"[RateLimit] {self.name} 收到403, 自动限速: 无限 -> {new_limit}/min (当前RPM={current_rpm})")
        else:
            # 已限速 → 在现有限速基础上再降10%
            new_limit = max(5, int(self.rate_limit * 0.9))
            if new_limit < self.rate_limit:
                self.rate_limit = new_limit
                logger.info(f"[RateLimit] {self.name} 再次403, 限速下调: {old_limit} -> {new_limit}/min")

    async def wait_for_rate(self) -> float:
        """如果设置了限速且超过阈值, 等待直到可以发送. 返回等待秒数."""
        if self.rate_limit <= 0:
            return 0.0
        waited = 0.0
        async with self._rate_lock:
            while True:
                now = time.time()
                cutoff = now - 60.0
                self._req_timestamps = [t for t in self._req_timestamps if t > cutoff]
                if len(self._req_timestamps) < self.rate_limit:
                    return waited
                # 等最早那条过期
                oldest = min(self._req_timestamps)
                wait_time = oldest + 60.0 - now + 0.05
                if wait_time > 0:
                    waited += wait_time
                    await asyncio.sleep(wait_time)
                else:
                    return waited

    def record_error(self, msg: str = ""):
        self.errors += 1
        import datetime
        self._error_logs.append({
            "time": datetime.datetime.now().strftime("%H:%M:%S"),
            "msg": msg or "unknown error"
        })
        if len(self._error_logs) > 50:
            self._error_logs = self._error_logs[-50:]


class OutboundDispatcher:
    """出口IP调度器（异常安全，保证服务不中断）"""

    MAX_LOGIN_PER_MIN = 10
    HEALTH_CHECK_INTERVAL = 15
    HEALTH_CHECK_TIMEOUT = 6
    HEALTH_CHECK_URL = "http://ip.3322.net"

    def __init__(self):
        self.exits: list[OutboundExit] = [
            OutboundExit("direct", None),
        ]
        self._health_task: Optional[asyncio.Task] = None
        self._started = False

    # ===== 配置 =====

    def add_socks5(self, name: str, port: int) -> int:
        """添加一个 sing-box SOCKS5 出口，返回索引"""
        proxy_url = f"socks5://127.0.0.1:{port}"
        self.exits.append(OutboundExit(name, proxy_url))
        idx = len(self.exits) - 1
        logger.info(f"[Dispatcher] 添加出口 #{idx}: {name} -> :{port}")
        return idx

    def remove_exit(self, index: int) -> bool:
        """移除指定索引的出口（不允许移除直连#0）"""
        if index <= 0 or index >= len(self.exits):
            return False
        ex = self.exits[index]
        logger.info(f"[Dispatcher] 移除出口 #{index}: {ex.name}")
        self.exits.pop(index)
        return True

    def configure_from_list(self, socks_list: list[dict]):
        """批量配置: [{"name": "香港_01", "port": 10001}, ...]"""
        for item in socks_list:
            self.add_socks5(item["name"], item["port"])
        logger.info(f"[Dispatcher] 共 {len(self.exits)} 个出口 (1直连 + {len(self.exits)-1}隧道)")

    # ===== 启停 =====

    async def start(self):
        """启动健康检查后台任务"""
        if self._started:
            return
        self._started = True
        if len(self.exits) > 1:
            self._health_task = asyncio.create_task(self._health_check_loop())
            logger.info("[Dispatcher] 健康检查已启动")
        # 启动后立即检测所有出口IP
        asyncio.create_task(self._initial_ip_detect())
        logger.info(f"[Dispatcher] 调度器就绪: {len(self.exits)} 个出口")

    async def _initial_ip_detect(self):
        """启动后延迟2秒执行一次全量IP检测"""
        await asyncio.sleep(2)
        try:
            await self.detect_all_ips()
        except Exception as e:
            logger.warning(f"[Dispatcher] 初始IP检测异常: {e}")

    async def stop(self):
        """停止健康检查"""
        self._started = False
        if self._health_task:
            self._health_task.cancel()
            try:
                await self._health_task
            except asyncio.CancelledError:
                pass

    # ===== 内部工具 =====

    def _safe_direct(self) -> OutboundExit:
        """安全返回直连出口（永远不会失败）"""
        return self.exits[0]

    def _get_healthy(self) -> list[int]:
        """获取所有健康且未冻结的出口索引"""
        return [i for i, ex in enumerate(self.exits) if ex.healthy and not ex.is_frozen]

    # ===== 调度（全部异常安全） =====

    def pick_login_exit(self) -> OutboundExit:
        """
        为Login请求选择出口:
        1. 在健康出口中，找最近1分钟登录次数 < 上限的
        2. 多个候选时，选当前活跃连接数最少的（均衡用户数）
        3. 全满了选登录最少的
        4. 任何异常降级直连
        """
        try:
            healthy = self._get_healthy()
            if not healthy:
                logger.warning("[Dispatcher] 所有出口不健康，降级直连")
                return self._safe_direct()

            # 找未满的出口
            candidates = []
            for idx in healthy:
                ex = self.exits[idx]
                if ex.count_recent_logins() < self.MAX_LOGIN_PER_MIN:
                    candidates.append(idx)

            if candidates:
                # 优先选不限速的出口，再按活跃连接数排序
                unrestricted = [i for i in candidates if self.exits[i].rate_limit == 0]
                pool = unrestricted if unrestricted else candidates
                best = min(pool, key=lambda i: self.exits[i].active)
                ex = self.exits[best]
                ex.reserve_login()
                ex.record_request()
                return ex

            # 全满了，选登录最少的
            best = min(healthy, key=lambda i: self.exits[i].count_recent_logins())
            ex = self.exits[best]
            ex.reserve_login()
            ex.record_request()
            logger.warning(f"[Dispatcher] 所有出口Login配额已满，使用最少的: {ex.name}")
            return ex
        except Exception as e:
            logger.error(f"[Dispatcher] Login调度异常，降级直连: {e}")
            return self._safe_direct()

    def pick_api_exit(self) -> OutboundExit:
        """
        为普通API请求选择出口:
        使用 least-connections（最少活跃连接）策略，保证每个IP同时使用人数均匀
        任何异常降级直连
        """
        try:
            healthy = self._get_healthy()
            if not healthy:
                logger.warning("[Dispatcher] 所有出口不健康，降级直连")
                return self._safe_direct()

            # 优先选不限速的出口，再按活跃连接数排序
            unrestricted = [i for i in healthy if self.exits[i].rate_limit == 0]
            pool = unrestricted if unrestricted else healthy
            best = min(pool, key=lambda i: self.exits[i].active)
            ex = self.exits[best]
            ex.record_request()
            return ex
        except Exception as e:
            logger.error(f"[Dispatcher] API调度异常，降级直连: {e}")
            return self._safe_direct()

    # ===== 请求转发（异常安全 + 状态码告警） =====

    async def forward(self, exit_obj: OutboundExit, method: str, url: str,
                      headers: dict, content_type: str = "",
                      params: dict = None, raw_body: bytes = None,
                      timeout: float = 30) -> httpx.Response:
        """
        通过指定出口转发HTTP请求。
        - 自动跟踪活跃连接数（进入+1，完成-1）
        - 检测403/429等状态码并记录告警日志
        - 隧道出口失败时自动降级直连重试
        """
        # 限速等待
        wait_sec = await exit_obj.wait_for_rate()
        if wait_sec > 0.5:
            logger.debug(f"[RateLimit] {exit_obj.name} 等待 {wait_sec:.1f}s")

        exit_obj.active += 1
        try:
            resp = await self._do_request(exit_obj, method, url, headers,
                                          content_type, params, raw_body, timeout)
            # 检查告警状态码
            self._check_alert_status(exit_obj, resp.status_code, url)
            return resp

        except Exception as e:
            exit_obj.record_error()

            # 如果是隧道出口失败，降级直连重试
            if not exit_obj.is_direct:
                logger.warning(f"[Dispatcher] {exit_obj.name} 失败({e})，降级直连重试")
                direct = self._safe_direct()
                direct.active += 1
                try:
                    resp = await self._do_request(direct, method, url, headers,
                                                  content_type, params, raw_body, timeout)
                    self._check_alert_status(direct, resp.status_code, url)
                    return resp
                except Exception as e2:
                    direct.record_error()
                    logger.error(f"[Dispatcher] 直连也失败: {e2}")
                    raise
                finally:
                    direct.active -= 1
            else:
                logger.error(f"[Dispatcher] 直连请求失败: {e}")
                raise
        finally:
            exit_obj.active -= 1

    async def _do_request(self, exit_obj: OutboundExit, method: str, url: str,
                          headers: dict, content_type: str,
                          params: dict, raw_body: bytes,
                          timeout: float) -> httpx.Response:
        """执行实际HTTP请求"""
        proxy = exit_obj.proxy_url
        async with httpx.AsyncClient(
            verify=False, timeout=timeout, proxy=proxy
        ) as client:
            if method == "GET":
                return await client.get(url, params=params, headers=headers)
            else:
                if "application/json" in (content_type or ""):
                    return await client.post(url, json=params, headers=headers)
                elif raw_body:
                    return await client.post(url, content=raw_body, headers=headers)
                else:
                    return await client.post(url, data=params, headers=headers)

    def _check_alert_status(self, exit_obj: OutboundExit, status_code: int, url: str):
        """检查响应状态码，403/429等记录告警日志"""
        if status_code in ALERT_STATUS_CODES:
            desc = ALERT_STATUS_CODES[status_code]
            # 更新统计
            if status_code == 403:
                exit_obj.warn_403 += 1
                exit_obj.freeze_for_403(60.0)
                exit_obj.auto_throttle_on_403()
            elif status_code == 429:
                exit_obj.warn_429 += 1
                exit_obj.auto_throttle_on_403()  # 429也触发限速
            # 提取API路径用于日志
            api_path = url.split("/RPC/")[-1] if "/RPC/" in url else url[-50:]
            logger.warning(
                f"[Dispatcher] ⚠️ {status_code} {desc} | "
                f"出口={exit_obj.name} | API={api_path} | "
                f"该出口累计: 403×{exit_obj.warn_403} 429×{exit_obj.warn_429}"
            )

    # ===== 健康检查 =====

    async def _health_check_loop(self):
        """后台定期检查所有隧道出口"""
        # 首次立即检查
        await asyncio.sleep(3)
        try:
            await self._check_all_exits()
        except Exception:
            pass
        while self._started:
            try:
                await asyncio.sleep(self.HEALTH_CHECK_INTERVAL)
                await self._check_all_exits()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"[Dispatcher] 健康检查异常: {e}")

    async def _check_all_exits(self):
        """并发检查所有非直连出口"""
        tasks = []
        for i, ex in enumerate(self.exits):
            if i == 0:
                continue
            tasks.append(self._check_single_exit(i, ex))
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _check_single_exit(self, idx: int, ex: OutboundExit):
        """检查单个出口是否可用，同时检测出口IP"""
        was_healthy = ex.healthy
        try:
            async with httpx.AsyncClient(
                verify=False, timeout=self.HEALTH_CHECK_TIMEOUT,
                proxy=ex.proxy_url
            ) as client:
                resp = await client.head(self.HEALTH_CHECK_URL)
                ex.healthy = True
                if not was_healthy:
                    logger.info(f"[Dispatcher] 出口恢复: #{idx} {ex.name}")
                # 检测出口IP（仅在IP未知或刚恢复时）
                if not ex.exit_ip or not was_healthy:
                    await self._detect_exit_ip(ex)
        except Exception:
            ex.healthy = False
            if was_healthy:
                logger.warning(f"[Dispatcher] 出口离线: #{idx} {ex.name}")

    async def _detect_exit_ip(self, ex: OutboundExit):
        """通过外部服务检测出口的公网IP"""
        IP_SERVICES = [
            "http://ip.3322.net",
            "http://members.3322.org/dyndns/getip",
            "https://api.ip.sb/ip",
            "http://httpbin.org/ip",
            "https://ifconfig.me/ip",
            "https://icanhazip.com",
        ]
        for svc in IP_SERVICES:
            try:
                async with httpx.AsyncClient(
                    verify=False, timeout=8,
                    proxy=ex.proxy_url  # None for direct = no proxy
                ) as client:
                    resp = await client.get(svc)
                    if resp.status_code == 200:
                        text = resp.text.strip()
                        # httpbin 返回 JSON {"origin": "x.x.x.x"}
                        if text.startswith("{"):
                            import json as _json
                            text = _json.loads(text).get("origin", "").split(",")[0].strip()
                        ip = text.strip()
                        if ip and ip != ex.exit_ip:
                            logger.info(f"[Dispatcher] 出口IP检测: {ex.name} -> {ip}")
                            ex.exit_ip = ip
                        return  # 成功就退出
            except Exception:
                continue  # 换下一个服务

    async def detect_all_ips(self):
        """手动触发所有出口的IP检测"""
        tasks = [self._detect_exit_ip(ex) for ex in self.exits]
        await asyncio.gather(*tasks, return_exceptions=True)

    # ===== 状态查询 =====

    def get_status(self) -> dict:
        """获取调度器完整状态（异常安全）"""
        try:
            exits_info = []
            for i, ex in enumerate(self.exits):
                exits_info.append({
                    "index": i,
                    "name": ex.name,
                    "type": "direct" if ex.is_direct else "socks5",
                    "proxy": ex.proxy_url,
                    "healthy": ex.healthy,
                    "exit_ip": ex.exit_ip,
                    "active": ex.active,
                    "total_requests": ex.total,
                    "login_requests": ex.login_count,
                    "login_cooldown": ex.get_login_cooldown_detail(self.MAX_LOGIN_PER_MIN),
                    "errors": ex.errors,
                    "warn_403": ex.warn_403,
                    "warn_429": ex.warn_429,
                    "frozen": ex.is_frozen,
                    "frozen_remaining": round(ex.frozen_remaining, 1),
                    "recent_errors": ex._error_logs[-5:] if ex._error_logs else [],
                    "rpm": ex.get_current_rpm(),
                    "rate_limit": ex.rate_limit,
                })

            healthy_count = sum(1 for ex in self.exits if ex.healthy)
            total_active = sum(ex.active for ex in self.exits)
            return {
                "total_exits": len(self.exits),
                "healthy_exits": healthy_count,
                "total_active": total_active,
                "max_login_per_min": self.MAX_LOGIN_PER_MIN,
                "exits": exits_info,
            }
        except Exception as e:
            return {"error": str(e), "total_exits": len(self.exits)}

    def set_max_login_per_min(self, value: int) -> bool:
        """动态调整每出口每分钟最大登录数"""
        if value < 1:
            return False
        old = self.MAX_LOGIN_PER_MIN
        self.MAX_LOGIN_PER_MIN = value
        logger.info(f"[Dispatcher] 登录限流调整: {old} -> {value}/min")
        return True

    def set_rate_limit(self, index: int, limit: int) -> bool:
        """设置指定出口的速率限制(req/min), 0=不限速"""
        if 0 <= index < len(self.exits):
            old = self.exits[index].rate_limit
            self.exits[index].rate_limit = max(0, limit)
            logger.info(f"[RateLimit] {self.exits[index].name} 限速调整: {old or '无限'} -> {limit or '无限'}/min")
            return True
        return False

    def get_exit_logs(self, index: int) -> list[dict]:
        """获取指定出口的错误日志"""
        if 0 <= index < len(self.exits):
            return list(self.exits[index]._error_logs)
        return []

    def summary(self) -> str:
        """一行摘要（异常安全）"""
        try:
            healthy = sum(1 for ex in self.exits if ex.healthy)
            active = sum(ex.active for ex in self.exits)
            return f"{healthy}/{len(self.exits)} healthy, {active} active"
        except Exception:
            return f"{len(self.exits)} exits (status unknown)"


# 全局单例
dispatcher = OutboundDispatcher()
