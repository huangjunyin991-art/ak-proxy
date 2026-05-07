#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_PATH="${NGINX_CONF_SRC:-$SCRIPT_DIR/config/nginx.conf}"
OUTPUT_PATH="${NGINX_CONF_DST:-/etc/nginx/sites-enabled/nginx.conf}"
ADMIN_DOMAIN="${ADMIN_DOMAIN:-}"

if [ -z "$ADMIN_DOMAIN" ] && [ $# -ge 1 ]; then
    ADMIN_DOMAIN="$1"
fi

if [ -z "$ADMIN_DOMAIN" ]; then
    read -r -p "请输入管理员入口域名: " ADMIN_DOMAIN
fi

if [ -z "$ADMIN_DOMAIN" ]; then
    echo "[ERROR] 管理员入口域名不能为空"
    exit 1
fi

if echo "$ADMIN_DOMAIN" | grep -Eq '^[a-zA-Z0-9.-]+$'; then
    true
else
    echo "[ERROR] 域名格式无效，只允许字母、数字、点和短横线"
    exit 1
fi

if [ ! -f "$TEMPLATE_PATH" ]; then
    echo "[ERROR] Nginx 模板不存在: $TEMPLATE_PATH"
    exit 1
fi

RENDERED_CONF="$(mktemp)"
sed -e "s|<ADMIN_DOMAIN>|${ADMIN_DOMAIN}|g" "$TEMPLATE_PATH" > "$RENDERED_CONF"

if [ "${NGINX_RENDER_ONLY:-0}" = "1" ]; then
    cat "$RENDERED_CONF"
    rm -f "$RENDERED_CONF"
    exit 0
fi

if [ "${NGINX_USE_SUDO:-1}" = "1" ]; then
    sudo cp "$RENDERED_CONF" "$OUTPUT_PATH"
else
    cp "$RENDERED_CONF" "$OUTPUT_PATH"
fi

rm -f "$RENDERED_CONF"
echo "[OK] 已渲染 Nginx 配置: $OUTPUT_PATH"
