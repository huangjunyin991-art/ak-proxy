# -*- coding: utf-8 -*-
import sys, json, ssl
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, 'd:\\pythonProject\\auto_sell_systemV6 - 正在更新\\multi_tunnel')
from sub_parser import parse_subscription_text

url = 'https://ft-5jki2k6d.tutunode.com/gateway/feitu?token=c3f4ab56beeaceb2b7e9df121c7fb1c4'
RAW_CACHE = Path('check_sub_raw.txt')

raw = None
# 尝试从 URL 获取
try:
    ctx = ssl._create_unverified_context()
    req = Request(url, headers={'User-Agent': 'ClashForWindows/0.20.0', 'Accept': '*/*'})
    resp = urlopen(req, context=ctx, timeout=20)
    raw = resp.read().decode('utf-8').strip()
    RAW_CACHE.write_text(raw, encoding='utf-8')
    print(f'[fetch] 订阅获取成功，已缓存至 {RAW_CACHE}')
except Exception as e:
    print(f'[fetch] 订阅获取失败: {e}')
    if RAW_CACHE.exists():
        raw = RAW_CACHE.read_text(encoding='utf-8')
        print(f'[fetch] 使用缓存文本 {RAW_CACHE}')

if not raw:
    Path('check_sub_result.txt').write_text('ERROR: 无法获取订阅且无缓存', encoding='utf-8')
    print('ERROR: 无法获取订阅')
    sys.exit(1)

result = parse_subscription_text(raw)
result['url'] = url

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
