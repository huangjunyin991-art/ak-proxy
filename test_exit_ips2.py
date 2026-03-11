"""Test exit IPs by switching nodes via mihomo API (mihomo already running)"""
import urllib.request, urllib.parse, json, time, sys

API_BASE = 'http://127.0.0.1:19090'
PROXY_PORT = 17890

# Step 1: Get all proxies from API
print('=== 出口IP测试 ===')
print()

req = urllib.request.Request(f'{API_BASE}/proxies')
resp = urllib.request.urlopen(req, timeout=5)
data = json.loads(resp.read().decode('utf-8'))

all_proxies = data.get('proxies', {})
print(f'API返回 {len(all_proxies)} 个代理条目')

# Find GLOBAL selector
global_group = None
for name, info in all_proxies.items():
    if name == 'GLOBAL' and info.get('type') == 'Selector':
        global_group = 'GLOBAL'
        break

if not global_group:
    for name, info in all_proxies.items():
        if info.get('type') == 'Selector':
            global_group = name
            break

print(f'使用选择器: {global_group}')

# Identify proxy nodes grouped by server
# We need to match proxy names to their server addresses
# Get proxy details for each node
server_to_node = {}
node_details = {}

for name, info in all_proxies.items():
    ptype = info.get('type', '')
    if ptype in ('Shadowsocks', 'Vmess', 'Trojan', 'Vless'):
        node_details[name] = info

# We need to read the config to get server mappings since API doesn't expose server address
import yaml, os
config_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mihomo_test', 'config.yaml')
with open(config_file, 'r', encoding='utf-8') as f:
    config = yaml.safe_load(f)

for p in config.get('proxies', []):
    server = p.get('server', '')
    name = p.get('name', '')
    if not server or not name:
        continue
    if any(k in name for k in ['剩余', '套餐', '到期', '流量', '超时']):
        continue
    if server not in server_to_node:
        server_to_node[server] = name

print(f'唯一服务器: {len(server_to_node)}')
print()

# Step 2: For each server, switch to its node, test exit IP
proxy_handler = urllib.request.ProxyHandler({
    'http': f'http://127.0.0.1:{PROXY_PORT}',
    'https': f'http://127.0.0.1:{PROXY_PORT}',
})
opener = urllib.request.build_opener(proxy_handler)

results = {}
for i, (server, node_name) in enumerate(server_to_node.items()):
    short = server.replace('.51feitu.com', '')
    print(f'[{i+1}/{len(server_to_node)}] {short} -> {node_name}')
    
    # Switch node
    try:
        encoded_group = urllib.parse.quote(global_group)
        switch_data = json.dumps({'name': node_name}).encode('utf-8')
        switch_req = urllib.request.Request(
            f'{API_BASE}/proxies/{encoded_group}',
            data=switch_data,
            headers={'Content-Type': 'application/json'},
            method='PUT'
        )
        urllib.request.urlopen(switch_req, timeout=5)
        time.sleep(2)
    except Exception as e:
        print(f'  切换失败: {e}')
        results[server] = ('FAIL', None, f'switch error: {e}')
        continue
    
    # Test exit IP (try multiple services)
    exit_ip = None
    services = [
        ('http://ip.sb', {'User-Agent': 'curl/7.88'}),
        ('http://ifconfig.me/ip', {'User-Agent': 'curl/7.88'}),
        ('http://api.ipify.org', {}),
    ]
    
    for svc_url, headers in services:
        for attempt in range(2):
            try:
                ip_req = urllib.request.Request(svc_url, headers=headers)
                ip_resp = opener.open(ip_req, timeout=10)
                exit_ip = ip_resp.read().decode('utf-8').strip()
                if exit_ip and len(exit_ip) < 50:
                    break
                exit_ip = None
            except Exception as e:
                if attempt == 0:
                    time.sleep(1)
        if exit_ip:
            break
    
    if exit_ip:
        results[server] = ('OK', exit_ip, node_name)
        print(f'  出口IP: {exit_ip}')
    else:
        results[server] = ('FAIL', None, 'cannot get exit IP')
        print(f'  获取出口IP失败')
    print()

# Summary
print(f'{"="*60}')
print(f'=== 测试结果汇总 ===')
print(f'{"="*60}')

ok_count = sum(1 for v in results.values() if v[0] == 'OK')
unique_ips = set(v[1] for v in results.values() if v[0] == 'OK' and v[1])

print(f'成功: {ok_count}/{len(server_to_node)}')
print(f'不同出口IP数: {len(unique_ips)}')
print()

for server in sorted(results.keys()):
    status, ip, info = results[server]
    short = server.replace('.51feitu.com', '')
    if status == 'OK':
        print(f'  OK   {short:30s} -> {ip}')
    else:
        print(f'  FAIL {short:30s} -> {info}')

print()
print(f'唯一出口IP:')
for ip in sorted(unique_ips):
    users = [s.replace('.51feitu.com', '') for s, v in results.items() if v[1] == ip]
    print(f'  {ip}  <- {", ".join(users)}')

print()
if len(unique_ips) >= 5:
    print(f'结论: {len(unique_ips)} 个不同出口IP，非常适合做负载均衡！')
elif len(unique_ips) >= 3:
    print(f'结论: {len(unique_ips)} 个不同出口IP，可用但建议增加。')
else:
    print(f'结论: 只有 {len(unique_ips)} 个不同出口IP，建议多买几家机场。')
