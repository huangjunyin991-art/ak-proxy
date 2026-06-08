# -*- coding: utf-8 -*-
"""
VPN订阅解析模块
支持: Clash YAML / Base64 / VLESS / Hysteria2 / SS / VMess 链接
可通过URL自动获取，也可直接解析文本内容
"""

import base64
import json
import logging
import re
import urllib.parse
from typing import Optional

try:
    from .security.url_fetch_gateway import UrlFetchGateway, UrlFetchPolicy
except Exception:
    from public_admin.server.security.url_fetch_gateway import UrlFetchGateway, UrlFetchPolicy

logger = logging.getLogger("TransparentProxy")

SUBSCRIPTION_FETCH_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'

# 地区识别规则
REGION_RULES = [
    (['香港', '🇭🇰', 'HK', 'Hong Kong'], 'HK', '香港'),
    (['新加坡', '🇸🇬', 'SG', 'Singapore'], 'SG', '新加坡'),
    (['日本', '🇯🇵', 'JP', 'Japan'], 'JP', '日本'),
    (['美国', '美國', '🇺🇸', 'US', 'United States'], 'US', '美国'),
    (['台湾', '台灣', '🇹🇼', 'TW', 'Taiwan'], 'TW', '台湾'),
    (['韩国', '🇰🇷', 'KR', 'Korea'], 'KR', '韩国'),
    (['英国', '🇬🇧', 'UK', 'United Kingdom'], 'UK', '英国'),
    (['德国', '🇩🇪', 'DE', 'Germany'], 'DE', '德国'),
    (['法国', '🇫🇷', 'FR', 'France'], 'FR', '法国'),
    (['荷兰', '🇳🇱', 'NL', 'Netherlands'], 'NL', '荷兰'),
    (['加拿大', '🇨🇦', 'CA', 'Canada'], 'CA', '加拿大'),
    (['俄罗斯', '🇷🇺', 'RU', 'Russia'], 'RU', '俄罗斯'),
    (['澳大利亚', '🇦🇺', 'AU', 'Australia'], 'AU', '澳大利亚'),
    (['土耳其', '🇹🇷', 'TR', 'Turkey'], 'TR', '土耳其'),
    (['巴西', '🇧🇷', 'BR', 'Brazil'], 'BR', '巴西'),
    (['印度', '🇮🇳', 'IN', 'India'], 'IN', '印度'),
    (['菲律宾', '🇵🇭', 'PH'], 'PH', '菲律宾'),
    (['泰国', '🇹🇭', 'TH', 'Thailand'], 'TH', '泰国'),
    (['越南', '🇻🇳', 'VN', 'Vietnam'], 'VN', '越南'),
    (['马来西亚', '🇲🇾', 'MY', 'Malaysia'], 'MY', '马来西亚'),
    (['印尼', '🇮🇩', 'ID', 'Indonesia'], 'ID', '印尼'),
]

# 跳过的节点名称关键词
SKIP_KEYWORDS = ['剩余', '套餐', '到期', '流量', '过期', '官网', '续费', '客服', '超时']


def detect_region(name: str) -> tuple[str, str]:
    """根据节点名称识别地区，返回 (code, label)"""
    for keywords, code, label in REGION_RULES:
        if any(k in name for k in keywords):
            return code, label
    return 'OTHER', '其他'


def _try_base64_decode(text: str) -> Optional[str]:
    """尝试base64解码"""
    try:
        # 补齐padding
        compact = ''.join(text.strip().split())
        padded = compact + '=' * ((4 - len(compact) % 4) % 4)
        decoded = base64.urlsafe_b64decode(padded).decode('utf-8')
        # 简单验证是否是可读文本
        if any(c in decoded for c in ['\n', '://', 'proxies']):
            return decoded
    except Exception:
        pass
    return None


def _iter_proxy_lines(text: str):
    for line in text.replace('\r', '\n').split('\n'):
        line = line.strip()
        if not line:
            continue
        if '://' not in line:
            continue
        start = min(
            (pos for pos in (line.find('anytls://'), line.find('vless://'), line.find('hysteria2://'), line.find('hy2://'), line.find('ss://'), line.find('vmess://')) if pos >= 0),
            default=-1,
        )
        if start >= 0:
            yield line[start:]


