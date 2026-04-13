#!/bin/bash
# AK-Proxy 一键完整部署脚本
# 覆盖范围：ak-proxy systemd服务 + nginx配置 + 所有权限设置
# 使用方式：chmod +x deploy_ak_proxy.sh && ./deploy_ak_proxy.sh

set -e

REPO_DIR="/home/ubuntu/ak-proxy"
APP_DIR="$REPO_DIR/public_admin"
LOG_FILE="$APP_DIR/proxy.log"
VENV_BIN="$REPO_DIR/venv/bin"
NGINX_CONF_SRC="$REPO_DIR/transparent_proxy/nginx.conf"
NGINX_CONF_DST="/etc/nginx/sites-enabled/nginx.conf"
LEGACY_NGINX_CONF="/etc/nginx/sites-enabled/ak2025.conf"
SERVICE_NAME="ak-proxy"

echo "========================================="
echo "AK-Proxy 一键部署脚本"
echo "========================================="

# 检查是否为root用户
if [ "$EUID" -eq 0 ]; then
    echo "❌ 不要使用root用户运行此脚本，请使用 ubuntu 用户"
    exit 1
fi

# ===== [1/7] 创建 systemd 服务文件 =====
echo -e "\n[1/7] 创建 systemd 服务文件..."
sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=AK Proxy Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=${APP_DIR}
Environment="PATH=${VENV_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=${VENV_BIN}/python proxy_server.py
Restart=always
RestartSec=10
StandardOutput=null
StandardError=null
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
echo "✅ systemd 服务文件创建成功（崩溃自动重启已启用）"

# ===== [2/7] 初始化日志文件权限 =====
echo -e "\n[2/7] 初始化日志文件权限..."
sudo touch "$LOG_FILE"
sudo chown ubuntu:ubuntu "$LOG_FILE"
echo "✅ 日志文件权限已设置: $LOG_FILE"

# ===== [3/7] 启动 ak-proxy 服务 =====
echo -e "\n[3/7] 启动 ak-proxy 服务..."
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"
sleep 5

if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "✅ ak-proxy 服务启动成功，已设置开机自启"
else
    echo "❌ ak-proxy 服务启动失败，查看日志："
    tail -30 "$LOG_FILE"
    exit 1
fi

# ===== [4/7] 部署 nginx 配置 =====
echo -e "\n[4/7] 部署 nginx 配置..."
if [ ! -f "$NGINX_CONF_SRC" ]; then
    echo "❌ nginx 配置文件不存在: $NGINX_CONF_SRC"
    exit 1
fi
if [ -f "$LEGACY_NGINX_CONF" ] && [ "$LEGACY_NGINX_CONF" != "$NGINX_CONF_DST" ]; then
    LEGACY_MIGRATION_BACKUP="${LEGACY_NGINX_CONF}.migrated_$(date +%Y%m%d_%H%M%S)"
    sudo cp "$LEGACY_NGINX_CONF" "$LEGACY_MIGRATION_BACKUP"
    echo "✅ 已备份旧 nginx 配置: $LEGACY_MIGRATION_BACKUP"
fi
sudo cp "$NGINX_CONF_SRC" "$NGINX_CONF_DST"
echo "✅ nginx 配置已复制到 $NGINX_CONF_DST"
if [ -f "$LEGACY_NGINX_CONF" ] && [ "$LEGACY_NGINX_CONF" != "$NGINX_CONF_DST" ]; then
    sudo rm -f "$LEGACY_NGINX_CONF"
    echo "✅ 已移除旧 nginx 配置: $LEGACY_NGINX_CONF"
fi

# ===== [5/7] 清理 nginx 冲突的 backup 文件 =====
echo -e "\n[5/7] 清理 nginx sites-enabled 中的旧 backup 文件..."
BACKUP_COUNT=$(sudo find /etc/nginx/sites-enabled/ -name "*.backup*" -o -name "*.bak" -o -name "*backup*" 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt 0 ]; then
    sudo find /etc/nginx/sites-enabled/ -name "*.backup*" -o -name "*.bak" -o -name "*backup*" \
        | sudo xargs -I{} mv {} /tmp/
    echo "✅ 已移走 $BACKUP_COUNT 个 backup 文件到 /tmp/"
else
    echo "✅ 无冲突 backup 文件"
fi

# ===== [6/7] 验证并重载 nginx =====
echo -e "\n[6/7] 验证并重载 nginx..."
if sudo nginx -t 2>&1 | grep -q "syntax is ok"; then
    sudo nginx -s reload
    echo "✅ nginx 配置验证通过，已重载"
else
    echo "❌ nginx 配置有误："
    sudo nginx -t
    exit 1
fi

# ===== [7/7] 完整验证 =====
echo -e "\n[7/7] 验证部署结果..."

echo -e "\n--- ak-proxy 状态 ---"
sudo systemctl status "$SERVICE_NAME" --no-pager | head -8

echo -e "\n--- 最新日志（最后15行）---"
tail -15 "$LOG_FILE"

echo -e "\n--- API 连通性测试 ---"
sleep 2
if curl -sf http://localhost:8080/api/stats > /dev/null 2>&1; then
    echo "✅ API (localhost:8080) 连通正常"
else
    echo "⚠️  API 测试失败，请检查上方日志"
fi

echo -e "\n========================================="
echo "✅ 部署完成！"
echo "========================================="
echo ""
echo "常用命令："
echo "  重启服务:   sudo systemctl restart $SERVICE_NAME"
echo "  查看状态:   sudo systemctl status $SERVICE_NAME"
echo "  实时日志:   tail -f $LOG_FILE"
echo "  journald:   sudo journalctl -u $SERVICE_NAME -f"
echo ""
echo "更新部署（有新代码时）："
echo "  cd $REPO_DIR && git pull origin main && sudo systemctl restart $SERVICE_NAME && sudo nginx -s reload"
echo "========================================="
