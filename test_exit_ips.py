"""
Test actual exit IPs for all unique servers in the feitu subscription.
1. Fetch subscription (Clash YAML format)
2. Start mihomo with the config
3. Use mihomo REST API to switch between nodes
4. For each node, check exit IP via ip.sb
"""
import urllib.request, ssl, yaml, json, time, subprocess, sys, os, signal

SUB_URL = 'https://ft-5jki2k6d.tutunode.com/gateway/feitu?token=c3f4ab56beeaceb2b7e9df121c7fb1c4'
MIHOMO_BIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mihomo.exe')
CONFIG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mihomo_test')
CONFIG_FILE = os.path.join(CONFIG_DIR, 'config.yaml')
PROXY_PORT = 17890
API_PORT = 19090
API_BASE = f'http://127.0.0.1:{API_PORT}'

os.makedirs(CONFIG_DIR, exist_ok=True)

# Step 1: Fetch subscription
print('[1/4] Fetching subscription...')
ctx = ssl._create_unverified_context()
req = urllib.request.Request(SUB_URL, headers={'User-Agent': 'ClashForWindows/0.20.0'})
resp = urllib.request.urlopen(req, context=ctx, timeout=15)
raw = resp.read().decode('utf-8')

config = yaml.safe_load(raw)

# Build minimal config - only keep proxies, skip all rules/dns that need geodata
minimal_config = {
    'mixed-port': PROXY_PORT,
    'external-controller': f'127.0.0.1:{API_PORT}',
    'mode': 'global',
    'log-level': 'warning',
    'allow-lan': False,
    'ipv6': False,
    'geodata-mode': True,
    'geo-auto-update': False,
    'proxies': config.get('proxies', []),
    'proxy-groups': [{
        'name': 'GLOBAL',
        'type': 'select',
        'proxies': [p['name'] for p in config.get('proxies', []) if p.get('name')]
    }],
    'rules': ['MATCH,GLOBAL'],
    'dns': {
        'enable': False
    }
}

# Save config
with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
    yaml.dump(minimal_config, f, allow_unicode=True, default_flow_style=False)

print(f'  Config saved. {len(config.get("proxies", []))} proxies found.')

# Identify unique servers and pick one node per server
proxies = config.get('proxies', [])
server_map = {}  # server -> first proxy name
for p in proxies:
    server = p.get('server', '')
    name = p.get('name', '')
    if server and name and server not in server_map:
        # Skip info nodes
        if any(k in name for k in ['剩余', '套餐', '到期', '流量', '超时']):
            continue
        server_map[server] = name

print(f'  Unique servers: {len(server_map)}')
for srv, name in server_map.items():
    print(f'    {srv} -> {name}')

# Step 2: Start mihomo
print(f'\n[2/4] Starting mihomo (port {PROXY_PORT}, API {API_PORT})...')