def _safe_b64_decode(value: str) -> Optional[str]:
    try:
        compact = ''.join(value.strip().split())
        padded = compact + '=' * ((4 - len(compact) % 4) % 4)
        return base64.urlsafe_b64decode(padded).decode('utf-8')
    except Exception:
        return None


def _split_host_port(value: str) -> tuple[str, int]:
    parsed = urllib.parse.urlsplit('//' + value)
    if parsed.hostname and parsed.port:
        return parsed.hostname, parsed.port
    server, port = value.rsplit(':', 1)
    return server.strip('[]'), int(port)


def _parse_simple_clash_proxies(text: str) -> list[dict]:
    proxies = []
    current = None
    in_proxies = False
    for raw_line in text.replace('\r', '\n').split('\n'):
        if not raw_line.strip():
            continue
        stripped = raw_line.strip()
        if re.match(r'^proxies\s*:', stripped):
            in_proxies = True
            continue
        if in_proxies and not raw_line.startswith((' ', '\t', '-')):
            break
        if not in_proxies:
            continue
        if stripped.startswith('- '):
            if current:
                proxies.append(current)
            current = {}
            stripped = stripped[2:].strip()
            if stripped.startswith('{') and stripped.endswith('}'):
                pairs = re.findall(r'([A-Za-z0-9_-]+)\s*:\s*([^,}]+)', stripped)
                current.update({k: v.strip().strip('"\'') for k, v in pairs})
            elif ':' in stripped:
                key, value = stripped.split(':', 1)
                current[key.strip()] = value.strip().strip('"\'')
            continue
        if current is not None and ':' in stripped:
            key, value = stripped.split(':', 1)
            current[key.strip()] = value.strip().strip('"\'')
    if current:
        proxies.append(current)
    return proxies


def _parse_clash_yaml(text: str) -> list[dict]:
    """解析Clash YAML格式的订阅"""
    try:
        import yaml
        config = yaml.safe_load(text)
    except Exception:
        config = None

    if not isinstance(config, dict):
        proxies = _parse_simple_clash_proxies(text)
    else:
        proxies = config.get('proxies', [])
        if not proxies:
            proxies = _parse_simple_clash_proxies(text)
    if not proxies:
        return []

    nodes = []
    for p in proxies:
        name = p.get('name', '')
        # 跳过信息节点
        if any(k in name for k in SKIP_KEYWORDS):
            continue

        proto = p.get('type', 'unknown')
        server = p.get('server', '')
        port = p.get('port', 0)

        if not server or not port:
            continue

        region_code, region_label = detect_region(name)
        nodes.append({
            'name': name,
            'type': proto,
            'server': server,
            'port': int(port),
            'region_code': region_code,
            'region_label': region_label,
            'raw': {k: v for k, v in p.items() if k in (
                'type', 'server', 'port', 'cipher', 'password', 'uuid',
                'alterId', 'network', 'tls', 'sni', 'udp',
                'plugin', 'plugin-opts', 'ws-opts', 'grpc-opts',
            )},
        })

    return nodes


