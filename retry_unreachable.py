# -*- coding: utf-8 -*-
"""重试上次不可达的节点（使用更长超时）"""
import io, json, sys, time, threading
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

MT_DIR = r'd:\pythonProject\auto_sell_systemV6 - 正在更新\multi_tunnel'
SB_DIR = r'd:\pythonProject\auto_sell_systemV6 - 正在更新\sing-box'
sys.path.insert(0, str(Path(MT_DIR).parent))

from multi_tunnel import singbox, ip_dedup

# 读取上次检测缓存
cache = json.loads(Path('ip_dedup_cache.json').read_text(encoding='utf-8'))
BASE_PORT = cache['base_port']
unreachable = [
    p for p in range(BASE_PORT, BASE_PORT + cache['num_ports'])
    if str(p) not in cache['ip_map']
]
print(f'上次不可达端口 ({len(unreachable)} 个): {unreachable}')

# sing-box 仍在上次的配置，直接重新检测（无需重启）
# 只需重启 sing-box（上次已 stop_service）
singbox.configure(singbox_dir=SB_DIR, singbox_bin='sing-box.exe')
nodes_data = json.loads(Path('check_sub_result.json').read_text(encoding='utf-8'))
nodes = nodes_data['nodes']

print('重启 sing-box...')
result = singbox.apply_nodes(nodes, base_port=BASE_PORT)
print(f'apply_nodes: {result["message"]}')
if not result['success']:
    sys.exit(1)

print('等待 sing-box 就绪 (5s)...')
time.sleep(5)

# 只检测不可达端口，超时 30s
TIMEOUT = 30.0
print(f'重试 {len(unreachable)} 个端口 (timeout={TIMEOUT}s)...')

import urllib3, requests
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

_IP_CHECK_ENDPOINTS = [
    ("https://api4.ipify.org",        "text", None),
    ("https://ipv4.icanhazip.com",    "text", None),
    ("http://checkip.amazonaws.com",  "text", None),
]

port_ip = {}
lock = threading.Lock()

def _probe(port):
    proxy = f"socks5h://127.0.0.1:{port}"
    proxies = {"http": proxy, "https": proxy}
    for url, fmt, field in _IP_CHECK_ENDPOINTS:
        try:
            r = requests.get(url, proxies=proxies, timeout=TIMEOUT, verify=False)
            text = r.text.strip()
            if text:
                with lock:
                    port_ip[port] = text
                return
        except Exception:
            continue
    with lock:
        port_ip[port] = None

threads = [threading.Thread(target=_probe, args=(p,), daemon=True) for p in unreachable]
for t in threads: t.start()
for t in threads: t.join(timeout=TIMEOUT + 10)

print('\n=== 重试结果 ===')
recovered = []
still_dead = []
for p in unreachable:
    ip = port_ip.get(p)
    node_idx = p - BASE_PORT
    name = nodes[node_idx]['name'] if node_idx < len(nodes) else '?'
    if ip:
        print(f'  ✓ :{p} {name} -> {ip}')
        recovered.append((p, ip))
    else:
        print(f'  ✗ :{p} {name} -> 仍不可达')
        still_dead.append(p)

print(f'\n恢复: {len(recovered)}, 仍不可达: {len(still_dead)}')
print(f'最终独立 IP 总数: {len(cache["unique_ports"]) + len(recovered)}')

# 更新缓存
for p, ip in recovered:
    cache['ip_map'][str(p)] = ip
    cache['unique_ports'].append(p)
cache['unique_ports'].sort()
Path('ip_dedup_cache.json').write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding='utf-8')
print('缓存已更新')

singbox.stop_service()
