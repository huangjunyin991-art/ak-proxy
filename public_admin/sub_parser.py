# -*- coding: utf-8 -*-
"""
VPN订阅解析模块
支持: Clash YAML / Base64 / VLESS / Hysteria2 / SS / VMess 链接
可通过URL自动获取，也可直接解析文本内容
"""

import base64
import logging
import ssl
import re
import urllib.parse
from typing import Optional
from urllib.request import Request, urlopen

logger = logging.getLogger("TransparentProxy")

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
        padded = text.strip() + '=' * (4 - len(text.strip()) % 4)
        decoded = base64.b64decode(padded).decode('utf-8')
        # 简单验证是否是可读文本
        if any(c in decoded for c in ['\n', '://', 'proxies']):
            return decoded
    except Exception:
        pass
    return None


def _parse_clash_yaml(text: str) -> list[dict]:
    """解析Clash YAML格式的订阅"""
    try:
        import yaml
        config = yaml.safe_load(text)
    except Exception:
        config = {}

    if not isinstance(config, dict):
        return []
    proxies = config.get('proxies', [])
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
    for line in text.strip().split('\n'):
        line = line.strip()
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
                    encoded, addr = rest.split('@', 1)
                    server, port = addr.rsplit(':', 1)
                    try:
                        creds = base64.b64decode(encoded + '==').decode()
                        method, password = creds.split(':', 1)
                    except Exception:
                        pass
                else:
                    decoded = base64.b64decode(rest + '==').decode()
                    creds, addr = decoded.rsplit('@', 1)
                    server, port = addr.rsplit(':', 1)
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
                    'raw': {'cipher': method, 'password': password},
                })
            except Exception:
                continue
        elif line.startswith('vmess://'):
            try:
                encoded = line[8:]
                data = base64.b64decode(encoded + '==').decode()
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
    for line in text.strip().split('\n'):
        line = line.strip()
        if line.startswith('vless://'):
            try:
                parts = line.replace('vless://', '').split('@')
                if len(parts) != 2:
                    continue
                
                uuid = parts[0]
                rest = parts[1]
                
                if '?' not in rest:
                    continue
                    
                server_port, params_and_name = rest.split('?', 1)
                server, port = server_port.rsplit(':', 1)
                
                name = ''
                if '#' in params_and_name:
                    params_str, name = params_and_name.split('#', 1)
                    name = urllib.parse.unquote(name)
                else:
                    params_str = params_and_name
                
                params = dict(urllib.parse.parse_qsl(params_str))

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
                    },
                })
            except Exception as e:
                logger.debug(f"[SubParser] VLESS解析失败: {e}")
                continue
    
    return nodes


def _parse_hysteria2_links(text: str) -> list[dict]:
    """解析Hysteria2链接列表"""
    nodes = []
    for line in text.strip().split('\n'):
        line = line.strip()
        if line.startswith('hysteria2://'):
            try:
                parts = line.replace('hysteria2://', '').split('@')
                if len(parts) != 2:
                    continue
                
                password = parts[0]
                rest = parts[1]
                
                if '?' in rest or '/' in rest:
                    server_port = rest.split('?')[0].split('/')[0]
                else:
                    server_port = rest.split('#')[0]
                    
                name = ''
                if '#' in rest:
                    params_str = rest.split('?')[1] if '?' in rest else ''
                    name = urllib.parse.unquote(rest.split('#')[1])
                
                server, port = server_port.rsplit(':', 1)
                
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
                    },
                })
            except Exception as e:
                logger.debug(f"[SubParser] Hysteria2解析失败: {e}")
                continue
    
    return nodes


def _parse_anytls_links(text: str) -> list[dict]:
    nodes = []
    for line in text.strip().split('\n'):
        line = line.strip()
        if line.startswith('anytls://'):
            try:
                parts = line.replace('anytls://', '', 1).split('@', 1)
                if len(parts) != 2:
                    continue

                password = parts[0]
                rest = parts[1]
                name = ''
                if '#' in rest:
                    rest, name = rest.split('#', 1)
                    name = urllib.parse.unquote(name)

                if '?' in rest:
                    server_port, params_str = rest.split('?', 1)
                else:
                    server_port = rest
                    params_str = ''

                server, port = server_port.rsplit(':', 1)
                params = dict(urllib.parse.parse_qsl(params_str))
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

    # 尝试base64解码
    decoded = _try_base64_decode(text)
    if decoded:
        text = decoded

    # 尝试Clash YAML
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


def fetch_subscription(url: str, timeout: int = 15) -> dict:
    """
    从URL获取并解析订阅

    Returns:
        parse_subscription_text的结果 + "url" 字段
        出错时返回 {"error": "..."}
    """
    try:
        ctx = ssl._create_unverified_context()
        req = Request(url, headers={
            'User-Agent': 'ClashForWindows/0.20.39 (Windows NT 10.0; Win64; x64)',
            'Accept': '*/*',
        })
        resp = urlopen(req, context=ctx, timeout=timeout)
        raw = resp.read().decode('utf-8').strip()

        result = parse_subscription_text(raw)
        result["url"] = url
        return result

    except Exception as e:
        logger.warning(f"[SubParser] 订阅获取失败: {url} -> {e}")
        return {"error": f"订阅获取失败: {str(e)}", "url": url}
