#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
SERVICE_NAME="${AK_PROXY_SERVICE_NAME:-ak-proxy}"
SERVICE_USER="${AK_PROXY_SERVICE_USER:-$(id -un)}"
APP_DIR="$REPO_DIR/public_admin"
VENV_BIN="${VENV_BIN:-$REPO_DIR/venv/bin}"
ENV_DIR="${AK_PROXY_ENV_DIR:-/etc/ak-proxy}"
ENV_FILE="${AK_PROXY_ENV_FILE:-$ENV_DIR/ak-proxy.env}"
NGINX_CONF_SRC="${NGINX_CONF_SRC:-$APP_DIR/config/nginx.conf}"
NGINX_CONF_DST="${NGINX_CONF_DST:-/etc/nginx/sites-enabled/nginx.conf}"
NGINX_RENDER_SCRIPT="${NGINX_RENDER_SCRIPT:-$APP_DIR/render_nginx_config.sh}"
NTFY_CONF_SRC="${NTFY_CONF_SRC:-$APP_DIR/config/ntfy_server.yml}"
NTFY_CONF_DST="${NTFY_CONF_DST:-/etc/ntfy/server.yml}"
NTFY_RENDER_SCRIPT="${NTFY_RENDER_SCRIPT:-$APP_DIR/render_ntfy_config.sh}"
LOG_FILE="$APP_DIR/proxy.log"
ADMIN_DOMAIN=""
NTFY_DOMAIN_VALUE="${NTFY_DOMAIN:-}"
ADMIN_PASSWORD_VALUE=""
DB_SECONDARY_PASSWORD_VALUE=""
AK_PROXY_DB_PASSWORD_VALUE=""
LICENSE_SERVER_URL_VALUE="${LICENSE_SERVER_URL:-}"
LICENSE_ADMIN_KEY_VALUE="${LICENSE_ADMIN_KEY:-}"
SKIP_ENV=0
SKIP_NGINX=0
SKIP_RESTART=0

usage() {
    cat <<EOF
用法:
  bash public_admin/manage_ak_proxy.sh --domain <域名> [选项]

选项:
  --ntfy-domain <域名>
  --admin-password <值>
  --secondary-password <值>
  --db-password <值>
  --license-server-url <URL>
  --license-admin-key <值>
  --service-user <用户>
  --service-name <服务名>
  --skip-env
  --skip-nginx
  --skip-restart
  -h, --help
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --domain)
            ADMIN_DOMAIN="${2:-}"
            shift 2
            ;;
        --ntfy-domain)
            NTFY_DOMAIN_VALUE="${2:-}"
            shift 2
            ;;
        --admin-password)
            ADMIN_PASSWORD_VALUE="${2:-}"
            shift 2
            ;;
        --secondary-password)
            DB_SECONDARY_PASSWORD_VALUE="${2:-}"
            shift 2
            ;;
        --db-password)
            AK_PROXY_DB_PASSWORD_VALUE="${2:-}"
            shift 2
            ;;
        --license-server-url)
            LICENSE_SERVER_URL_VALUE="${2:-}"
            shift 2
            ;;
        --license-admin-key)
            LICENSE_ADMIN_KEY_VALUE="${2:-}"
            shift 2
            ;;
        --service-user)
            SERVICE_USER="${2:-}"
            shift 2
            ;;
        --service-name)
            SERVICE_NAME="${2:-}"
            shift 2
            ;;
        --skip-env)
            SKIP_ENV=1
            shift
            ;;
        --skip-nginx)
            SKIP_NGINX=1
            shift
            ;;
        --skip-restart)
            SKIP_RESTART=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "[ERROR] 未知参数: $1"
            usage
            exit 1
            ;;
    esac
done

read_secret() {
    local var_name="$1"
    local label="$2"
    local current_value="$3"
    if [ -n "$current_value" ]; then
        printf '%s' "$current_value"
        return
    fi
    local input=""
    read -r -s -p "$label: " input
    echo >&2
    if [ -z "$input" ]; then
        echo "[ERROR] $var_name 不能为空" >&2
        exit 1
    fi
    printf '%s' "$input"
}

escape_env_value() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

generate_license_admin_key() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
        return
    fi
    if command -v python3 >/dev/null 2>&1; then
        python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
        return
    fi
    if command -v python >/dev/null 2>&1; then
        python - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
        return
    fi
    echo "[ERROR] 无法生成 LICENSE_ADMIN_KEY：缺少 openssl/python3/python" >&2
    exit 1
}

read_existing_env_value() {
    local key="$1"
    if [ ! -f "$ENV_FILE" ]; then
        return 1
    fi
    sudo awk -F= -v key="$key" '
        $1 == key {
            value = $0
            sub("^[^=]*=", "", value)
            gsub(/^[ \t"]+|[ \t"]+$/, "", value)
            if (length(value) > 0) {
                print value
                found = 1
                exit
            }
        }
        END { exit found ? 0 : 1 }
    ' "$ENV_FILE"
}

prepare_license_admin_key() {
    if [ -n "$LICENSE_ADMIN_KEY_VALUE" ]; then
        return
    fi
    local existing_key=""
    existing_key="$(read_existing_env_value LICENSE_ADMIN_KEY 2>/dev/null || true)"
    if [ -n "$existing_key" ]; then
        LICENSE_ADMIN_KEY_VALUE="$existing_key"
        echo "[OK] 已沿用现有 LICENSE_ADMIN_KEY"
        return
    fi
    LICENSE_ADMIN_KEY_VALUE="$(generate_license_admin_key)"
    echo "[OK] LICENSE_ADMIN_KEY 未配置，已随机生成"
}

