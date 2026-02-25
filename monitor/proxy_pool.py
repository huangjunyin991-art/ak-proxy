# -*- coding: utf-8 -*-
"""
代理池模块 - 为监控服务器提供多IP轮换代理能力
通过 sing-box SOCKS5 代理池轮换出口IP，避免上游API因同IP高频访问而封锁

架构: server.py → proxy_pool → sing-box池(SOCKS5) → 目标API
"""

import asyncio
import json
import logging
import os
import socket
import subprocess
import sys
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from typing import Optional, List

import httpx

logger = logging.getLogger("ProxyPool")


# ============================================================
#  配置管理
# ============================================================
class ProxyPoolConfig:
    """代理池配置（持久化到JSON）"""

    DEFAULT = {
        "enabled": False,
        "singbox_path": "",
        "vpn_config_path": "",
        "subscription_url": "",
        "prefer_direct": False,
        "direct_cooldown": 60,
        "direct_rate_limit": 4,
        "num_slots": 5,
        "base_port": 21000,
        "rate_limit": 8,
        "window": 60,
    }

    def __init__(self, config_file: str):
        self.config_file = config_file
        self.data = dict(self.DEFAULT)
        self.load()

    def load(self):
        try:
            if os.path.exists(self.config_file):
                with open(self.config_file, 'r', encoding='utf-8') as f:
                    saved = json.load(f)
                self.data.update(saved)
        except Exception as e:
            logger.error(f"加载配置失败: {e}")

    def save(self):
        try:
            with open(self.config_file, 'w', encoding='utf-8') as f:
                json.dump(self.data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            logger.error(f"保存配置失败: {e}")

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value
        self.save()

    def update(self, updates: dict):
        self.data.update(updates)
        self.save()

    def to_dict(self):
        return dict(self.data)


# ============================================================
#  ProxySlot - 单个 sing-box SOCKS5 代理实例
# ============================================================
class ProxySlot:
    """管理一个 sing-box 进程，提供 SOCKS5 代理"""

    def __init__(self, slot_id: int, base_dir: str, singbox_path: str, socks_port: int):
        self.slot_id = slot_id
        self.base_dir = base_dir
        self.singbox_path = singbox_path
        self.socks_port = socks_port
        self.process = None
        self.node = None
        self.node_name = ""

        self.request_times = deque()
        self.total_requests = 0
        self.success_count = 0
        self.fail_count = 0

        self.blocked_until = 0
        self.blocked_count = 0
        self.consecutive_fails = 0
        self.last_error = ""

        self.config_path = os.path.join(base_dir, f"pp_slot_{slot_id}.json")

    @property
    def alive(self):
        try:
            return self.process is not None and self.process.poll() is None
        except Exception:
            return False

    @property
    def status(self):
        if not self.alive:
            return "dead"
        if time.time() < self.blocked_until:
            return "blocked"
        return "available"

    @property
    def usable(self):
        return self.alive and time.time() >= self.blocked_until

    @property
    def proxy_url(self):
        return f"socks5://127.0.0.1:{self.socks_port}"

    def mark_blocked(self, duration=30):
        self.blocked_until = time.time() + duration
        self.blocked_count += 1

    def requests_in_window(self, window_seconds=60):
        now = time.time()
        while self.request_times and self.request_times[0] < now - window_seconds:
            self.request_times.popleft()
        return len(self.request_times)

    def record_request(self):
        self.request_times.append(time.time())
        self.total_requests += 1

    def record_result(self, success, error=""):
        if success:
            self.success_count += 1
            self.consecutive_fails = 0
        else:
            self.fail_count += 1
            self.consecutive_fails += 1
            self.last_error = error[:120] if error else ""

    @property
    def success_rate(self):
        total = self.success_count + self.fail_count
        return self.success_count / total if total > 0 else 1.0

    def start(self, node) -> bool:
        """启动 sing-box 连接到指定节点"""
        self.stop()
        self.node = node
        self.node_name = node.get("name", f"node_{self.slot_id}")

        config = self._build_config(node)
        with open(self.config_path, 'w', encoding='utf-8') as f:
            json.dump(config, f, ensure_ascii=False, indent=2)

        if not self._is_port_free():
            logger.error(f"Slot {self.slot_id} 端口 {self.socks_port} 被占用")
            return False

        try:
            startupinfo = None
            if os.name == 'nt':
                startupinfo = subprocess.STARTUPINFO()
                startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                startupinfo.wShowWindow = subprocess.SW_HIDE

            self.process = subprocess.Popen(
                [self.singbox_path, "run", "-c", self.config_path],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                startupinfo=startupinfo, cwd=self.base_dir
            )
            time.sleep(2)

            if self.process.poll() is not None:
                try:
                    stderr = self.process.stderr.read().decode('utf-8', errors='ignore')[:300]
                except Exception:
                    stderr = ""
                logger.error(f"Slot {self.slot_id} sing-box退出 [{self.node_name}]: {stderr}")
                self.process = None
                return False

            logger.info(f"Slot {self.slot_id} 启动成功 -> {self.node_name} (SOCKS5 :{self.socks_port})")
            return True
        except FileNotFoundError:
            logger.error(f"sing-box 未找到: {self.singbox_path}")
            self.process = None
            return False
        except Exception as e:
            logger.error(f"Slot {self.slot_id} 启动异常: {e}")
            self.process = None
            return False

    def stop(self):
        """停止 sing-box 进程"""
        if self.process:
            pid = self.process.pid
            for pipe in (self.process.stdout, self.process.stderr):
                if pipe:
                    try:
                        pipe.close()
                    except Exception:
                        pass
            try:
                self.process.terminate()
                self.process.wait(timeout=2)
            except Exception:
                try:
                    self.process.kill()
                    self.process.wait(timeout=2)
                except Exception:
                    pass
            if os.name == 'nt' and pid:
                try:
                    subprocess.run(
                        ["taskkill", "/F", "/PID", str(pid)],
                        capture_output=True, creationflags=0x08000000, timeout=3)
                except Exception:
                    pass
            self.process = None
            self._wait_port_free(timeout=3)
        try:
            if os.path.exists(self.config_path):
                os.remove(self.config_path)
        except Exception:
            pass

    def _is_port_free(self) -> bool:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(0.5)
                result = s.connect_ex(('127.0.0.1', self.socks_port))
                return result != 0
        except Exception:
            return True

    def _wait_port_free(self, timeout=3):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._is_port_free():
                return True
            time.sleep(0.3)
        return False

    # ---- sing-box 配置构建 ----

    def _build_config(self, node):
        outbound = self._build_outbound(node)
        return {
            "log": {"level": "warn"},
            "inbounds": [{
                "type": "socks",
                "tag": f"socks-in-{self.slot_id}",
                "listen": "127.0.0.1",
                "listen_port": self.socks_port,
            }],
            "outbounds": [outbound],
        }

    def _build_outbound(self, node):
        protocol = node.get("protocol", "")
        builders = {
            "vless": self._vless_outbound,
            "vmess": self._vmess_outbound,
            "trojan": self._trojan_outbound,
            "ss": self._ss_outbound,
            "hysteria2": self._hysteria2_outbound,
            "hysteria": self._hysteria_outbound,
            "tuic": self._tuic_outbound,
        }
        builder = builders.get(protocol)
        if builder:
            return builder(node)
        return {"type": "direct", "tag": "proxy"}

    def _tls_settings(self, node):
        extra = node.get("extra", {})
        if not node.get("tls", False):
            return None
        sni = extra.get("sni", node.get("host", ""))
        tls = {"enabled": True, "server_name": sni}
        security = extra.get("security", "tls")
        fp = extra.get("fp", "")
        if fp:
            tls["utls"] = {"enabled": True, "fingerprint": fp}
        elif security == "reality":
            tls["utls"] = {"enabled": True, "fingerprint": "chrome"}
        if security == "reality":
            tls["reality"] = {
                "enabled": True,
                "public_key": extra.get("pbk", ""),
                "short_id": extra.get("sid", ""),
            }
        return tls

    def _transport_settings(self, node):
        extra = node.get("extra", {})
        net = node.get("network", "tcp")
        if net == "ws":
            transport = {"type": "ws", "path": extra.get("path", "/")}
            host = extra.get("host", "")
            if host:
                transport["headers"] = {"Host": host}
            return transport
        elif net == "grpc":
            return {"type": "grpc", "service_name": extra.get("path", "")}
        elif net in ("h2", "http"):
            transport = {"type": "http"}
            path = extra.get("path", "")
            if path:
                transport["path"] = path
            host = extra.get("host", "")
            if host:
                transport["host"] = [host]
            return transport
        return None

    def _vless_outbound(self, node):
        extra = node.get("extra", {})
        out = {
            "type": "vless", "tag": "proxy",
            "server": node["host"], "server_port": node["port"],
            "uuid": node["uuid"],
        }
        flow = extra.get("flow", "")
        if flow:
            out["flow"] = flow
        tls = self._tls_settings(node)
        if tls:
            out["tls"] = tls
        transport = self._transport_settings(node)
        if transport:
            out["transport"] = transport
        return out

    def _vmess_outbound(self, node):
        out = {
            "type": "vmess", "tag": "proxy",
            "server": node["host"], "server_port": node["port"],
            "uuid": node["uuid"],
            "alter_id": node.get("alter_id", 0),
            "security": "auto",
        }
        tls = self._tls_settings(node)
        if tls:
            out["tls"] = tls
        transport = self._transport_settings(node)
        if transport:
            out["transport"] = transport
        return out

    def _trojan_outbound(self, node):
        out = {
            "type": "trojan", "tag": "proxy",
            "server": node["host"], "server_port": node["port"],
            "password": node["password"],
        }
        tls = self._tls_settings(node)
        if tls:
            out["tls"] = tls
        else:
            out["tls"] = {"enabled": True, "server_name": node["host"]}
        transport = self._transport_settings(node)
        if transport:
            out["transport"] = transport
        return out

    def _ss_outbound(self, node):
        return {
            "type": "shadowsocks", "tag": "proxy",
            "server": node["host"], "server_port": node["port"],
            "method": node.get("method", ""),
            "password": node.get("password", ""),
        }

    def _hysteria2_outbound(self, node):
        extra = node.get("extra", {})
        out = {
            "type": "hysteria2", "tag": "proxy",
            "server": node["host"], "server_port": node["port"],
            "password": node.get("password", node.get("uuid", "")),
            "tls": {
                "enabled": True,
                "server_name": extra.get("sni", node["host"]),
                "insecure": extra.get("insecure", True),
            },
        }
        obfs_type = extra.get("obfs", "")
        if obfs_type:
            out["obfs"] = {"type": obfs_type, "password": extra.get("obfs-password", "")}
        return out

    def _hysteria_outbound(self, node):
        extra = node.get("extra", {})
        return {
            "type": "hysteria", "tag": "proxy",
            "server": node["host"], "server_port": node["port"],
            "auth_str": node.get("password", ""),
            "tls": {
                "enabled": True,
                "server_name": extra.get("sni", node["host"]),
                "insecure": True,
            },
        }

    def _tuic_outbound(self, node):
        extra = node.get("extra", {})
        return {
            "type": "tuic", "tag": "proxy",
            "server": node["host"], "server_port": node["port"],
            "uuid": node.get("uuid", ""),
            "password": node.get("password", ""),
            "tls": {
                "enabled": True,
                "server_name": extra.get("sni", node["host"]),
                "insecure": True,
            },
        }


# ============================================================
#  ProxyPool - 异步代理池管理（含节点分级 + 热备池 + 预测试）
# ============================================================
PROBE_URLS = [
    "http://connectivitycheck.gstatic.com/generate_204",
    "http://www.msftconnecttest.com/connecttest.txt",
    "http://cp.cloudflare.com/",
]


class ProxyPool:
    """管理多个 ProxySlot，异步轮换节点
    
    节点分级:
      T1 = 已验证可用（有连通性测试缓存）
      T2 = 未测试
      T3 = 测试失败
    
    热备池: 后台预测试节点，维护 N 个已验证可用的备选节点
    """

    def __init__(self, nodes: list, singbox_path: str, base_dir: str,
                 num_slots: int = 5, base_port: int = 21000,
                 rate_limit: int = 8, window: int = 60):
        self.all_nodes = nodes
        self.singbox_path = singbox_path
        self.base_dir = base_dir
        self.num_slots = min(num_slots, len(nodes)) if nodes else 0
        self.base_port = base_port
        self.rate_limit = rate_limit
        self.window = window

        self.slots: List[ProxySlot] = []
        self.node_index = 0
        self.slot_index = 0
        self.lock = None

        self.total_requests = 0
        self.total_success = 0
        self.total_fail = 0

        self._running = False
        self._monitor_task = None
        self._pretest_task = None
        self._initial_rate_limit = rate_limit

        # 节点健康跟踪: key="host:port", value={verified, last_test, latency, fail_count}
        self._node_scores = {}
        self._pretest_interval = 300  # 测试结果缓存 5 分钟

        # 热备池: 已验证可用节点队列
        self._ready_nodes: deque = deque()
        self._ready_target = num_slots
        self._ready_event = None

        # 测试槽位配置
        self._test_port_base = base_port + num_slots
        self._num_test_slots = num_slots

    def start(self):
        """启动代理池（同步，适合在线程池中执行）"""
        if not self.all_nodes:
            logger.error("没有可用节点")
            return
        if not self.singbox_path or not os.path.isfile(self.singbox_path):
            logger.error(f"sing-box 未找到: {self.singbox_path}")
            return

        logger.info(f"启动代理池: {self.num_slots} 槽位, 速率 {self.rate_limit}/{self.window}s")
        self._cleanup_singbox()

        for i in range(self.num_slots):
            slot = ProxySlot(i, self.base_dir, self.singbox_path, self.base_port + i)
            self.slots.append(slot)

        def _start_slot(slot):
            for attempt in range(3):
                node = self._next_node(prefer_verified=False)
                if node and slot.start(node):
                    return True
            return False

        with ThreadPoolExecutor(max_workers=min(self.num_slots, 8)) as executor:
            futures = {executor.submit(_start_slot, slot): slot for slot in self.slots}
            for future in futures:
                try:
                    future.result(timeout=30)
                except Exception as e:
                    logger.error(f"Slot {futures[future].slot_id} 启动异常: {e}")

        self._running = True
        alive = sum(1 for s in self.slots if s.alive)
        logger.info(f"代理池启动完成: {alive}/{self.num_slots} 在线")

    async def start_monitor(self):
        """启动异步监控任务（含预测试热备池）"""
        self.lock = asyncio.Lock()
        self._ready_event = asyncio.Event()
        self._monitor_task = asyncio.create_task(self._monitor_loop())
        self._pretest_task = asyncio.create_task(self._pretest_loop())

    async def stop(self):
        """停止代理池"""
        self._running = False
        for task in [self._monitor_task, self._pretest_task]:
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        for slot in self.slots:
            slot.stop()
        self._cleanup_singbox()
        self.slots.clear()
        logger.info("代理池已停止")

    def _cleanup_singbox(self):
        """清理残留 sing-box 进程"""
        try:
            if os.name == 'nt':
                subprocess.run(
                    ["taskkill", "/F", "/IM", "sing-box.exe"],
                    capture_output=True, text=True, creationflags=0x08000000, timeout=5)
            else:
                subprocess.run(["pkill", "-f", "sing-box"], capture_output=True, timeout=5)
            time.sleep(0.5)
        except Exception:
            pass

    def _node_key(self, node) -> str:
        """节点唯一标识"""
        return f"{node.get('host', '')}:{node.get('port', 0)}"

    def _get_node_tier(self, node) -> int:
        """节点分级: 1=已验证可用, 2=未测试, 3=测试失败"""
        key = self._node_key(node)
        score = self._node_scores.get(key)
        if not score:
            return 2
        if time.time() - score['last_test'] > self._pretest_interval:
            return 2
        return 1 if score['verified'] else 3

    def _next_node(self, prefer_verified=True):
        """获取下一个节点，优先从热备池取已验证节点"""
        if not self.all_nodes:
            return None

        in_use = set()
        for slot in self.slots:
            if slot.alive and slot.node:
                in_use.add(self._node_key(slot.node))

        # 1. 优先从热备池取（已验证可用的节点）
        if self._ready_nodes:
            for _ in range(len(self._ready_nodes)):
                node = self._ready_nodes.popleft()
                key = self._node_key(node)
                if key not in in_use:
                    logger.info(f"热备池取出节点: {node.get('name', key)} (剩余 {len(self._ready_nodes)})")
                    if self._ready_event:
                        self._ready_event.set()
                    return node
                self._ready_nodes.append(node)

        # 2. 热备池为空，回退到分级选择
        if not prefer_verified or not self._node_scores:
            node = self.all_nodes[self.node_index % len(self.all_nodes)]
            self.node_index += 1
            if self._ready_event:
                self._ready_event.set()
            return node

        tier1, tier2, tier3 = [], [], []
        for node in self.all_nodes:
            key = self._node_key(node)
            if key in in_use:
                continue
            tier = self._get_node_tier(node)
            if tier == 1:
                tier1.append(node)
            elif tier == 2:
                tier2.append(node)
            else:
                tier3.append(node)

        candidates = tier1 or tier2 or tier3
        if not candidates:
            node = self.all_nodes[self.node_index % len(self.all_nodes)]
            self.node_index += 1
            if self._ready_event:
                self._ready_event.set()
            return node

        if tier1:
            tier1.sort(key=lambda n: self._node_scores.get(self._node_key(n), {}).get('latency', 9999))

        if self._ready_event:
            self._ready_event.set()
        return candidates[0]

    async def get_proxy(self, exclude=None) -> Optional[ProxySlot]:
        """获取下一个可用代理槽位"""
        exclude = exclude or set()
        async with self.lock:
            for _ in range(self.num_slots):
                slot = self.slots[self.slot_index % self.num_slots]
                self.slot_index += 1
                if not slot.usable or slot.slot_id in exclude:
                    continue
                if slot.requests_in_window(self.window) < self.rate_limit:
                    slot.record_request()
                    return slot

            alive_slots = [s for s in self.slots if s.usable and s.slot_id not in exclude]
            if alive_slots:
                best = min(alive_slots, key=lambda s: s.requests_in_window(self.window))
                best.record_request()
                logger.warning(f"槽位接近上限，使用 Slot {best.slot_id}")
                return best

            for slot in self.slots:
                if not slot.alive and slot.slot_id not in exclude:
                    node = self._next_node()
                    if node:
                        loop = asyncio.get_running_loop()
                        ok = await loop.run_in_executor(None, slot.start, node)
                        if ok:
                            slot.record_request()
                            return slot
            return None

    async def rotate_slot(self, slot, reason="blocked"):
        """强制轮换槽位到新节点"""
        old_node = slot.node
        if reason == "blocked" and old_node:
            slot.mark_blocked(30)
            key = self._node_key(old_node)
            self._node_scores[key] = {
                'verified': False, 'last_test': time.time(),
                'latency': 9999,
                'fail_count': self._node_scores.get(key, {}).get('fail_count', 0) + 1,
            }
        old_tier = self._get_node_tier(old_node) if old_node else 2
        logger.info(f"Slot {slot.slot_id} {reason}，轮换节点 [T{old_tier}] (403累计: {slot.blocked_count})")
        node = self._next_node()
        if node:
            new_tier = self._get_node_tier(node)
            logger.info(f"Slot {slot.slot_id} 切换到 [T{new_tier}] {node.get('name', '?')}")
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, slot.start, node)
            slot.blocked_until = 0

    # ---- 健康探测 ----

    async def _probe_slot(self, slot: ProxySlot) -> bool:
        """探测槽位 SOCKS5 连接是否真正可用"""
        try:
            async with httpx.AsyncClient(
                proxy=slot.proxy_url, verify=False, timeout=8
            ) as client:
                t0 = time.time()
                resp = await client.get(PROBE_URLS[0])
                latency = (time.time() - t0) * 1000
                ok = resp.status_code in (200, 204, 301, 302)
                if slot.node:
                    key = self._node_key(slot.node)
                    self._node_scores[key] = {
                        'verified': ok, 'last_test': time.time(),
                        'latency': latency if ok else 9999,
                        'fail_count': 0 if ok else self._node_scores.get(key, {}).get('fail_count', 0) + 1,
                    }
                return ok
        except Exception:
            if slot.node:
                key = self._node_key(slot.node)
                self._node_scores[key] = {
                    'verified': False, 'last_test': time.time(), 'latency': 9999,
                    'fail_count': self._node_scores.get(key, {}).get('fail_count', 0) + 1,
                }
            return False

    # ---- 预测试 / 热备池 ----

    async def _pretest_loop(self):
        """后台节点预测试：维护热备池，保证始终有 N 个已验证可用节点待命"""
        await asyncio.sleep(10)
        # 为当前已启动的槽位记录初始分数
        for slot in self.slots:
            if slot.alive and slot.node:
                key = self._node_key(slot.node)
                self._node_scores[key] = {
                    'verified': True, 'last_test': time.time(), 'latency': 0, 'fail_count': 0,
                }

        test_slots = []
        for i in range(self._num_test_slots):
            ts = ProxySlot(9900 + i, self.base_dir, self.singbox_path, self._test_port_base + i)
            test_slots.append(ts)

        scan_index = 0
        while self._running:
            try:
                shortage = self._ready_target - len(self._ready_nodes)
                if shortage > 0:
                    filled = await self._fill_ready_pool(test_slots, shortage, scan_index)
                    scan_index = (scan_index + len(self.all_nodes)) % max(1, len(self.all_nodes))

                    now = time.time()
                    t1 = sum(1 for s in self._node_scores.values()
                             if s['verified'] and now - s['last_test'] < self._pretest_interval)
                    t3 = sum(1 for s in self._node_scores.values()
                             if not s['verified'] and now - s['last_test'] < self._pretest_interval)
                    t2 = len(self.all_nodes) - t1 - t3
                    logger.info(
                        f"热备池: {len(self._ready_nodes)}/{self._ready_target} 备选 (+{filled}) | "
                        f"分级: T1={t1} T2={t2} T3={t3} (共{len(self.all_nodes)})"
                    )

                self._ready_event.clear()
                try:
                    await asyncio.wait_for(self._ready_event.wait(), timeout=30)
                except asyncio.TimeoutError:
                    pass

                self._cleanup_ready_pool()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"热备池异常: {e}")
                await asyncio.sleep(10)

        for ts in test_slots:
            try:
                ts.stop()
            except Exception:
                pass

    async def _fill_ready_pool(self, test_slots: list, needed: int, start_index: int) -> int:
        """填充热备池: T1(缓存) → T2(并行实测) → T3(并行重测)"""
        occupied = set()
        for node in self._ready_nodes:
            occupied.add(self._node_key(node))
        for slot in self.slots:
            if slot.alive and slot.node:
                occupied.add(self._node_key(slot.node))

        now = time.time()
        tier1, tier2, tier3 = [], [], []
        for i in range(len(self.all_nodes)):
            idx = (start_index + i) % len(self.all_nodes)
            node = self.all_nodes[idx]
            key = self._node_key(node)
            if key in occupied:
                continue
            score = self._node_scores.get(key)
            if not score or (now - score['last_test'] > self._pretest_interval):
                tier2.append(node)
            elif score['verified']:
                tier1.append(node)
            else:
                tier3.append(node)

        tier1.sort(key=lambda n: self._node_scores.get(self._node_key(n), {}).get('latency', 9999))

        filled = 0
        # T1: 已验证缓存直接取
        for node in tier1:
            if filled >= needed:
                break
            self._ready_nodes.append(node)
            occupied.add(self._node_key(node))
            filled += 1
        if filled >= needed:
            self._sort_ready_pool()
            return filled

        # T2: 并行实测未测试节点
        still_need = needed - filled
        nodes_to_test = tier2[:min(len(tier2), still_need * 3)]
        results = await self._test_nodes_parallel(test_slots, nodes_to_test)
        for node, ok in results:
            if ok and filled < needed:
                self._ready_nodes.append(node)
                occupied.add(self._node_key(node))
                filled += 1
        if filled >= needed:
            self._sort_ready_pool()
            return filled

        # T3: 并行重测失败节点
        tier3.sort(key=lambda n: self._node_scores.get(self._node_key(n), {}).get('fail_count', 0))
        still_need = needed - filled
        nodes_to_retry = tier3[:min(len(tier3), still_need * 2)]
        results = await self._test_nodes_parallel(test_slots, nodes_to_retry)
        for node, ok in results:
            if ok and filled < needed:
                self._ready_nodes.append(node)
                occupied.add(self._node_key(node))
                filled += 1

        self._sort_ready_pool()
        return filled

    async def _test_nodes_parallel(self, test_slots: list, nodes: list) -> list:
        """使用多个测试槽位并行测试节点"""
        results = []
        num_workers = len(test_slots)
        for batch_start in range(0, len(nodes), num_workers):
            if not self._running:
                break
            batch = nodes[batch_start:batch_start + num_workers]
            tasks = []
            for i, node in enumerate(batch):
                tasks.append(self._test_single_node(test_slots[i], node))
            batch_results = await asyncio.gather(*tasks, return_exceptions=True)
            for i, result in enumerate(batch_results):
                node = batch[i]
                if isinstance(result, Exception):
                    results.append((node, False))
                else:
                    results.append((node, result))
        return results

    async def _test_single_node(self, test_slot: ProxySlot, node) -> bool:
        """测试单个节点的连通性"""
        key = self._node_key(node)
        loop = asyncio.get_running_loop()
        started = await loop.run_in_executor(None, test_slot.start, node)
        if not started:
            self._node_scores[key] = {
                'verified': False, 'last_test': time.time(), 'latency': 9999,
                'fail_count': self._node_scores.get(key, {}).get('fail_count', 0) + 1,
            }
            return False

        try:
            async with httpx.AsyncClient(
                proxy=test_slot.proxy_url, verify=False, timeout=8
            ) as client:
                t0 = time.time()
                resp = await client.get(PROBE_URLS[0])
                latency = (time.time() - t0) * 1000
                ok = resp.status_code in (200, 204, 301, 302)
                self._node_scores[key] = {
                    'verified': ok, 'last_test': time.time(),
                    'latency': latency if ok else 9999,
                    'fail_count': 0 if ok else self._node_scores.get(key, {}).get('fail_count', 0) + 1,
                }
                return ok
        except Exception:
            self._node_scores[key] = {
                'verified': False, 'last_test': time.time(), 'latency': 9999,
                'fail_count': self._node_scores.get(key, {}).get('fail_count', 0) + 1,
            }
            return False
        finally:
            await loop.run_in_executor(None, test_slot.stop)

    def _sort_ready_pool(self):
        """按延迟排序热备池"""
        sorted_nodes = sorted(
            self._ready_nodes,
            key=lambda n: self._node_scores.get(self._node_key(n), {}).get('latency', 9999)
        )
        self._ready_nodes = deque(sorted_nodes)

    def _cleanup_ready_pool(self):
        """清理热备池中测试结果已过期的节点"""
        now = time.time()
        valid = deque()
        removed = 0
        for node in self._ready_nodes:
            key = self._node_key(node)
            score = self._node_scores.get(key)
            if score and score['verified'] and (now - score['last_test'] < self._pretest_interval):
                valid.append(node)
            else:
                removed += 1
        if removed > 0:
            logger.info(f"热备池清理: 移除 {removed} 个过期节点 (剩余 {len(valid)})")
        self._ready_nodes = valid

    # ---- 监控循环 ----

    async def _monitor_loop(self):
        """后台监控：健康检查 + 死节点恢复 + 连续失败轮换"""
        while self._running:
            await asyncio.sleep(5)
            for slot in self.slots:
                try:
                    # 1. 进程已死 → 重启
                    if not slot.alive:
                        for _ in range(3):
                            node = self._next_node()
                            if node:
                                loop = asyncio.get_running_loop()
                                ok = await loop.run_in_executor(None, slot.start, node)
                                if ok:
                                    slot.consecutive_fails = 0
                                    break

                    # 2. 连续失败 >= 3 → 健康探测，失败则轮换
                    elif slot.consecutive_fails >= 3 and slot.alive:
                        healthy = await self._probe_slot(slot)
                        if not healthy:
                            logger.warning(f"Slot {slot.slot_id} 健康探测失败，轮换节点")
                            node = self._next_node()
                            if node:
                                loop = asyncio.get_running_loop()
                                await loop.run_in_executor(None, slot.start, node)
                                slot.consecutive_fails = 0

                    # 3. 速率上限 → 轮换
                    elif slot.requests_in_window(self.window) >= self.rate_limit:
                        node = self._next_node()
                        if node:
                            loop = asyncio.get_running_loop()
                            await loop.run_in_executor(None, slot.start, node)

                except asyncio.CancelledError:
                    return
                except Exception as e:
                    logger.error(f"监控 Slot {slot.slot_id} 异常: {e}")

    # ---- 结果记录 ----

    def record_result(self, slot, success, error=""):
        """记录请求结果，生产流量反馈到节点分级"""
        self.total_requests += 1
        if success:
            self.total_success += 1
        else:
            self.total_fail += 1
        slot.record_result(success, error)

        # EMA 延迟反馈到节点分级
        if slot.node:
            key = self._node_key(slot.node)
            old_score = self._node_scores.get(key, {})
            if success:
                old_latency = old_score.get('latency', 0)
                self._node_scores[key] = {
                    'verified': True, 'last_test': time.time(),
                    'latency': old_latency * 0.7 if old_latency else 0,
                    'fail_count': 0,
                }
            elif "403" in (error or "") or "Timeout" in (error or ""):
                self._node_scores[key] = {
                    'verified': False, 'last_test': time.time(), 'latency': 9999,
                    'fail_count': old_score.get('fail_count', 0) + 1,
                }

        total = slot.success_count + slot.fail_count
        if total >= 5:
            rate = slot.success_rate
            if rate < 0.5:
                self.rate_limit = max(2, self._initial_rate_limit // 2)
            elif rate < 0.8:
                self.rate_limit = max(3, int(self._initial_rate_limit * 0.7))
            else:
                self.rate_limit = self._initial_rate_limit

    # ---- 状态报告 ----

    def _tier_summary(self) -> dict:
        """返回各分级节点数量统计"""
        now = time.time()
        t1 = sum(1 for s in self._node_scores.values()
                 if s['verified'] and now - s['last_test'] < self._pretest_interval)
        t3 = sum(1 for s in self._node_scores.values()
                 if not s['verified'] and now - s['last_test'] < self._pretest_interval)
        t2 = len(self.all_nodes) - t1 - t3
        return {
            "good": t1, "ok": t2, "bad": t3,
            "total_tracked": len(self._node_scores),
            "ready_pool": len(self._ready_nodes),
        }

    def status_dict(self) -> dict:
        """返回代理池状态"""
        slots_info = []
        for slot in self.slots:
            cooldown_left = max(0, slot.blocked_until - time.time())
            node_tier = self._get_node_tier(slot.node) if slot.node else 2
            tier_label = f"T{node_tier}"
            slots_info.append({
                "slot_id": slot.slot_id,
                "node": slot.node_name,
                "node_tier": tier_label,
                "alive": slot.alive,
                "status": slot.status,
                "port": slot.socks_port,
                "requests_1min": slot.requests_in_window(self.window),
                "total_requests": slot.total_requests,
                "success": slot.success_count,
                "fail": slot.fail_count,
                "success_rate": f"{slot.success_rate:.1%}",
                "blocked_count": slot.blocked_count,
                "cooldown_left": round(cooldown_left, 1),
                "consecutive_fails": slot.consecutive_fails,
                "last_error": slot.last_error,
            })
        # 所有节点信息
        nodes_info = []
        in_use_keys = set()
        for slot in self.slots:
            if slot.node:
                in_use_keys.add(self._node_key(slot.node))
        for node in self.all_nodes:
            key = self._node_key(node)
            tier = self._get_node_tier(node)
            score = self._node_scores.get(key, {})
            nodes_info.append({
                "name": node.get("name", "?"),
                "host": node.get("host", ""),
                "port": node.get("port", 0),
                "type": node.get("type", "?"),
                "tier": f"T{tier}",
                "latency": round(score.get("latency", -1), 1) if score.get("latency", -1) > 0 and score.get("latency", 9999) < 9999 else -1,
                "verified": score.get("verified", False),
                "fail_count": score.get("fail_count", 0),
                "in_use": key in in_use_keys,
            })

        return {
            "running": self._running,
            "total_requests": self.total_requests,
            "total_success": self.total_success,
            "total_fail": self.total_fail,
            "success_rate": f"{self.total_success / self.total_requests:.1%}" if self.total_requests else "N/A",
            "current_rate_limit": self.rate_limit,
            "total_nodes": len(self.all_nodes),
            "alive_slots": sum(1 for s in self.slots if s.alive),
            "total_slots": len(self.slots),
            "node_tiers": self._tier_summary(),
            "slots": slots_info,
            "nodes": nodes_info,
        }


# ============================================================
#  节点加载
# ============================================================
def _filter_nodes(raw_nodes: list) -> list:
    """过滤无效节点并排序"""
    info_keywords = ["剩余流量", "套餐到期", "官网", "到期时间", "过期", "流量"]
    nodes = []
    for n in raw_nodes:
        host = n.get("host", "")
        name = n.get("name", "")
        if host in ("127.0.0.1", "localhost", "0.0.0.0", "") or not n.get("port", 0):
            continue
        if any(kw in name for kw in info_keywords):
            continue
        nodes.append(n)
    nodes.sort(key=lambda n: n.get("latency", 99999) if n.get("latency", -1) > 0 else 99999)
    return nodes


def load_nodes_from_config(config_path: str) -> list:
    """从 vpn_config.json 加载节点"""
    if not os.path.exists(config_path):
        logger.error(f"节点配置不存在: {config_path}")
        return []

    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
    except Exception as e:
        logger.error(f"解析节点配置失败: {e}")
        return []

    cached = config.get("cached_nodes", [])
    nodes = _filter_nodes(cached)
    logger.info(f"节点加载: {len(nodes)} 个可用 (跳过 {len(cached) - len(nodes)} 个无效节点)")
    return nodes


def load_nodes_from_subscription(url: str) -> tuple:
    """从订阅链接获取节点，返回 (nodes_list, error_msg)"""
    try:
        from subscription_parser import SubscriptionParser
        raw_nodes, err = SubscriptionParser.fetch_and_parse(url)
        if err:
            return [], err
        node_dicts = [n.to_dict() for n in raw_nodes]
        nodes = _filter_nodes(node_dicts)
        logger.info(f"订阅获取: {len(nodes)} 个可用节点")
        return nodes, None
    except ImportError as e:
        return [], f"导入订阅解析器失败: {e}\n请安装: pip install requests pyyaml"
    except Exception as e:
        return [], f"订阅获取异常: {e}"


async def refresh_subscription() -> dict:
    """刷新订阅节点并缓存"""
    config = get_config()
    url = config.get("subscription_url", "")
    if not url:
        return {"success": False, "message": "未配置订阅链接"}

    loop = asyncio.get_running_loop()
    nodes, err = await loop.run_in_executor(None, load_nodes_from_subscription, url)
    if err:
        return {"success": False, "message": f"订阅获取失败: {err}"}
    if not nodes:
        return {"success": False, "message": "订阅中没有可用节点"}

    # 缓存到本地文件
    cache_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "subscription_cache.json")
    try:
        with open(cache_path, 'w', encoding='utf-8') as f:
            json.dump({"cached_nodes": nodes, "updated": time.strftime("%Y-%m-%d %H:%M:%S")}, f, ensure_ascii=False, indent=2)
    except Exception as e:
        logger.warning(f"缓存订阅节点失败: {e}")

    return {"success": True, "message": f"获取到 {len(nodes)} 个可用节点", "count": len(nodes)}


