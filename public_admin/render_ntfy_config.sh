#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_PATH="${NTFY_CONF_SRC:-$SCRIPT_DIR/config/ntfy_server.yml}"
OUTPUT_PATH="${NTFY_CONF_DST:-/etc/ntfy/server.yml}"
ADMIN_DOMAIN="${ADMIN_DOMAIN:-}"
NTFY_DOMAIN="${NTFY_DOMAIN:-}"

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

if [ -z "$NTFY_DOMAIN" ]; then
    NTFY_DOMAIN="ntfy.$ADMIN_DOMAIN"
fi

if [ -n "$ADMIN_DOMAIN" ]; then
    ADMIN_DOMAIN_LOWER="$(printf '%s' "$ADMIN_DOMAIN" | tr '[:upper:]' '[:lower:]')"
    NTFY_DOMAIN_LOWER="$(printf '%s' "$NTFY_DOMAIN" | tr '[:upper:]' '[:lower:]')"
    if [ "$ADMIN_DOMAIN_LOWER" = "$NTFY_DOMAIN_LOWER" ]; then
        echo "[ERROR] NTFY_DOMAIN 不能与 ADMIN_DOMAIN 相同，否则 ntfy 会占用主站域名"
        exit 1
    fi
fi

if echo "$NTFY_DOMAIN" | grep -Eq '^[a-zA-Z0-9.-]+$'; then
    true
else
    echo "[ERROR] ntfy 域名格式无效，只允许字母、数字、点和短横线"
    exit 1
fi

if [ ! -f "$TEMPLATE_PATH" ]; then
    echo "[ERROR] ntfy 配置模板不存在: $TEMPLATE_PATH"
    exit 1
fi

RENDERED_CONF="$(mktemp)"
sed -e "s|<NTFY_DOMAIN>|${NTFY_DOMAIN}|g" "$TEMPLATE_PATH" > "$RENDERED_CONF"

if [ "${NTFY_RENDER_ONLY:-0}" = "1" ]; then
    cat "$RENDERED_CONF"
    rm -f "$RENDERED_CONF"
    exit 0
fi

if [ "${NTFY_USE_SUDO:-1}" = "1" ]; then
    sudo install -d -m 755 "$(dirname "$OUTPUT_PATH")"
    sudo install -d -m 755 /var/cache/ntfy /var/lib/ntfy/attachments
    if id ntfy >/dev/null 2>&1; then
        sudo chown ntfy:ntfy /var/cache/ntfy /var/lib/ntfy/attachments
    fi
    sudo install -m 644 "$RENDERED_CONF" "$OUTPUT_PATH"
else
    mkdir -p "$(dirname "$OUTPUT_PATH")"
    cp "$RENDERED_CONF" "$OUTPUT_PATH"
fi

rm -f "$RENDERED_CONF"
echo "[OK] 已渲染 ntfy 配置: $OUTPUT_PATH"