validate_domain() {
    if [ -z "$ADMIN_DOMAIN" ]; then
        echo "[ERROR] 请通过 --domain 指定域名"
        exit 1
    fi
    if ! echo "$ADMIN_DOMAIN" | grep -Eq '^[a-zA-Z0-9.-]+$'; then
        echo "[ERROR] 域名格式无效，只允许字母、数字、点和短横线"
        exit 1
    fi
}

validate_license_url() {
    if [ -z "$LICENSE_SERVER_URL_VALUE" ]; then
        return
    fi
    if ! printf '%s' "$LICENSE_SERVER_URL_VALUE" | grep -Eq '^https?://'; then
        echo "[ERROR] LICENSE_SERVER_URL 必须以 http:// 或 https:// 开头"
        exit 1
    fi
}

write_env_file() {
    local admin_password="$1"
    local secondary_password="$2"
    local db_password="$3"
    local tmp_file
    tmp_file="$(mktemp)"
    {
        printf 'ADMIN_PASSWORD="%s"\n' "$(escape_env_value "$admin_password")"
        printf 'DB_SECONDARY_PASSWORD="%s"\n' "$(escape_env_value "$secondary_password")"
        printf 'AK_PROXY_DB_PASSWORD="%s"\n' "$(escape_env_value "$db_password")"
        if [ -n "$LICENSE_SERVER_URL_VALUE" ]; then
            printf 'LICENSE_SERVER_URL="%s"\n' "$(escape_env_value "$LICENSE_SERVER_URL_VALUE")"
        fi
        if [ -n "$LICENSE_ADMIN_KEY_VALUE" ]; then
            printf 'LICENSE_ADMIN_KEY="%s"\n' "$(escape_env_value "$LICENSE_ADMIN_KEY_VALUE")"
        fi
    } > "$tmp_file"
    sudo install -d -m 700 -o root -g root "$ENV_DIR"
    sudo install -m 600 -o root -g root "$tmp_file" "$ENV_FILE"
    rm -f "$tmp_file"
    echo "[OK] 已写入环境变量文件: $ENV_FILE"
}

write_systemd_service() {
    sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=AK Proxy Server
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
Environment="PATH=${VENV_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=${VENV_BIN}/python proxy_server.py
Restart=always
RestartSec=10
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
    sudo touch "$LOG_FILE"
    sudo chown "${SERVICE_USER}:${SERVICE_USER}" "$LOG_FILE"
    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_NAME" >/dev/null
    echo "[OK] 已配置 systemd 服务: $SERVICE_NAME"
}

render_nginx() {
    if [ ! -f "$NGINX_RENDER_SCRIPT" ]; then
        echo "[ERROR] Nginx 渲染脚本不存在: $NGINX_RENDER_SCRIPT"
        exit 1
    fi
    NTFY_DOMAIN="$NTFY_DOMAIN_VALUE" ADMIN_DOMAIN="$ADMIN_DOMAIN" NGINX_CONF_SRC="$NGINX_CONF_SRC" NGINX_CONF_DST="$NGINX_CONF_DST" bash "$NGINX_RENDER_SCRIPT"
    sudo nginx -t
    sudo nginx -s reload
    echo "[OK] Nginx 已渲染并重载"
}

render_ntfy() {
    if [ ! -f "$NTFY_RENDER_SCRIPT" ]; then
        echo "[ERROR] ntfy 渲染脚本不存在: $NTFY_RENDER_SCRIPT"
        exit 1
    fi
    NTFY_DOMAIN="$NTFY_DOMAIN_VALUE" ADMIN_DOMAIN="$ADMIN_DOMAIN" NTFY_CONF_SRC="$NTFY_CONF_SRC" NTFY_CONF_DST="$NTFY_CONF_DST" bash "$NTFY_RENDER_SCRIPT"
    if systemctl list-unit-files --type=service 2>/dev/null | grep -q '^ntfy.service'; then
        sudo systemctl restart ntfy
        echo "[OK] ntfy 配置已渲染并重启"
    else
        echo "[OK] ntfy 配置已渲染"
    fi
}

restart_service() {
    sudo systemctl restart "$SERVICE_NAME"
    sudo systemctl status "$SERVICE_NAME" --no-pager | head -12
}

validate_domain
validate_license_url

if [ "$SKIP_ENV" -eq 0 ]; then
    ADMIN_PASSWORD_VALUE="$(read_secret ADMIN_PASSWORD "管理员主密码" "$ADMIN_PASSWORD_VALUE")"
    DB_SECONDARY_PASSWORD_VALUE="$(read_secret DB_SECONDARY_PASSWORD "数据库二级密码" "$DB_SECONDARY_PASSWORD_VALUE")"
    AK_PROXY_DB_PASSWORD_VALUE="$(read_secret AK_PROXY_DB_PASSWORD "PostgreSQL 数据库密码" "$AK_PROXY_DB_PASSWORD_VALUE")"
    prepare_license_admin_key
    write_env_file "$ADMIN_PASSWORD_VALUE" "$DB_SECONDARY_PASSWORD_VALUE" "$AK_PROXY_DB_PASSWORD_VALUE"
    write_systemd_service
fi

if [ "$SKIP_NGINX" -eq 0 ]; then
    render_nginx
    render_ntfy
fi

if [ "$SKIP_RESTART" -eq 0 ]; then
    restart_service
fi

echo "[OK] AK Proxy 管理流程执行完成"
