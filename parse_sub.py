import base64, urllib.parse, json, re, sys
import urllib.request, ssl

url = 'https://ft-5jki2k6d.tutunode.com/gateway/feitu?token=c3f4ab56beeaceb2b7e9df121c7fb1c4'
ctx = ssl._create_unverified_context()
req = urllib.request.Request(url, headers={'User-Agent': 'ClashForWindows/0.20.0'})
resp = urllib.request.urlopen(req, context=ctx, timeout=15)
full_b64 = resp.read().decode('utf-8').strip()

try:
    raw = base64.b64decode(full_b64).decode('utf-8')
except:
    raw = full_b64

# Parse Clash YAML - extract proxies section
import yaml
try:
    config = yaml.safe_load(raw)
except:
    # manual parse
    config = {}

proxies = config.get('proxies', [])
regions = {}
protocols = {}
nodes = []
servers = set()

for p in proxies:
    name = p.get('name', '')
    proto = p.get('type', 'unknown').upper()
    server = p.get('server', '')
    port = p.get('port', '')
    
    region = 'Other'
    if any(k in name for k in ['香港', '🇭🇰']):
        region = 'HK(香港)'
    elif any(k in name for k in ['新加坡', '🇸🇬']):
        region = 'SG(新加坡)'
    elif any(k in name for k in ['日本', '🇯🇵']):
        region = 'JP(日本)'
    elif any(k in name for k in ['美国', '美國', '🇺🇸']):
        region = 'US(美国)'
    elif any(k in name for k in ['台湾', '台灣', '🇹🇼']):
        region = 'TW(台湾)'
    elif any(k in name for k in ['加拿大']):
        region = 'CA(加拿大)'
    elif any(k in name for k in ['俄罗斯', '🇷🇺']):
        region = 'RU(俄罗斯)'
    elif any(k in name for k in ['韩国', '🇰🇷']):
        region = 'KR(韩国)'
    elif any(k in name for k in ['英国', '🇬🇧']):
        region = 'UK(英国)'
    elif any(k in name for k in ['德国', '🇩🇪']):
        region = 'DE(德国)'
    elif any(k in name for k in ['法国', '🇫🇷']):
        region = 'FR(法国)'
    elif any(k in name for k in ['荷兰', '🇳🇱']):
        region = 'NL(荷兰)'
    elif any(k in name for k in ['澳大利亚', '🇦🇺']):
        region = 'AU(澳大利亚)'
    elif any(k in name for k in ['土耳其', '🇹🇷']):
        region = 'TR(土耳其)'
    elif any(k in name for k in ['巴西', '🇧🇷']):
        region = 'BR(巴西)'
    elif any(k in name for k in ['菲律宾', '🇵🇭']):
        region = 'PH(菲律宾)'
    elif any(k in name for k in ['泰国', '🇹🇭']):
        region = 'TH(泰国)'
    elif any(k in name for k in ['越南', '🇻🇳']):
        region = 'VN(越南)'
    elif any(k in name for k in ['马来西亚', '🇲🇾']):
        region = 'MY(马来西亚)'
    elif any(k in name for k in ['印尼', '🇮🇩']):
        region = 'ID(印尼)'
    
    if any(k in name for k in ['剩余', '套餐', '到期', '流量']):
        continue
    
    nodes.append((proto, region, name, server, port))
    protocols[proto] = protocols.get(proto, 0) + 1
    regions[region] = regions.get(region, 0) + 1
    servers.add(server)

print(f'=== 飞兔 订阅 - 11台服务器稳定性测试 ===')
print(f'总节点: {len(nodes)}, 不同服务器: {len(servers)}')
print()

import socket, concurrent.futures, time, threading

server_nodes = {}
for proto, region, name, server, port in nodes:
    if server not in server_nodes:
        server_nodes[server] = []
    server_nodes[server].append((proto, port, name))

HOLD_SECONDS = 30  # keep connection alive for 30 seconds
CHECK_INTERVAL = 5  # check every 5 seconds

def test_stable_connection(server, port, hold_sec, check_interval):
    """Connect, hold for hold_sec, periodically check if still alive"""
    log = []
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(10)
        t0 = time.time()
        sock.connect((server, int(port)))
        connect_ms = (time.time() - t0) * 1000
        log.append(f'connected ({connect_ms:.0f}ms)')
        
        # Resolve IP
        ip = sock.getpeername()[0]
        log.append(f'IP={ip}')
        
        # Hold connection and check periodically
        checks_passed = 0
        checks_total = hold_sec // check_interval
        for i in range(checks_total):
            time.sleep(check_interval)
            elapsed = (time.time() - t0)
            # Check socket is still alive by attempting a non-blocking recv
            sock.settimeout(0.5)
            try:
                # For SS/VMess, server won't send data first, so timeout is expected
                data = sock.recv(1)
                if data == b'':
                    log.append(f'{elapsed:.0f}s: closed by server')
                    sock.close()
                    return False, ip, connect_ms, log
                else:
                    log.append(f'{elapsed:.0f}s: got {len(data)}B')
            except socket.timeout:
                # Timeout is good - connection still alive, just no data
                checks_passed += 1
                log.append(f'{elapsed:.0f}s: alive')
            except Exception as e:
                log.append(f'{elapsed:.0f}s: error - {e}')
                sock.close()
                return False, ip, connect_ms, log
        
        sock.close()
        log.append(f'stable for {hold_sec}s ({checks_passed}/{checks_total} checks OK)')
        return True, ip, connect_ms, log
    except Exception as e:
        return False, None, 0, [f'connect failed: {e}']

print(f'同时连接11台服务器，保持{HOLD_SECONDS}秒，每{CHECK_INTERVAL}秒检查一次...')
print()

results = {}
with concurrent.futures.ThreadPoolExecutor(max_workers=15) as executor:
    futures = {}
    for server, node_list in server_nodes.items():
        proto, port, name = node_list[0]
        short = server.replace('.51feitu.com', '')
        futures[executor.submit(test_stable_connection, server, port, HOLD_SECONDS, CHECK_INTERVAL)] = (short, server, port, name)
    
    for future in concurrent.futures.as_completed(futures):
        short, server, port, name = futures[future]
        ok, ip, latency, log = future.result()
        status = 'STABLE' if ok else 'FAILED'
        results[short] = (ok, ip, latency, log)
        print(f'  [{status}] {short}:{port}  IP={ip}  delay={latency:.0f}ms')
        for entry in log:
            print(f'          {entry}')
        print()

stable = sum(1 for v in results.values() if v[0])
unique_ips = set(v[1] for v in results.values() if v[1])
print(f'=== 结果 ===')
print(f'稳定连接: {stable}/{len(results)}')
print(f'不同出口IP: {len(unique_ips)}')
for ip in sorted(unique_ips):
    print(f'  {ip}')
print()
if stable == len(results):
    print(f'所有 {stable} 台服务器都能同时保持稳定连接！可以做负载均衡。')
else:
    print(f'有 {len(results)-stable} 台服务器不稳定，建议排除。')
