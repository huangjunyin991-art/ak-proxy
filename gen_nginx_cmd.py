#!/usr/bin/env python3
"""在服务器上运行此脚本，写入完整的单文件 nginx.conf"""
import base64, subprocess

# nginx_ak2026.conf 完整内容 (base64编码避免终端损坏)
data = open(r'd:\PycharmProjects\ak-proxy\transparent_proxy\nginx_ak2026.conf', 'rb').read()
enc = base64.b64encode(data).decode()
cmd = "sudo python3 -c \"import base64;open('/etc/nginx/sites-available/ak-proxy','wb').write(base64.b64decode('" + enc + "'));print('OK')\""

with open(r'd:\PycharmProjects\ak-proxy\nginx_cmd.txt', 'w') as f:
    f.write(cmd)

print(f"Command saved to nginx_cmd.txt ({len(cmd)} chars)")
