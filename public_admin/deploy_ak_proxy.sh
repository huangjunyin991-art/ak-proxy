#!/bin/bash
# AK-Proxy 一键完整部署脚本
# 覆盖范围：ak-proxy systemd服务 + 环境变量自动生成 + nginx配置 + 所有权限设置
# 使用方式：chmod +x deploy_ak_proxy.sh && ./deploy_ak_proxy.sh

set -e

REPO_DIR="${REPO_DIR:?请设置 REPO_DIR}"
APP_DIR="$REPO_DIR/public_admin"
LOG_FILE="$APP_DIR/proxy.log"
VENV_BIN="${VENV_BIN:-$REPO_DIR/venv/bin}"
ENV_DIR="${AK_PROXY_ENV_DIR:-/etc/ak-proxy}"
ENV_FILE="${AK_PROXY_ENV_FILE:-$ENV_DIR/ak-proxy.env}"
ENSURE_ENV_SCRIPT="$APP_DIR/deploy/env/ensure_env.sh"
NGINX_CONF_SRC="${NGINX_CONF_SRC:-$REPO_DIR/public_admin/config/nginx.conf}"
NGINX_CONF_DST="${NGINX_CONF_DST:-/etc/nginx/sites-enabled/nginx.conf}"
NGINX_RENDER_SCRIPT="${NGINX_RENDER_SCRIPT:-$REPO_DIR/public_admin/render_nginx_config.sh}"
NTFY_CONF_SRC="${NTFY_CONF_SRC:-$REPO_DIR/public_admin/config/ntfy_server.yml}"
NTFY_CONF_DST="${NTFY_CONF_DST:-/etc/ntfy/server.yml}"
NTFY_RENDER_SCRIPT="${NTFY_RENDER_SCRIPT:-$REPO_DIR/public_admin/render_ntfy_config.sh}"
LEGACY_NGINX_CONF="${LEGACY_NGINX_CONF:-}"
SERVICE_NAME="${AK_PROXY_SERVICE_NAME:-ak-proxy}"
SERVICE_USER="${AK_PROXY_SERVICE_USER:?请设置 AK_PROXY_SERVICE_USER}"
ADMIN_DOMAIN="${ADMIN_DOMAIN:?请设置 ADMIN_DOMAIN}"

echo "========================================="
echo "AK-Proxy 一键部署脚本"
echo "========================================="

# 检查是否为root用户
if [ "$EUID" -eq 0 ]; then
    echo "[ERROR] 不要使用 root 用户运行此脚本"
    exit 1
fi

# ===== [1/8] 创建 systemd 服务文件 =====
echo -e "\n[1/8] 创建 systemd 服务文件..."
sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=AK Proxy Server
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${ENV_FILE}
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
echo "[OK] systemd 服务文件创建成功（崩溃自动重启已启用）"

# ===== [2/8] 初始化日志文件权限 =====
echo -e "\n[2/8] 初始化日志文件权限..."
sudo touch "$LOG_FILE"
sudo chown "${SERVICE_USER}:${SERVICE_USER}" "$LOG_FILE"
echo "[OK] 日志文件权限已设置: $LOG_FILE"

# ===== [3/8] 自动生成缺失的环境变量 =====
echo -e "\n[3/8] 自动生成缺失的环境变量..."
if [ -f "$ENSURE_ENV_SCRIPT" ]; then
    bash "$ENSURE_ENV_SCRIPT" --env-file "$ENV_FILE"
else
    echo "[WARN] ensure_env.sh not found, skipping auto env generation"
fi

# ===== [4/8] 启动 ak-proxy 服务 =====
echo -e "\n[4/8] 启动 ak-proxy 服务..."
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"
sleep 5

if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "[OK] ak-proxy 服务启动成功，已设置开机自启"
else
    echo "[ERROR] ak-proxy 服务启动失败，查看日志："
    tail -30 "$LOG_FILE"
    exit 1
fi

# ===== [5/8] 部署 nginx 配置 =====
echo -e "\n[5/8] 部署 nginx 配置..."
if [ ! -f "$NGINX_CONF_SRC" ]; then
    echo "[ERROR] nginx 配置文件不存在: $NGINX_CONF_SRC"
    exit 1
fi
if [ ! -f "$NGINX_RENDER_SCRIPT" ]; then
    echo "[ERROR] nginx 渲染脚本不存在: $NGINX_RENDER_SCRIPT"
    exit 1