def _parse_ss_links(text: str) -> list[dict]:
    """解析SS/SSR链接列表"""
    nodes = []
    for line in _iter_proxy_lines(text):
        if line.startswith('ss://'):
            try:
                # ss://base64@server:port#name  or  ss://base64#name
                rest = line[5:]
                name = ''
                if '#' in rest:
                    rest, name = rest.rsplit('#', 1)
                    name = urllib.parse.unquote(name.strip())

                method, password = 'aes-128-gcm', ''
                if '@' in rest:
                    userinfo, addr = rest.split('@', 1)
                    if '?' in addr:
                        addr, query = addr.split('?', 1)
                    else:
                        query = ''
                    server, port = _split_host_port(addr)
                    decoded_userinfo = _safe_b64_decode(userinfo)
                    creds = decoded_userinfo if decoded_userinfo and ':' in decoded_userinfo else urllib.parse.unquote(userinfo)
                    if ':' in creds:
                        method, password = creds.split(':', 1)
                else:
                    if '?' in rest:
                        rest, query = rest.split('?', 1)
                    else:
                        query = ''
                    decoded = _safe_b64_decode(rest)
                    if not decoded:
                        continue
                    creds, addr = decoded.rsplit('@', 1)
                    server, port = _split_host_port(addr)
                    if ':' in creds:
                        method, password = creds.split(':', 1)

                if any(k in name for k in SKIP_KEYWORDS):
                    continue
                region_code, region_label = detect_region(name)
                nodes.append({
                    'name': name or f'SS-{server}',
                    'type': 'ss',
                    'server': server,
                    'port': int(port),
                    'region_code': region_code,
                    'region_label': region_label,
                    'raw': {'cipher': method, 'password': password, 'plugin': urllib.parse.parse_qs(query).get('plugin', [''])[0]},
                })
            except Exception:
                continue
        elif line.startswith('vmess://'):
            try:
                encoded = line[8:]
                data = _safe_b64_decode(encoded)
                if not data:
                    continue
                import json
                info = json.loads(data)
                name = info.get('ps', info.get('remarks', ''))
                server = info.get('add', '')
                port = info.get('port', 0)

                if any(k in name for k in SKIP_KEYWORDS):
                    continue
                region_code, region_label = detect_region(name)
                net = info.get('net', 'tcp')
                ws_opts = {}
                if net == 'ws':
                    ws_opts = {
                        'path': info.get('path', '/'),
                        'headers': {'Host': info.get('host', '')},
                    }
                nodes.append({
                    'name': name or f'VMess-{server}',
                    'type': 'vmess',
                    'server': server,
                    'port': int(port),
                    'region_code': region_code,
                    'region_label': region_label,
                    'raw': {
                        'uuid': info.get('id', ''),
                        'alterId': int(info.get('aid', 0)),
                        'cipher': info.get('scy', info.get('cipher', 'auto')),
                        'network': net,
                        'tls': info.get('tls', ''),
                        'sni': info.get('sni', info.get('host', '')),
                        'ws-opts': ws_opts,
                    },
                })
            except Exception:
                continue

    return nodes


def _parse_vless_links(text: str) -> list[dict]:
    """解析VLESS链接列表"""
    nodes = []
    for line in _iter_proxy_lines(text):
        if line.startswith('vless://'):
            try:
                parsed = urllib.parse.urlsplit(line)
                uuid = urllib.parse.unquote(parsed.username or '')
                server = parsed.hostname or ''
                port = parsed.port
                if not uuid or not server or not port:
                    continue
                name = urllib.parse.unquote(parsed.fragment or '')
                params = dict(urllib.parse.parse_qsl(parsed.query))

                if any(k in name for k in SKIP_KEYWORDS):
                    continue
                region_code, region_label = detect_region(name)
                nodes.append({
                    'name': name or f'VLESS-{server}',
                    'type': 'vless',
                    'server': server,
                    'port': int(port),
                    'region_code': region_code,
                    'region_label': region_label,
                    'raw': {
                        'uuid': uuid,
                        'security': params.get('security', 'none'),
                        'flow': params.get('flow', ''),
                        'sni': params.get('sni', server),
                        'network': params.get('type', 'tcp'),
                        'pbk': params.get('pbk', ''),
                        'sid': params.get('sid', ''),
                        'fp': params.get('fp', 'chrome'),
                        'host': params.get('host', ''),
                        'path': params.get('path', ''),
                        'insecure': params.get('insecure', ''),
                    },
                })
            except Exception as e:
                logger.debug(f"[SubParser] VLESS解析失败: {e}")
                continue
    
    return nodes


def _parse_hysteria2_links(text: str) -> list[dict]:
    """解析Hysteria2链接列表"""
    nodes = []
    for line in _iter_proxy_lines(text):
        if line.startswith(('hysteria2://', 'hy2://')):
            try:
                parsed = urllib.parse.urlsplit(line)
                password = urllib.parse.unquote(parsed.username or '')
                server = parsed.hostname or ''
                port = parsed.port
                if not password or not server or not port:
                    continue
                name = urllib.parse.unquote(parsed.fragment or '')
                params = dict(urllib.parse.parse_qsl(parsed.query))

                if any(k in name for k in SKIP_KEYWORDS):
                    continue
                region_code, region_label = detect_region(name)
                nodes.append({
                    'name': name or f'Hysteria2-{server}',
                    'type': 'hysteria2',
                    'server': server,
                    'port': int(port),
                    'region_code': region_code,
                    'region_label': region_label,
                    'raw': {
                        'password': password,
                        'sni': params.get('sni', ''),
                        'insecure': str(params.get('insecure', '')).lower() in ('1', 'true', 'yes', 'on'),
                    },
                })
            except Exception as e:
                logger.debug(f"[SubParser] Hysteria2解析失败: {e}")
                continue
    
    return nodes


