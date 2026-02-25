# -*- coding: utf-8 -*-
"""
订阅解析模块 - 从 vpn_tool/core.py 提取
支持 SS/VMess/Trojan/VLESS/SSR 及 Clash YAML 格式订阅解析
"""

import base64
import json
import logging
import re
import urllib.parse

try:
    import requests
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except ImportError:
    requests = None

try:
    import yaml
except ImportError:
    yaml = None

logger = logging.getLogger("SubscriptionParser")


class ProxyNode:
    """代理节点数据模型"""

    def __init__(self, name="", host="", port=0, protocol="unknown",
                 method="", password="", uuid="", alter_id=0,
                 network="tcp", tls=False, extra=None):
        self.name = name
        self.host = host
        self.port = int(port) if port else 0
        self.protocol = protocol
        self.method = method
        self.password = password
        self.uuid = uuid
        self.alter_id = alter_id
        self.network = network
        self.tls = tls
        self.extra = extra or {}
        self.latency = -1
        self.is_connected = False

    def to_dict(self):
        return {
            "name": self.name, "host": self.host, "port": self.port,
            "protocol": self.protocol, "method": self.method,
            "password": self.password, "uuid": self.uuid,
            "alter_id": self.alter_id, "network": self.network,
            "tls": self.tls, "extra": self.extra,
            "latency": self.latency
        }

    def latency_str(self):
        if self.latency < 0:
            return "超时"
        return f"{self.latency}ms"


