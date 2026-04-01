# 多隧道代理与限速规避研究文档

> 最后更新：2026-03-31

---

## 目录

1. [多隧道模块概述](#一多隧道模块概述)
2. [订阅解析修复记录](#二订阅解析修复记录)
3. [sing-box 配置生成](#三sing-box-配置生成)
4. [出口 IP 检测与去重](#四出口-ip-检测与去重)
5. [ip_dedup 核心模块说明](#五ip_dedup-核心模块说明)
6. [AK 服务器限速机制研究](#六ak-服务器限速机制研究)
7. [多 IP 并发压测结果](#七多-ip-并发压测结果)
8. [测试工具说明](#八测试工具说明)
9. [最佳实践建议](#九最佳实践建议)

---

## 一、多隧道模块概述

### 目录结构

```
multi_tunnel/
├── __init__.py
├── sub_parser.py      # 订阅链接解析（VLESS / hysteria2）
├── singbox.py         # sing-box config.json 生成器
├── dispatcher.py      # 代理分发器（预留）
└── ip_dedup.py        # 出口 IP 探测与去重（核心可用模块）
```

### 工作原理

1. **订阅解析**：从订阅 URL 下载节点列表，解析为标准 dict 格式，保存至 `sing-box/nodes.json`
2. **配置生成**：基于 nodes.json 生成 sing-box 的 `config.json`，为每个节点创建一个独立的 SOCKS5 入站（端口从 `10001` 起递增）和对应的出站
3. **代理使用**：每个 SOCKS5 端口代表一个独立的出口 IP，通过 `socks5h://127.0.0.1:<port>` 使用

### 端口映射关系

| 节点索引 | SOCKS5 端口 | 出站代理 |
|---------|------------|---------|
| 0       | 10001      | proxy_0 |
| 1       | 10002      | proxy_1 |
| …       | …          | …       |
| N-1     | 10000+N    | proxy_N-1 |

---

## 二、订阅解析修复记录

### 修复文件：`multi_tunnel/sub_parser.py`

#### VLESS Reality TLS 参数缺失

**问题：** URL query string 中的 Reality 特有参数未被解析。

**修复前缺失的参数：**

| 参数 | 含义 | URL query key |
|------|------|---------------|
| `pbk` | Reality 公钥 | `pbk` |
| `sid` | Short ID | `sid` |
| `fp`  | uTLS fingerprint | `fp` |

**修复后**：从 URL query string 中完整提取上述字段并保存到节点 dict。

#### hysteria2 参数缺失

**问题：** hysteria2 协议的 TLS/混淆参数未被解析。

**修复后新增提取：**

| 参数 | 含义 |
|------|------|
| `sni` | TLS SNI 域名 |
| `insecure` | 是否跳过证书验证 |
| `obfs` | 混淆方式 |
| `obfs-password` | 混淆密码 |

---

## 三、sing-box 配置生成

### 修复文件：`multi_tunnel/singbox.py`

#### VLESS Reality TLS outbound 结构

```json
{
  "type": "vless",
  "tag": "proxy_N",
  "server": "<host>",
  "server_port": <port>,
  "uuid": "<uuid>",
  "flow": "xtls-rprx-vision",
  "tls": {
    "enabled": true,
    "server_name": "<sni>",
    "utls": {
      "enabled": true,
      "fingerprint": "<fp>"
    },
    "reality": {
      "enabled": true,
      "public_key": "<pbk>",
      "short_id": "<sid>"
    }
  },
  "network": "tcp"
}
```

#### hysteria2 outbound 结构

```json
{
  "type": "hysteria2",
  "tag": "proxy_N",
  "server": "<host>",
  "server_port": <port>,
  "password": "<password>",
  "tls": {
    "enabled": true,
    "server_name": "<sni>",
    "insecure": <true|false>
  },
  "obfs": {
    "type": "salamander",
    "password": "<obfs-password>"
  }
}
```

---

## 四、出口 IP 检测与去重

### 问题背景

34 个节点中有 9 个节点与其他节点共用同一出口 IPv4，若全部作为独立 IP 使用，会导致同一 IP 上并发请求过多而触发限速。

### 去重工具

**文件：** `check_exit_ips_multi.py`

**检测端点（按优先级）：**

```python
IP_CHECK_URLS = [
    ("https://httpbin.org/ip",        "json", "origin"),  # 首选，JSON格式
    ("https://api4.ipify.org",        "text", None),
    ("https://ipv4.icanhazip.com",    "text", None),
    ("http://checkip.amazonaws.com",  "text", None),
]
```

> **注意：** `whoer.net`、`ippure.com` 因 Cloudflare 拦截不可用。`httpbin.org/ip` 是目前最可靠的 IPv4 检测端点。

### 去重结果（订阅 URL: liangxin.xyz）

| 重复出口 IP | 端口列表 | 保留端口 |
|-----------|---------|---------|
| 18.162.53.81 | 10001, 10002, 10003 | 10001 |
| 203.10.99.59 | 10015, 10016, 10017 | 10015 |
| 203.10.97.121 | 10019, 10020, 10033 | 10019 |
| 3.38.42.23 | 10021, 10031 | 10021 |
| 43.212.252.169 | 10022, 10032 | 10022 |
| 198.144.180.2 | 10018, 10034 | 10018 |

**最终：34 节点 → 25 个唯一 IPv4 端口**

### 代码集成

`test_rate_limit_concurrent.py` 在启动前自动调用 `multi_tunnel.ip_dedup.get_unique_ports()` 完成去重，结果缓存 6 小时（`cache/ip_dedup_cache.json`）：

```python
from multi_tunnel.ip_dedup import get_unique_ports
unique_ports = get_unique_ports(base_port, node_count, cache_path=DEDUP_CACHE)
# 只用 unique_ports 参与并发分配
```

---

## 五、ip_dedup 核心模块说明

**文件路径：** `multi_tunnel/ip_dedup.py`

### 模块职责

独立的出口 IP 探测与去重模块。缺少此模块时系统仍可运行，但无法自动过滤重复出口 IP。

### 公开 API

#### `probe_unique_ports(base_port, num_ports, timeout, verbose) -> list[int]`

纯探测，无缓存。并行探测所有端口，返回去重后的端口列表。

```python
from multi_tunnel import probe_unique_ports
ports = probe_unique_ports(base_port=10001, num_ports=34)
# → [10001, 10004, 10005, ...]  (去重后 25 个)
```

#### `get_unique_ports(base_port, num_ports, cache_path, cache_ttl_hours, force_refresh, timeout, verbose) -> list[int]`

带缓存的主入口，适合生产使用。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `base_port` | int | — | SOCKS5 起始端口 |
| `num_ports` | int | — | 端口总数 |
| `cache_path` | Path\|None | None | 缓存文件路径，None=不缓存 |
| `cache_ttl_hours` | float | 6.0 | 缓存有效期（小时） |
| `force_refresh` | bool | False | 强制跳过缓存重新探测 |
| `timeout` | float | 10.0 | 单端口探测超时（秒） |

```python
from multi_tunnel import get_unique_ports
from pathlib import Path

ports = get_unique_ports(
    base_port=10001,
    num_ports=34,
    cache_path=Path("cache/ip_dedup_cache.json"),
    cache_ttl_hours=6.0,
)
```

#### `load_cached_unique_ports(cache_path, base_port, num_ports, cache_ttl_hours) -> list[int] | None`

仅读取缓存，缓存过期或参数不匹配时返回 `None`。

#### `save_cached_unique_ports(base_port, num_ports, unique_ports, ip_map, dup_groups, cache_path)`

将探测结果写入缓存文件。

### 缓存文件格式

**路径：** `cache/ip_dedup_cache.json`

```json
{
  "timestamp":    "2026-03-31T10:00:00+00:00",
  "base_port":    10001,
  "num_ports":    34,
  "unique_ports": [10001, 10004, 10005, ...],
  "ip_map":       {"10001": "1.2.3.4", "10004": "5.6.7.8", ...},
  "dup_groups":   {"18.162.53.81": [10001, 10002, 10003], ...}
}
```

### 命令行使用

```bash
# 探测并显示去重结果（使用缓存）
python -m multi_tunnel.ip_dedup --base-port 10001 --num-ports 34

# 强制重新探测（忽略缓存）
python -m multi_tunnel.ip_dedup --base-port 10001 --num-ports 34 --force

# 不保存缓存
python -m multi_tunnel.ip_dedup --base-port 10001 --num-ports 34 --no-cache
```

### 检测端点（按优先级）

| 端点 | 格式 | 说明 |
|------|------|------|
| `https://httpbin.org/ip` | JSON `{"origin": "x.x.x.x"}` | 首选，稳定返回 IPv4 |
| `https://api4.ipify.org` | 纯文本 | 备选 |
| `https://ipv4.icanhazip.com` | 纯文本 | 备选 |
| `http://checkip.amazonaws.com` | 纯文本 | 备选 |

> `whoer.net`、`ippure.com` 因 Cloudflare 拦截，不可作为检测端点。

### 与其他模块的集成

`test_rate_limit_concurrent.py` 通过包装函数调用此模块，并增加了 `--force-refresh` CLI 参数：

```bash
python test_rate_limit_concurrent.py \
  --accounts hyh6699,sgf6699,zyz47685 \
  --force-refresh   # 强制重新探测，跳过缓存
```

---

## 六、AK 服务器限速机制研究

### 研究方法

通过 `test_single_ip_threshold.py` 脚本的多种测试模式系统性地探测限速参数。

### 实验数据

| 测试场景 | 结果 | 备注 |
|---------|------|------|
| 3 并发（同时） | ❌ 第3个立即429 | 瞬时上限=2 |
| 2 并发，每5s重复 | ❌ 第3轮（t≈11s）429 | 窗口未清 |
| 2 并发，每10s重复 | ✅ 90s 零429 | 窗口清空 |
| 顺序1req/5s，60s | ✅ 12个全200 | **最安全** |
| t=0→t=2s→t=7.9s | ❌ 第3个429 | W>7.9s |
| 4并发填窗口→每秒探测 | t=6.6s首个200 | 短暂冷却时间 |

### 限速参数总结

| 参数 | 值 | 说明 |
|------|----|----|
| **限速维度** | 按 IP 计数 | 与账号无关 |
| **滑动窗口 W** | ≈ 8 秒 | 从请求发出时刻起计 |
| **每窗口上限 N** | 2 次 | 超过即返回 HTTP 429 |
| **并发 burst 副作用** | 有 | 多次 burst 会累积惩罚 |
| **安全发送速率** | 1 req / 5s / IP | 0.2 req/s，低于阈值 0.25 req/s |

### 关键结论

> **最安全策略：每个 IP 每 5 秒顺序发送 1 次请求，不使用并发 burst。**

- 并发 burst（多个请求几乎同时到达服务器）会被服务器的"突发检测"识别，触发比顺序请求更严格的惩罚
- 顺序请求每 5s 一次，即使在同一窗口内累积，也不会触发限速
- 限速是按 IP 而非账号计数，同一 IP 上的任何账号请求都共享同一个计数器

---

## 七、多 IP 并发压测结果

### 配置

```
节点总数:    34
唯一IP端口:  25
账号数:      3（hyh6699, sgf6699, zyz47685）
配额分配:    hyh6699=9槽, sgf6699=8槽, zyz47685=8槽
每槽冷却:    5 秒
测试时长:    60 秒
```

### 结果

| 指标 | 数值 |
|------|------|
| 总请求 | 266 |
| HTTP 200 | 255 |
| **429** | **0** |
| **异常** | **0** |
| 成功速率 | 4.25 req/s |

### 按账号统计

| 账号 | 总请求 | 200 | 429 | err | 槽数 |
|------|--------|-----|-----|-----|------|
| hyh6699 | 96 | 85 | 0 | 0 | 9 |
| sgf6699 | 82 | 82 | 0 | 0 | 8 |
| zyz47685 | 88 | 88 | 0 | 0 | 8 |

> hyh6699 的 200≠85 是业务层拒绝（如参数错误），非限速问题。

### 零429原理

每个 IP 槽串行发送（无并发），每 5s 一次 = 0.2 req/s/IP，低于服务器阈值 2/8s = 0.25 req/s/IP。

---

## 八、测试工具说明

### 1. `test_rate_limit_concurrent.py` — 多IP并发压测

```bash
python test_rate_limit_concurrent.py \
  --accounts hyh6699,sgf6699,zyz47685 \
  --duration 60 \
  --cooldown 5 \
  --base-port 10001
```

**功能：**
- 自动从 `sing-box/nodes.json` 读取节点数
- 并行探测各端口出口 IPv4 并去重
- 通过 `GlobalSellBudget` 分配并发配额
- 每槽绑定一个唯一 IP 端口
- 统计 200/429/err 及按账号分布

---

### 2. `test_single_ip_threshold.py` — 单IP阈值探测

```bash
# 模式1：爆发N个，然后单发（找初始burst上限）
python test_single_ip_threshold.py --accounts hyh6699 --burst 2 --duration 60

# 模式2：每轮都发burst个（找持续并发上限）
python test_single_ip_threshold.py --accounts hyh6699 --burst 2 --repeat --cooldown 10

# 模式3：交替2并发和1单发
python test_single_ip_threshold.py --accounts hyh6699,sgf6699 --burst 2 --mixed --cooldown 5

# 模式4：探测模式（t=0→2s→5s×2→2s循环）
python test_single_ip_threshold.py --accounts hyh6699,sgf6699,zyz47685 --probe --duration 90
```

---

### 3. `test_sliding_window.py` — 滑动窗口精确测定

```bash
python test_sliding_window.py hyh6699
```

**功能：** 发4个请求填满窗口，然后每秒探测1次，记录第一个200出现时间，推算窗口大小 W。

---

### 4. `check_exit_ips_multi.py` — 出口IP多轮检测

```bash
python check_exit_ips_multi.py
```

**功能：** 并行检测所有 SOCKS5 端口的出口 IPv4，显示重复 IP 分组。

---

### 5. `rate_limit_probe.py` — 原始限速探测（已废弃）

早期诊断工具，已被 `test_single_ip_threshold.py` 替代。

---

## 九、最佳实践建议

### 生产环境配置

```
每IP发送间隔:  5 秒（建议，安全系数 2.5×）
最大并发槽数:  等于唯一出口 IP 数（勿超）
每槽模式:      串行（单线程，无并发）
429惩罚处理:   GlobalSellBudget 自动降配额并重新分配
```

### 订阅节点维护

1. 定期重新下载订阅（节点可能变更）
2. 重新运行 IP 去重检测：`python -m multi_tunnel.ip_dedup --base-port 10001 --num-ports 34 --force`
3. 重新生成 sing-box config（`python multi_tunnel/singbox.py`）
4. 重启 sing-box 进程

### 注意事项

- sing-box 进程必须在压测/主程序运行前启动
- SOCKS5 端口范围：10001 ~ 10000+N（N=节点总数）
- IPv6 出口 IP 不影响 AK 服务器识别（服务器按 IPv4 计数）
- 重复 IP 的节点保留其中一个即可，其余丢弃

---

*文档由研究过程自动整理，如有更新请同步修改本文件。*