def _parse_anytls_links(text: str) -> list[dict]:
    nodes = []
    for line in _iter_proxy_lines(text):
        if line.startswith('anytls://'):
            try:
                parsed = urllib.parse.urlsplit(line)
                password = urllib.parse.unquote(parsed.username or '')
                server = parsed.hostname or ''
                port = parsed.port
                if not password or not server or not port:
                    continue
                name = urllib.parse.unquote(parsed.fragment or '')
                params = dict(urllib.parse.parse_qsl(parsed.query))
                insecure = str(params.get('insecure', '')).lower() in ('1', 'true', 'yes', 'on')

                if any(k in name for k in SKIP_KEYWORDS):
                    continue
                region_code, region_label = detect_region(name)
                nodes.append({
                    'name': name or f'AnyTLS-{server}',
                    'type': 'anytls',
                    'server': server,
                    'port': int(port),
                    'region_code': region_code,
                    'region_label': region_label,
                    'raw': {
                        'type': 'anytls',
                        'password': password,
                        'sni': params.get('sni', server),
                        'insecure': insecure,
                    },
                })
            except Exception as e:
                logger.debug(f"[SubParser] AnyTLS解析失败: {e}")
                continue

    return nodes


def _parse_json_nodes(text: str) -> list[dict]:
    try:
        data = json.loads(text)
    except Exception:
        return []

    if isinstance(data, dict):
        items = data.get('nodes', [])
        if not items and isinstance(data.get('proxies'), list):
            return _parse_clash_yaml(text)
    elif isinstance(data, list):
        items = data
    else:
        return []

    if not isinstance(items, list):
        return []

    raw_links = []
    for item in items:
        if isinstance(item, str) and '://' in item:
            raw_links.append(item)
        elif isinstance(item, dict) and isinstance(item.get('raw'), str) and '://' in item.get('raw', ''):
            raw_links.append(item['raw'])

    if raw_links:
        raw_text = '\n'.join(raw_links)
        return (
            _parse_anytls_links(raw_text)
            + _parse_vless_links(raw_text)
            + _parse_hysteria2_links(raw_text)
            + _parse_ss_links(raw_text)
        )

    nodes = []
    for item in items:
        if not isinstance(item, dict):
            continue

        name = str(item.get('name') or item.get('tag') or '')
        if any(k in name for k in SKIP_KEYWORDS):
            continue

        proto = str(item.get('protocol') or item.get('proxy_protocol') or item.get('type') or '').lower()
        server = str(item.get('server') or '')
        port = item.get('port', item.get('server_port', 0))
        if not proto or not server or not port:
            continue

        region_code, region_label = detect_region(name)
        raw = item.get('raw') if isinstance(item.get('raw'), dict) else {}
        if not raw:
            if proto == 'vless':
                raw = {
                    'uuid': item.get('username') or item.get('uuid') or item.get('id') or '',
                    'security': item.get('security', 'none'),
                    'flow': item.get('flow', ''),
                    'sni': item.get('sni', server),
                    'network': item.get('network') or item.get('type') or 'tcp',
                    'pbk': item.get('pbk', ''),
                    'sid': item.get('sid', ''),
                    'fp': item.get('fp', 'chrome'),
                    'host': item.get('host', ''),
                    'path': item.get('path', ''),
                    'insecure': item.get('insecure', ''),
                }
            elif proto in ('hysteria2', 'hy2', 'anytls'):
                raw = {
                    'type': proto,
                    'password': item.get('username') or item.get('password') or '',
                    'sni': item.get('sni', server),
                    'insecure': str(item.get('insecure', '')).lower() in ('1', 'true', 'yes', 'on'),
                }
            elif proto in ('ss', 'shadowsocks'):
                raw = {
                    'cipher': item.get('cipher') or item.get('method') or 'aes-128-gcm',
                    'password': item.get('password', ''),
                    'plugin': item.get('plugin', ''),
                }

        nodes.append({
            'name': name or f'{proto.upper()}-{server}',
            'type': proto,
            'server': server,
            'port': int(port),
            'region_code': region_code,
            'region_label': region_label,
            'raw': raw,
        })

    return nodes


