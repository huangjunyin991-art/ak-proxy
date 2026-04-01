# -*- coding: utf-8 -*-
"""分析订阅节点的 server:port 唯一性"""
import json
from pathlib import Path
from collections import Counter

data = json.loads(Path('check_sub_result.json').read_text(encoding='utf-8'))
nodes = data['nodes']

# server:port 对唯一数
sp_set = {(n['server'], n['port']) for n in nodes}
lines = []
lines.append(f'总节点数: {len(nodes)}')
lines.append(f'唯一 server:port 对: {len(sp_set)}  （每个端口独立说明无重复连接目标）')
lines.append('')

from collections import defaultdict
host_ports = defaultdict(list)
for n in nodes:
    host_ports[n['server']].append((n['port'], n['name']))

lines.append('=== 各 host 的端口分布 ===')
for host, plist in sorted(host_ports.items(), key=lambda x: -len(x[1])):
    plist.sort()
    lines.append(f'{host} ({len(plist)}个节点)')
    for p, name in plist:
        lines.append(f'  :{p}  {name}')
    lines.append('')

Path('check_sub_ips.txt').write_text('\n'.join(lines), encoding='utf-8')
print('done -> check_sub_ips.txt')
