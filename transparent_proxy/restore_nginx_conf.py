#!/usr/bin/env python3
"""恢复 /etc/nginx/nginx.conf 为 Ubuntu 默认优化配置"""
import subprocess

NGINX_CONF = r"""user www-data;
worker_processes auto;
pid /run/nginx.pid;
error_log /var/log/nginx/error.log;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 1024;
    multi_accept on;
}

http {
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml text/javascript;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
"""

with open('/etc/nginx/nginx.conf', 'w') as f:
    f.write(NGINX_CONF)
print("nginx.conf 已恢复")

r = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
print(r.stdout + r.stderr)
if r.returncode == 0:
    subprocess.run(['systemctl', 'reload', 'nginx'])
    print("nginx 已重载")
else:
    print("配置测试失败，未重载")