def parse_subscription_text(text: str) -> dict:
    """
    解析订阅内容（自动识别格式）

    Returns:
        {
            "format": "clash_yaml" | "vless_hy2_links" | "ss_links" | "unknown",
            "total_nodes": int,
            "unique_servers": int,
            "nodes": [...],
            "servers": {server: [node_indices]},
            "regions": {code: {"label": str, "count": int}},
        }
    """
    text = text.strip()

    nodes = _parse_json_nodes(text)
    fmt = "json_nodes"

    # 尝试base64解码
    if not nodes:
        decoded = _try_base64_decode(text)
        if decoded:
            text = decoded

    # 尝试Clash YAML
    if not nodes:
        nodes = _parse_clash_yaml(text)
        fmt = "clash_yaml"

    # 尝试VLESS/Hysteria2/AnyTLS链接
    if not nodes:
        anytls_nodes = _parse_anytls_links(text)
        vless_nodes = _parse_vless_links(text)
        hy2_nodes = _parse_hysteria2_links(text)
        if anytls_nodes or vless_nodes or hy2_nodes:
            nodes = anytls_nodes + vless_nodes + hy2_nodes
            fmt = "proxy_links"

    # 尝试SS/VMess链接
    if not nodes:
        nodes = _parse_ss_links(text)
        fmt = "ss_links"

    if not nodes:
        return {"format": "unknown", "total_nodes": 0, "unique_servers": 0,
                "nodes": [], "servers": {}, "regions": {}}

    # 统计
    servers: dict[str, list[int]] = {}
    regions: dict[str, dict] = {}
    for i, n in enumerate(nodes):
        s = n['server']
        if s not in servers:
            servers[s] = []
        servers[s].append(i)

        rc = n['region_code']
        if rc not in regions:
            regions[rc] = {"label": n['region_label'], "count": 0}
        regions[rc]["count"] += 1

    return {
        "format": fmt,
        "total_nodes": len(nodes),
        "unique_servers": len(servers),
        "nodes": nodes,
        "servers": servers,
        "regions": regions,
    }


def _detect_subscription_response_kind(text: str) -> str:
    stripped = text.strip()
    if not stripped:
        return "empty"
    if stripped.startswith("{") or stripped.startswith("["):
        return "json"
    if any(stripped.startswith(prefix) for prefix in ("mixed-port:", "port:", "proxies:", "proxy-groups:", "rules:")):
        return "clash_yaml"
    if any(token in stripped for token in ("anytls://", "vless://", "hysteria2://", "ss://", "vmess://")):
        return "proxy_links"
    decoded = _try_base64_decode(stripped)
    if decoded and any(token in decoded for token in ("anytls://", "vless://", "hysteria2://", "ss://", "vmess://")):
        return "base64_proxy_links"
    return "other"


def _fetch_subscription_text(url: str, timeout: int) -> str:
    gateway = UrlFetchGateway(UrlFetchPolicy(
        timeout_seconds=max(1, int(timeout or 15)),
        max_response_bytes=4 * 1024 * 1024,
    ))
    response = gateway.request_sync(
        url,
        headers={
            'User-Agent': SUBSCRIPTION_FETCH_USER_AGENT,
            'Accept': '*/*',
        },
    )
    return response.text.strip()


def fetch_subscription(url: str, timeout: int = 15) -> dict:
    """
    从URL获取并解析订阅

    Returns:
        parse_subscription_text的结果 + "url" 字段
        出错时返回 {"error": "..."}
    """
    try:
        raw = _fetch_subscription_text(url, timeout)
        response_kind = _detect_subscription_response_kind(raw)

        result = parse_subscription_text(raw)
        result["url"] = url
        if result.get("total_nodes", 0) == 0:
            logger.warning(
                f"[SubParser] 订阅解析结果为空: url={url} raw_length={len(raw)} "
                f"response_kind={response_kind} parse_format={result.get('format')} "
                f"total_nodes={result.get('total_nodes')}"
            )
        return result

    except Exception as e:
        logger.warning(f"[SubParser] 订阅获取失败: {url} -> {e}")
        return {"error": f"订阅获取失败: {str(e)}", "url": url}
