# -*- coding: utf-8 -*-
import sys, json
from pathlib import Path
sys.path.insert(0, 'd:\\pythonProject\\auto_sell_systemV6 - 正在更新\\multi_tunnel')
from sub_parser import fetch_subscription

url = 'https://ft-5jki2k6d.tutunode.com/gateway/feitu?token=c3f4ab56beeaceb2b7e9df121c7fb1c4'
result = fetch_subscription(url)

out = Path('check_sub_result.txt')
lines = []

if 'error' in result:
    lines.append('ERROR: ' + result['error'])
else:
    lines.append(f'format: {result["format"]}')
    lines.append(f'total_nodes: {result["total_nodes"]}')
    lines.append(f'unique_servers: {result["unique_servers"]}')
    lines.append('')

    lines.append('=== regions ===')
    for code, info in sorted(result['regions'].items()):
        lines.append(f'  {info["label"]}({code}): {info["count"]}')

    lines.append('')
    lines.append('=== duplicate host ===')
    dup = {k: v for k, v in result['servers'].items() if len(v) > 1}
    for server, indices in dup.items():
        names = [result['nodes'][i]['name'] for i in indices]
        lines.append(f'  {server} -> {len(indices)} nodes:')
        for n in names:
            lines.append(f'    - {n}')
    if not dup:
        lines.append('  (none)')

    lines.append('')
    lines.append('=== all nodes ===')
    for i, n in enumerate(result['nodes']):
        lines.append(f'  [{i}] {n["name"]} | {n["type"]} | {n["server"]}:{n["port"]}')

    Path('check_sub_result.json').write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8'
    )

out.write_text('\n'.join(lines), encoding='utf-8')
print('done -> check_sub_result.txt')
