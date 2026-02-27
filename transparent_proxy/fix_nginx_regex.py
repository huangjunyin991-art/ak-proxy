#!/usr/bin/env python3
"""
修复nginx配置中被UCloud终端损坏的正则表达式
问题：反斜杠 \ 被替换为百分号 %
"""
import sys
import shutil

filepath = sys.argv[1] if len(sys.argv) > 1 else '/etc/nginx/sites-available/ak-proxy'

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

# 备份
backup = filepath + '.bak'
shutil.copy2(filepath, backup)
print(f"已备份: {backup}")

# 修复所有被损坏的正则：% 应该是 \
# 只替换 location 行中的 %（正则上下文）
fixes = [
    ('mnemonic%.', 'mnemonic\\.'),
    ('%.html$', '\\.html$'),
    ('%.(css|jpg|jpeg|png|gif|ico|svg|woff|woff2|ttf|eot)$', '\\.(css|jpg|jpeg|png|gif|ico|svg|woff|woff2|ttf|eot)$'),
    ('%.js$', '\\.js$'),
]

count = 0
for old, new in fixes:
    if old in content:
        content = content.replace(old, new)
        count += 1
        print(f"  修复: {old} -> {new}")

if count > 0:
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"\n已修复 {count} 处正则表达式")
else:
    print("未发现需要修复的内容")