fi
if [ ! -f "$NTFY_CONF_SRC" ]; then
    echo "[ERROR] ntfy 配置文件不存在: $NTFY_CONF_SRC"
    exit 1
fi
if [ ! -f "$NTFY_RENDER_SCRIPT" ]; then
    echo "[ERROR] ntfy 渲染脚本不存在: $NTFY_RENDER_SCRIPT"
    exit 1
fi
if [ -n "$LEGACY_NGINX_CONF" ] && [ -f "$LEGACY_NGINX_CONF" ] && [ "$LEGACY_NGINX_CONF" != "$NGINX_CONF_DST" ]; then
    LEGACY_MIGRATION_BACKUP="${LEGACY_NGINX_CONF}.migrated_$(date +%Y%m%d_%H%M%S)"
    sudo cp "$LEGACY_NGINX_CONF" "$LEGACY_MIGRATION_BACKUP"
    echo "[OK] 已备份旧 nginx 配置: $LEGACY_MIGRATION_BACKUP"
fi
NTFY_DOMAIN="${NTFY_DOMAIN:-}" ADMIN_DOMAIN="$ADMIN_DOMAIN" NGINX_CONF_SRC="$NGINX_CONF_SRC" NGINX_CONF_DST="$NGINX_CONF_DST" bash "$NGINX_RENDER_SCRIPT"
echo "[OK] nginx 配置已复制到 $NGINX_CONF_DST"
NTFY_DOMAIN="${NTFY_DOMAIN:-}" ADMIN_DOMAIN="$ADMIN_DOMAIN" NTFY_CONF_SRC="$NTFY_CONF_SRC" NTFY_CONF_DST="$NTFY_CONF_DST" bash "$NTFY_RENDER_SCRIPT"
echo "[OK] ntfy 配置已复制到 $NTFY_CONF_DST"
if [ -n "$LEGACY_NGINX_CONF" ] && [ -f "$LEGACY_NGINX_CONF" ] && [ "$LEGACY_NGINX_CONF" != "$NGINX_CONF_DST" ]; then
    sudo rm -f "$LEGACY_NGINX_CONF"
    echo "[OK] 已移除旧 nginx 配置: $LEGACY_NGINX_CONF"
fi
if systemctl list-unit-files --type=service 2>/dev/null | grep -q '^ntfy.service'; then
    sudo systemctl restart ntfy
    echo "[OK] ntfy 已重启并加载新配置"
fi

# ===== [6/8] 清理 nginx 冲突的 backup 文件 =====
echo -e "\n[6/8] 清理 nginx sites-enabled 中的旧 backup 文件..."
BACKUP_COUNT=$(sudo find /etc/nginx/sites-enabled/ -name "*.backup*" -o -name "*.bak" -o -name "*backup*" 2>/dev/null | wc -l)
if [ "$BACKUP_COUNT" -gt 0 ]; then
    sudo find /etc/nginx/sites-enabled/ -name "*.backup*" -o -name "*.bak" -o -name "*backup*" \
        | sudo xargs -I{} mv {} /tmp/
    echo "[OK] 已移走 $BACKUP_COUNT 个 backup 文件到 /tmp/"
else
    echo "[OK] 无冲突 backup 文件"
fi

# ===== [7/8] 验证并重载 nginx =====
echo -e "\n[7/8] 验证并重载 nginx..."
if sudo nginx -t 2>&1 | grep -q "syntax is ok"; then
    sudo nginx -s reload
    echo "[OK] nginx 配置验证通过，已重载"
else
    echo "[ERROR] nginx 配置有误："
    sudo nginx -t
    exit 1
fi

# ===== [8/8] 完整验证 =====
echo -e "\n[8/8] 验证部署结果..."

echo -e "\n--- ak-proxy 状态 ---"
sudo systemctl status "$SERVICE_NAME" --no-pager | head -8

echo -e "\n--- 最新日志（最后15行）---"
tail -15 "$LOG_FILE"

echo -e "\n--- API 连通性测试 ---"
sleep 2
if curl -sf http://localhost:8080/api/stats > /dev/null 2>&1; then
    echo "[OK] API (localhost:8080) 连通正常"
else
    echo "[WARN] API 测试失败，请检查上方日志"
fi

echo -e "\n========================================="
echo "[OK] 部署完成！"
echo "========================================="