class SubscriptionParser:
    """订阅链接解析器，支持 SS/VMess/Trojan/VLESS/SSR"""

    @staticmethod
    def safe_b64decode(s):
        s = s.strip()
        padding = 4 - len(s) % 4
        if padding != 4:
            s += '=' * padding
        try:
            return base64.urlsafe_b64decode(s).decode('utf-8', errors='ignore')
        except Exception:
            try:
                return base64.b64decode(s).decode('utf-8', errors='ignore')
            except Exception:
                return ""

    USER_AGENTS = [
        "clash.meta",
        "clash-verge/v1.7.7",
        "ClashMeta",
        "v2rayN/6.0",
        "Stash/2.4.0",
        "ClashForWindows/0.20.0",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ]

    @classmethod
    def _fetch_content(cls, url, ua):
        """用指定 UA 获取订阅内容"""
        resp = requests.get(url, timeout=30, headers={"User-Agent": ua}, verify=False)
        resp.raise_for_status()
        content = resp.content
        for enc in ('utf-8', 'gbk', 'latin-1'):
            try:
                return content.decode(enc)
            except (UnicodeDecodeError, AttributeError):
                pass
        return content.decode('utf-8', errors='replace')

    @classmethod
    def _has_real_nodes(cls, nodes):
        """检查是否包含真实节点（非 127.0.0.1 占位节点）"""
        return any(n.host not in ('127.0.0.1', 'localhost', '0.0.0.0') for n in nodes)

    @classmethod
    def fetch_and_parse(cls, url):
        """获取订阅链接并解析节点，返回 (nodes, error_msg)"""
        nodes = []
        if not requests:
            return nodes, "requests 库未安装"

        last_error = None
        for ua in cls.USER_AGENTS:
            try:
                logger.info(f"尝试 UA: {ua}")
                text = cls._fetch_content(url, ua).strip()

                if not text:
                    last_error = "订阅返回内容为空"
                    continue

                parsed_nodes, err = cls._parse_content(text)

                if err and not parsed_nodes:
                    last_error = err
                    continue

                if parsed_nodes and cls._has_real_nodes(parsed_nodes):
                    logger.info(f"使用 UA '{ua}' 成功获取 {len(parsed_nodes)} 个节点")
                    return parsed_nodes, None

                if parsed_nodes:
                    nodes = parsed_nodes
                    logger.info(f"UA '{ua}' 返回 {len(parsed_nodes)} 个节点但均为占位节点，尝试下一个 UA")
                    continue

            except requests.exceptions.Timeout:
                last_error = "请求超时（30秒），请检查网络连接"
            except requests.exceptions.ConnectionError as e:
                last_error = f"连接失败: {e}"
                break
            except requests.exceptions.HTTPError as e:
                last_error = f"HTTP错误: {e}"
            except Exception as e:
                logger.error(f"订阅获取失败 (UA={ua}): {e}")
                last_error = f"获取失败: {e}"

        if nodes:
            return nodes, None
        return nodes, last_error or "所有 User-Agent 均未能获取到有效节点"

    @classmethod
    def _parse_content(cls, text):
        """解析订阅内容（自动检测格式），返回 (nodes, error_msg)"""
        nodes = []

        if text.lstrip().startswith(('proxies:', 'port:', 'mixed-port:', 'socks-port:', 'allow-lan:')):
            return cls._parse_clash_yaml(text)

        decoded = cls.safe_b64decode(text)
        if decoded and ('\n' in decoded or decoded.startswith(('ss://', 'vmess://', 'trojan://', 'vless://', 'ssr://'))):
            lines = decoded.strip().split('\n')
        else:
            lines = text.strip().split('\n')

        parsed_count = 0
        for line in lines:
            line = line.strip()
            if not line:
                continue
            parsed_count += 1
            node = cls.parse_uri(line)
            if node:
                nodes.append(node)

        if not nodes and parsed_count > 0:
            return nodes, f"解析了 {parsed_count} 行但未识别到有效节点"

        return nodes, None

    @classmethod
    def _parse_clash_yaml(cls, text):
        """解析 Clash YAML 格式订阅"""
        nodes = []
        if not yaml:
            return nodes, "PyYAML 未安装，无法解析 Clash 格式 (pip install pyyaml)"
        try:
            data = yaml.safe_load(text)
            if not isinstance(data, dict):
                return nodes, "YAML 解析失败，内容格式不正确"

            proxies = data.get('proxies', [])
            if not proxies:
                return nodes, "Clash 配置中没有找到 proxies 字段"

            for p in proxies:
                if not isinstance(p, dict):
                    continue
                node = cls._clash_proxy_to_node(p)
                if node:
                    nodes.append(node)

            if not nodes:
                return nodes, f"找到 {len(proxies)} 个代理配置但均无法解析（可能是不支持的协议类型）"

            logger.info(f"Clash YAML 解析成功: {len(nodes)} 个有效节点")
            return nodes, None
        except yaml.YAMLError as e:
            return nodes, f"YAML 解析错误: {e}"
        except Exception as e:
            return nodes, f"Clash 解析失败: {e}"

    @classmethod
    def _clash_proxy_to_node(cls, p):
        """将 Clash 代理配置转换为 ProxyNode"""
        ptype = p.get('type', '').lower()
        server = p.get('server', '')
        port = p.get('port', 0)
        name = p.get('name', '')

        if not server or not port:
            return None

        if ptype == 'ss':
            return ProxyNode(
                name=name, host=server, port=port, protocol='ss',
                method=p.get('cipher', ''), password=str(p.get('password', '')),
            )
        elif ptype == 'vmess':
            net = p.get('network', 'tcp')
            tls = p.get('tls', False)
            extra = {}
            ws_opts = p.get('ws-opts', {}) or {}
            if net == 'ws' and ws_opts:
                extra['path'] = ws_opts.get('path', '/')
                extra['host'] = (ws_opts.get('headers', {}) or {}).get('Host', '')
            grpc_opts = p.get('grpc-opts', {}) or {}
            if net == 'grpc' and grpc_opts:
                extra['path'] = grpc_opts.get('grpc-service-name', '')
            extra['sni'] = p.get('servername', server)
            return ProxyNode(
                name=name, host=server, port=port, protocol='vmess',
                uuid=p.get('uuid', ''), alter_id=int(p.get('alterId', 0)),
                method=p.get('cipher', 'auto'), network=net, tls=tls, extra=extra,
            )
        elif ptype == 'trojan':
            extra = {'sni': p.get('sni', server)}
            net = p.get('network', 'tcp')
            ws_opts = p.get('ws-opts', {}) or {}
            if net == 'ws' and ws_opts:
                extra['path'] = ws_opts.get('path', '/')
                extra['host'] = (ws_opts.get('headers', {}) or {}).get('Host', '')
            return ProxyNode(
                name=name, host=server, port=port, protocol='trojan',
                password=str(p.get('password', '')), network=net, tls=True, extra=extra,
            )
        elif ptype == 'vless':
            net = p.get('network', 'tcp')
            extra = {
                'flow': p.get('flow', ''),
                'sni': p.get('servername', server),
                'security': 'reality' if p.get('reality-opts') else ('tls' if p.get('tls', False) else 'none'),
            }
            reality = p.get('reality-opts', {}) or {}
            if reality:
                extra['pbk'] = reality.get('public-key', '')
                extra['sid'] = reality.get('short-id', '')
            ws_opts = p.get('ws-opts', {}) or {}
            if net == 'ws' and ws_opts:
                extra['path'] = ws_opts.get('path', '/')
                extra['host'] = (ws_opts.get('headers', {}) or {}).get('Host', '')
            return ProxyNode(
                name=name, host=server, port=port, protocol='vless',
                uuid=p.get('uuid', ''), network=net,
                tls=p.get('tls', False), extra=extra,
            )
        elif ptype == 'ssr':
            return ProxyNode(
                name=name, host=server, port=port, protocol='ssr',
                method=p.get('cipher', ''), password=str(p.get('password', '')),
                extra={
                    'ssr_protocol': p.get('protocol', ''),
                    'obfs': p.get('obfs', ''),
                    'obfs_param': p.get('obfs-param', ''),
                    'protocol_param': p.get('protocol-param', ''),
                }
            )
        elif ptype == 'hysteria2' or ptype == 'hy2':
            return ProxyNode(
                name=name, host=server, port=port, protocol='hysteria2',
                password=str(p.get('password', '')), tls=True,
                extra={'sni': p.get('sni', server)}
            )
        return None

    @classmethod
    def parse_uri(cls, uri):
        uri = uri.strip()
        if uri.startswith("ss://"):
            return cls._parse_ss(uri)
        elif uri.startswith("vmess://"):
            return cls._parse_vmess(uri)
        elif uri.startswith("trojan://"):
            return cls._parse_trojan(uri)
        elif uri.startswith("vless://"):
            return cls._parse_vless(uri)
        elif uri.startswith("ssr://"):
            return cls._parse_ssr(uri)
        return None

    @classmethod
    def _parse_ss(cls, uri):
        try:
            uri = uri[5:]
            name = ""
            if '#' in uri:
                uri, name = uri.rsplit('#', 1)
                name = urllib.parse.unquote(name)

            if '@' in uri:
                userinfo, hostinfo = uri.rsplit('@', 1)
                decoded = cls.safe_b64decode(userinfo)
                if ':' in decoded:
                    method, password = decoded.split(':', 1)
                elif ':' in userinfo:
                    method, password = userinfo.split(':', 1)
                else:
                    return None
                host_port = hostinfo.split('?')[0]
                if ':' in host_port:
                    host, port = host_port.rsplit(':', 1)
                else:
                    return None
            else:
                decoded = cls.safe_b64decode(uri)
                if not decoded:
                    return None
                match = re.match(r'(.+?):(.+?)@(.+?):(\d+)', decoded)
                if not match:
                    return None
                method, password, host, port = match.groups()

            return ProxyNode(
                name=name or f"SS-{host}", host=host, port=int(port),
                protocol="ss", method=method, password=password
            )
        except Exception as e:
            logger.debug(f"SS解析失败: {e}")
            return None

    @classmethod
    def _parse_vmess(cls, uri):
        try:
            encoded = uri[8:]
            decoded = cls.safe_b64decode(encoded)
            if not decoded:
                return None
            config = json.loads(decoded)
            return ProxyNode(
                name=config.get("ps", f"VMess-{config.get('add', '')}"),
                host=config.get("add", ""),
                port=int(config.get("port", 0)),
                protocol="vmess",
                uuid=config.get("id", ""),
                alter_id=int(config.get("aid", 0)),
                network=config.get("net", "tcp"),
                tls=config.get("tls", "") == "tls",
                extra={
                    "type": config.get("type", "none"),
                    "host": config.get("host", ""),
                    "path": config.get("path", ""),
                    "sni": config.get("sni", ""),
                }
            )
        except Exception as e:
            logger.debug(f"VMess解析失败: {e}")
            return None

    @classmethod
    def _parse_trojan(cls, uri):
        try:
            uri = uri[9:]
            name = ""
            if '#' in uri:
                uri, name = uri.rsplit('#', 1)
                name = urllib.parse.unquote(name)
            parsed = urllib.parse.urlparse(f"trojan://{uri}")
            password = parsed.username or ""
            host = parsed.hostname or ""
            port = parsed.port or 443
            params = urllib.parse.parse_qs(parsed.query)
            return ProxyNode(
                name=name or f"Trojan-{host}", host=host, port=port,
                protocol="trojan", password=password, tls=True,
                extra={
                    "sni": params.get("sni", [""])[0],
                    "type": params.get("type", ["tcp"])[0],
                }
            )
        except Exception as e:
            logger.debug(f"Trojan解析失败: {e}")
            return None

    @classmethod
    def _parse_vless(cls, uri):
        try:
            uri = uri[8:]
            name = ""
            if '#' in uri:
                uri, name = uri.rsplit('#', 1)
                name = urllib.parse.unquote(name)
            parsed = urllib.parse.urlparse(f"vless://{uri}")
            uid = parsed.username or ""
            host = parsed.hostname or ""
            port = parsed.port or 443
            params = urllib.parse.parse_qs(parsed.query)
            return ProxyNode(
                name=name or f"VLESS-{host}", host=host, port=port,
                protocol="vless", uuid=uid,
                network=params.get("type", ["tcp"])[0],
                tls=params.get("security", ["none"])[0] != "none",
                extra={
                    "flow": params.get("flow", [""])[0],
                    "sni": params.get("sni", [""])[0],
                    "fp": params.get("fp", [""])[0],
                    "pbk": params.get("pbk", [""])[0],
                    "sid": params.get("sid", [""])[0],
                    "security": params.get("security", ["none"])[0],
                }
            )
        except Exception as e:
            logger.debug(f"VLESS解析失败: {e}")
            return None

    @classmethod
    def _parse_ssr(cls, uri):
        try:
            encoded = uri[6:]
            decoded = cls.safe_b64decode(encoded)
            if not decoded:
                return None
            parts = decoded.split('/?')
            main = parts[0]
            params_str = parts[1] if len(parts) > 1 else ""
            segments = main.split(':')
            if len(segments) < 6:
                return None
            host = segments[0]
            port = int(segments[1])
            ssr_protocol = segments[2]
            method = segments[3]
            obfs = segments[4]
            password = cls.safe_b64decode(segments[5])
            params = urllib.parse.parse_qs(params_str)
            name = cls.safe_b64decode(params.get("remarks", [""])[0]) or f"SSR-{host}"
            return ProxyNode(
                name=name, host=host, port=port,
                protocol="ssr", method=method, password=password,
                extra={
                    "ssr_protocol": ssr_protocol, "obfs": obfs,
                    "obfs_param": cls.safe_b64decode(params.get("obfsparam", [""])[0]),
                    "protocol_param": cls.safe_b64decode(params.get("protoparam", [""])[0]),
                }
            )
        except Exception as e:
            logger.debug(f"SSR解析失败: {e}")
            return None