# ============================================================
#  全局实例管理
# ============================================================
_pool: Optional[ProxyPool] = None
_config: Optional[ProxyPoolConfig] = None
_direct_cooldown_until: float = 0  # 直连冷却结束时间戳


def get_config() -> ProxyPoolConfig:
    """获取配置实例"""
    global _config
    if _config is None:
        config_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "proxy_pool_config.json")
        _config = ProxyPoolConfig(config_file)
    return _config


def get_pool() -> Optional[ProxyPool]:
    """获取代理池实例（可能为 None）"""
    return _pool


_direct_requests = deque()   # 直连请求时间戳滑动窗口
_DIRECT_WINDOW = 60          # 统计窗口(秒)
_DIRECT_RATE_LIMIT = 4       # 每分钟直连上限(超过则切代理池)
_last_route = "无"            # 最近一次请求的路由方式


def report_route(route: str):
    """记录最近一次请求的路由方式"""
    global _last_route
    _last_route = route


def get_last_route() -> str:
    """获取最近一次请求的路由方式"""
    return _last_route

def should_use_direct() -> bool:
    """判断当前是否应使用直连。
    1) prefer_direct 关闭 → False
    2) 403冷却中 → False
    3) 直连速率超限 → False（主动切代理池，避免403）
    4) 以上都通过 → True
    """
    config = get_config()
    if not config.get("prefer_direct", False):
        return False
    now = time.time()
    if now < _direct_cooldown_until:
        remaining = _direct_cooldown_until - now
        logger.info(f"[直连] 冷却中，剩余 {remaining:.0f}s，走代理")
        return False
    # 清理过期记录，统计窗口内请求数
    while _direct_requests and _direct_requests[0] < now - _DIRECT_WINDOW:
        _direct_requests.popleft()
    rate_limit = config.get("direct_rate_limit", _DIRECT_RATE_LIMIT)
    current = len(_direct_requests)
    if current >= rate_limit:
        logger.info(f"[直连] 速率超限 ({current}/{rate_limit}/min)，走代理")
        return False
    logger.info(f"[直连] 可用 ({current}/{rate_limit}/min)")
    return True


