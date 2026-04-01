# -*- coding: utf-8 -*-
"""
完整流程：订阅节点 -> sing-box 配置 -> 启动 -> ip_dedup 检测独立 IP
"""
import io
import json
import sys
import time
from pathlib import Path

# 修复 Windows 控制台 UTF-8 输出
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# 模块路径
MT_DIR = r'd:\pythonProject\auto_sell_systemV6 - 正在更新\multi_tunnel'
SB_DIR = r'd:\pythonProject\auto_sell_systemV6 - 正在更新\sing-box'
sys.path.insert(0, str(Path(MT_DIR).parent))

from multi_tunnel import singbox, ip_dedup

# ── 1. 读取已解析的节点 ────────────────────────────────────────
nodes_data = json.loads(Path('check_sub_result.json').read_text(encoding='utf-8'))
nodes = nodes_data['nodes']
print(f'[1] 读取节点: {len(nodes)} 个')

# ── 2. 配置 sing-box 路径 ─────────────────────────────────────
singbox.configure(singbox_dir=SB_DIR, singbox_bin='sing-box.exe')
print(f'[2] sing-box 目录: {SB_DIR}')

# ── 3. 生成配置 + 启动 sing-box ───────────────────────────────
BASE_PORT = 10001
print(f'[3] 生成 sing-box 配置 ({len(nodes)} 节点, 端口 {BASE_PORT}-{BASE_PORT+len(nodes)-1})...')
result = singbox.apply_nodes(nodes, base_port=BASE_PORT)
print(f'    apply_nodes: {result}')

if not result['success']:
    print(f'[ERROR] sing-box 启动失败，中止检测')
    sys.exit(1)

# ── 4. 等待 sing-box 就绪 ─────────────────────────────────────
print('[4] 等待 sing-box 就绪 (5s)...')
time.sleep(5)

# ── 5. ip_dedup 检测 ─────────────────────────────────────────
print(f'[5] 开始 ip_dedup 检测 ({len(nodes)} 个端口, timeout=15s)...')
cache_path = Path('ip_dedup_cache.json')

unique_ports = ip_dedup.get_unique_ports(
    base_port=BASE_PORT,
    num_ports=len(nodes),
    cache_path=cache_path,
    force_refresh=True,
    timeout=15.0,
    verbose=True,
)

# ── 6. 输出结果 ───────────────────────────────────────────────
print(f'\n=== 检测结果 ===')
print(f'总节点数: {len(nodes)}')
print(f'独立 IP 数: {len(unique_ports)}')
print(f'重复/不可达节点数: {len(nodes) - len(unique_ports)}')
print(f'独立端口列表: {unique_ports}')

# 读取缓存中的详细 ip_map
if cache_path.exists():
    cache = json.loads(cache_path.read_text(encoding='utf-8'))
    ip_map = cache.get('ip_map', {})
    dup_groups = cache.get('dup_groups', {})

    print(f'\n=== 端口 -> 出口IP 映射 ===')
    for port_str, ip in sorted(ip_map.items(), key=lambda x: int(x[0])):
        port = int(port_str)
        node_idx = port - BASE_PORT
        node_name = nodes[node_idx]['name'] if node_idx < len(nodes) else '?'
        marker = '✓' if port in unique_ports else '✗(dup)'
        print(f'  {marker} :{port} {node_name} -> {ip}')

    if dup_groups:
        print(f'\n=== 重复 IP 组 ===')
        for ip, ports in dup_groups.items():
            names = [nodes[p - BASE_PORT]['name'] for p in ports if p - BASE_PORT < len(nodes)]
            print(f'  {ip}: 端口 {ports} -> {names}')

# ── 7. 停止 sing-box ─────────────────────────────────────────
print('\n[7] 停止 sing-box...')
singbox.stop_service()
print('完成。')