# Kill any existing mihomo
subprocess.run(['taskkill', '/f', '/im', 'mihomo.exe'], 
               capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
time.sleep(1)

log_file = open(os.path.join(CONFIG_DIR, 'mihomo.log'), 'w')
proc = subprocess.Popen(
    [MIHOMO_BIN, '-d', CONFIG_DIR],
    stdout=log_file, stderr=subprocess.STDOUT,
    creationflags=subprocess.CREATE_NO_WINDOW
)

# Wait for mihomo to start, with retries
started = False
for wait in range(10):
    time.sleep(2)
    if proc.poll() is not None:
        print(f'  ERROR: mihomo exited with code {proc.returncode}')
        log_file.close()
        with open(os.path.join(CONFIG_DIR, 'mihomo.log'), 'r', errors='replace') as f:
            print(f'  Log: {f.read()[:800]}')
        sys.exit(1)
    try:
        api_req = urllib.request.Request(f'{API_BASE}/proxies')
        api_resp = urllib.request.urlopen(api_req, timeout=3)
        data = json.loads(api_resp.read())
        if 'proxies' in data:
            started = True
            print(f'  mihomo started! ({(wait+1)*2}s) Found {len(data["proxies"])} proxy entries.')
            break
    except:
        print(f'  waiting... ({(wait+1)*2}s)')

if not started:
    print(f'  ERROR: mihomo failed to start after 20s')
    proc.kill()
    log_file.close()
    with open(os.path.join(CONFIG_DIR, 'mihomo.log'), 'r', errors='replace') as f:
        print(f'  Log: {f.read()[:800]}')
    sys.exit(1)

# Step 3: Get proxy groups and find the global/GLOBAL selector
print(f'\n[3/4] Getting proxy groups...')
try:
    api_req = urllib.request.Request(f'{API_BASE}/proxies')
    api_resp = urllib.request.urlopen(api_req, timeout=5)
    proxies_info = json.loads(api_resp.read())
    
    # Find GLOBAL selector
    global_group = None
    for name, info in proxies_info.get('proxies', {}).items():
        if name.upper() == 'GLOBAL' and info.get('type') == 'Selector':
            global_group = name
            break
    
    if not global_group:
        # Try to find any selector group
        for name, info in proxies_info.get('proxies', {}).items():
            if info.get('type') == 'Selector':
                global_group = name
                print(f'  Using selector group: {name}')
                break
    
    if not global_group:
        print('  ERROR: No selector group found')
        proc.kill()
        sys.exit(1)
    else:
        print(f'  Global selector: {global_group}')

except Exception as e:
    print(f'  ERROR: {e}')
    proc.kill()
    sys.exit(1)

# Step 4: Test each node's exit IP
print(f'\n[4/4] Testing exit IPs for {len(server_map)} unique servers...')
print(f'       (switching node -> checking IP via ip.sb)')
print()

results = {}
proxy_handler = urllib.request.ProxyHandler({
    'http': f'http://127.0.0.1:{PROXY_PORT}',
    'https': f'http://127.0.0.1:{PROXY_PORT}',
})
opener = urllib.request.build_opener(proxy_handler)

for i, (server, node_name) in enumerate(server_map.items()):
    short = server.replace('.51feitu.com', '')
    print(f'  [{i+1}/{len(server_map)}] {short} ({node_name})')
    
    # Switch to this node via API
    try:
        switch_data = json.dumps({'name': node_name}).encode('utf-8')
        switch_req = urllib.request.Request(
            f'{API_BASE}/proxies/{urllib.parse.quote(global_group)}',
            data=switch_data,
            headers={'Content-Type': 'application/json'},
            method='PUT'
        )
        urllib.request.urlopen(switch_req, timeout=5)
        time.sleep(1)  # Wait for switch
    except Exception as e:
        print(f'    FAIL: Cannot switch node: {e}')
        results[server] = ('FAIL', None, str(e))
        continue
    
    # Check exit IP
    exit_ip = None
    for attempt in range(3):
        try:
            ip_req = urllib.request.Request('http://ip.sb', headers={'User-Agent': 'curl/7.88'})
            ip_resp = opener.open(ip_req, timeout=10)
            exit_ip = ip_resp.read().decode('utf-8').strip()
            break
        except Exception as e:
            if attempt < 2:
                time.sleep(2)
            else:
                print(f'    FAIL: Cannot get exit IP: {e}')
                results[server] = ('FAIL', None, str(e))
    
    if exit_ip:
        results[server] = ('OK', exit_ip, node_name)
        print(f'    Exit IP: {exit_ip}')

# Cleanup
print(f'\nStopping mihomo...')
proc.kill()
proc.wait()

# Summary
print(f'\n{"="*60}')
print(f'=== 出口IP测试结果 ===')
print(f'{"="*60}')

ok_count = sum(1 for v in results.values() if v[0] == 'OK')
unique_ips = set(v[1] for v in results.values() if v[0] == 'OK' and v[1])

print(f'成功测试: {ok_count}/{len(server_map)}')
print(f'不同出口IP: {len(unique_ips)}')
print()

for server, (status, ip, info) in sorted(results.items()):
    short = server.replace('.51feitu.com', '')
    if status == 'OK':
        print(f'  OK   {short:30s} -> {ip}')
    else:
        print(f'  FAIL {short:30s} -> {info}')

print()
print(f'唯一出口IP列表:')
for ip in sorted(unique_ips):
    # Count how many servers use this IP
    count = sum(1 for v in results.values() if v[1] == ip)
    print(f'  {ip} (被 {count} 个服务器使用)')

print()
if len(unique_ips) >= 5:
    print(f'有 {len(unique_ips)} 个不同出口IP，足够做负载均衡！')
elif len(unique_ips) >= 3:
    print(f'有 {len(unique_ips)} 个不同出口IP，勉强可用，建议增加订阅。')
else:
    print(f'只有 {len(unique_ips)} 个不同出口IP，建议多买几家机场增加IP数量。')