def report_direct_success():
    """记录一次直连请求（用于速率统计）"""
    _direct_requests.append(time.time())


def report_direct_blocked():
    """直连被风控/403，进入长冷却期"""
    global _direct_cooldown_until
    config = get_config()
    cooldown = config.get("direct_cooldown", 60)
    _direct_cooldown_until = time.time() + cooldown
    logger.warning(f"直连被403，进入冷却 {cooldown}s，全部切换到代理池")


def direct_status() -> dict:
    """获取直连状态信息"""
    config = get_config()
    now = time.time()
    cooling = now < _direct_cooldown_until
    remaining = max(0, _direct_cooldown_until - now) if cooling else 0
    # 统计当前窗口内直连请求数
    while _direct_requests and _direct_requests[0] < now - _DIRECT_WINDOW:
        _direct_requests.popleft()
    rate_limit = config.get("direct_rate_limit", _DIRECT_RATE_LIMIT)
    return {
        "prefer_direct": config.get("prefer_direct", False),
        "direct_cooldown": config.get("direct_cooldown", 60),
        "is_cooling": cooling,
        "cooldown_remaining": round(remaining, 1),
        "using_direct": should_use_direct(),
        "direct_req_1min": len(_direct_requests),
        "direct_rate_limit": rate_limit,
    }


async def start_pool() -> dict:
    """启动代理池，返回状态"""
    global _pool
    config = get_config()

    if _pool and _pool._running:
        return {"success": False, "message": "代理池已在运行"}

    singbox_path = config.get("singbox_path", "")
    if not singbox_path or not os.path.isfile(singbox_path):
        return {"success": False, "message": f"sing-box 路径无效: {singbox_path}"}

    # 优先使用本地缓存 subscription_cache.json
    nodes = []
    cache_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "subscription_cache.json")
    if os.path.exists(cache_path):
        nodes = load_nodes_from_config(cache_path)
        if nodes:
            logger.info(f"从本地缓存加载 {len(nodes)} 个节点")

    # 回退：订阅链接在线获取
    if not nodes:
        sub_url = config.get("subscription_url", "")
        if sub_url:
            loop = asyncio.get_running_loop()
            nodes, err = await loop.run_in_executor(None, load_nodes_from_subscription, sub_url)
            if err:
                logger.warning(f"订阅获取失败: {err}")
            elif nodes:
                try:
                    with open(cache_path, 'w', encoding='utf-8') as f:
                        json.dump({"cached_nodes": nodes, "updated": time.strftime("%Y-%m-%d %H:%M:%S")}, f, ensure_ascii=False, indent=2)
                except Exception:
                    pass

    if not nodes:
        return {"success": False, "message": "没有可用的代理节点，请在节点缓存中写入节点或配置订阅链接"}

    base_dir = os.path.dirname(os.path.abspath(__file__))
    pool = ProxyPool(
        nodes=nodes,
        singbox_path=singbox_path,
        base_dir=base_dir,
        num_slots=config.get("num_slots", 5),
        base_port=config.get("base_port", 21000),
        rate_limit=config.get("rate_limit", 8),
        window=config.get("window", 60),
    )

    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, pool.start)
    await pool.start_monitor()

    _pool = pool
    config.set("enabled", True)

    alive = sum(1 for s in pool.slots if s.alive)
    return {
        "success": True,
        "message": f"代理池已启动: {alive}/{pool.num_slots} 槽位在线, {len(nodes)} 个节点"
    }


async def stop_pool() -> dict:
    """停止代理池"""
    global _pool
    config = get_config()

    if not _pool:
        return {"success": False, "message": "代理池未运行"}

    await _pool.stop()
    _pool = None
    config.set("enabled", False)
    return {"success": True, "message": "代理池已停止"}


async def auto_start_pool():
    """服务器启动时自动启动代理池（如果配置了 enabled=True）"""
    config = get_config()
    if config.get("enabled"):
        logger.info("自动启动代理池...")
        result = await start_pool()
        logger.info(f"自动启动结果: {result['message']}")


async def proxy_request(
    method: str,
    url: str,
    *,
    json_data: dict = None,
    form_data: dict = None,
    headers: dict = None,
    timeout: float = 30,
    strict: bool = False,
) -> Optional[httpx.Response]:
    """通过代理池发送HTTP请求

    Returns:
        httpx.Response 或 None（代理池未启用时，调用方应回退到直连）
    """
    pool = get_pool()
    if not pool or not pool._running:
        return None

    max_retries = 3 if strict else 2
    used_slots = set()

    for attempt in range(max_retries):
        slot = await pool.get_proxy(exclude=used_slots)
        if not slot:
            logger.error("没有可用的代理槽位")
            return None
        used_slots.add(slot.slot_id)

        t0 = time.time()
        try:
            async with httpx.AsyncClient(
                proxy=slot.proxy_url,
                verify=False,
                timeout=timeout
            ) as client:
                kwargs = {"headers": headers or {}}
                if json_data is not None:
                    kwargs["json"] = json_data
                elif form_data is not None:
                    kwargs["data"] = form_data

                response = await client.request(method, url, **kwargs)
                elapsed = (time.time() - t0) * 1000

                if response.status_code == 403:
                    pool.record_result(slot, False, "403 blocked")
                    logger.warning(f"[Slot {slot.slot_id}] 403 被风控，轮换 [{slot.node_name}]")
                    await pool.rotate_slot(slot)
                    if attempt < max_retries - 1:
                        continue

                success = 200 <= response.status_code < 400
                pool.record_result(slot, success)
                report_route(f"代理 Slot{slot.slot_id} [{slot.node_name}]")
                logger.info(
                    f"[Slot {slot.slot_id}] {method} -> {response.status_code} "
                    f"({slot.requests_in_window(60)}/{pool.rate_limit}/min) "
                    f"{elapsed:.0f}ms [{slot.node_name}]"
                )
                return response

        except httpx.TimeoutException:
            elapsed = (time.time() - t0) * 1000
            pool.record_result(slot, False, "Timeout")
            logger.error(f"[Slot {slot.slot_id}] 超时 ({elapsed:.0f}ms) [{slot.node_name}]")
            if attempt < max_retries - 1:
                continue
        except (httpx.ConnectError, httpx.ProxyError) as e:
            elapsed = (time.time() - t0) * 1000
            pool.record_result(slot, False, str(e)[:100])
            logger.error(f"[Slot {slot.slot_id}] 连接失败: {e}")
            if attempt < max_retries - 1:
                await pool.rotate_slot(slot, "connect_error")
                continue
        except Exception as e:
            pool.record_result(slot, False, str(e)[:100])
            logger.error(f"[Slot {slot.slot_id}] 异常: {e}")
            return None

    return None
