#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
SERVICE_NAME="${AK_PROXY_SERVICE_NAME:-ak-proxy}"
ENV_FILE="${AK_PROXY_ENV_FILE:-/etc/ak-proxy/ak-proxy.env}"
ENV_DIR="$(dirname "$ENV_FILE")"
BRANCH="${DEPLOY_BRANCH:-main}"
VENV_PY="${VENV_PY:-$REPO_DIR/venv/bin/python}"
DO_PULL=1
DO_RESTART=1
DO_STATUS=1
DO_PRINT_SUPER_TOTP=0
DO_NGINX_RELOAD=0
LICENSE_SERVER_URL_VALUE="${LICENSE_SERVER_URL:-}"
LICENSE_ADMIN_KEY_VALUE="${LICENSE_ADMIN_KEY:-}"

usage() {
    cat <<EOF
用法:
  bash public_admin/maintain_ak_proxy.sh [选项]

常用:
  bash public_admin/maintain_ak_proxy.sh
  bash public_admin/maintain_ak_proxy.sh --print-super-totp
  bash public_admin/maintain_ak_proxy.sh --license-server-url <URL> --license-admin-key <KEY>

选项:
  --repo-dir <目录>              Git 仓库根目录，默认自动按脚本位置推导
  --branch <分支>                拉取分支，默认 main
  --service-name <名称>          systemd 服务名，默认 ak-proxy
  --env-file <路径>              环境变量文件，默认 /etc/ak-proxy/ak-proxy.env
  --venv-python <路径>           Python 解释器，默认 <repo>/venv/bin/python
  --license-server-url <URL>     写入或更新 LICENSE_SERVER_URL，必须包含 http:// 或 https://
  --license-admin-key <KEY>      写入或更新 LICENSE_ADMIN_KEY
  --print-super-totp             打印 super_admin 的 Google Authenticator Secret 和 otpauth_uri
  --nginx-reload                 nginx -t 成功后 reload nginx
  --no-pull                      跳过 git pull
  --no-restart                   跳过 systemd restart
  --no-status                    跳过 systemd status
  -h, --help                     显示帮助
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --repo-dir)
            REPO_DIR="${2:-}"
            shift 2
            ;;
        --branch)
            BRANCH="${2:-}"
            shift 2
            ;;
        --service-name)
            SERVICE_NAME="${2:-}"
            shift 2
            ;;
        --env-file)
            ENV_FILE="${2:-}"
            ENV_DIR="$(dirname "$ENV_FILE")"
            shift 2
            ;;
        --venv-python)
            VENV_PY="${2:-}"
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
        --print-super-totp)
            DO_PRINT_SUPER_TOTP=1
            shift
            ;;
        --nginx-reload)
            DO_NGINX_RELOAD=1
            shift
            ;;
        --no-pull)
            DO_PULL=0
            shift
            ;;
        --no-restart)
            DO_RESTART=0
            shift
            ;;
        --no-status)
            DO_STATUS=0
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

if [ ! -d "$REPO_DIR/.git" ]; then
    echo "[ERROR] Git 仓库不存在: $REPO_DIR"
    exit 1
fi

if [ "$EUID" -eq 0 ]; then
    echo "[ERROR] 不要直接用 root 运行，请用服务用户执行，需要提权的步骤脚本会调用 sudo"
    exit 1
fi

ensure_env_file() {
    sudo install -d -m 700 -o root -g root "$ENV_DIR"
    if [ ! -f "$ENV_FILE" ]; then
        local tmp_file
        tmp_file="$(mktemp)"
        sudo install -m 600 -o root -g root "$tmp_file" "$ENV_FILE"
        rm -f "$tmp_file"
        echo "[OK] 已创建环境变量文件: $ENV_FILE"
    fi
}

validate_license_url() {
    local value="$1"
    if [ -z "$value" ]; then
        return 0
    fi
    if ! printf '%s' "$value" | grep -Eq '^https?://'; then
        echo "[ERROR] LICENSE_SERVER_URL 必须以 http:// 或 https:// 开头: $value"
        exit 1
    fi
}

escape_env_value() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

upsert_env_var() {
    local key="$1"
    local value="$2"
    if [ -z "$value" ]; then
        return 0
    fi
    local escaped
    escaped="$(escape_env_value "$value")"
    ensure_env_file
    if sudo grep -q "^${key}=" "$ENV_FILE"; then
        sudo sed -i "s|^${key}=.*|${key}=\"${escaped}\"|" "$ENV_FILE"
        echo "[OK] 已更新 $key"
    else
        printf '%s="%s"\n' "$key" "$escaped" | sudo tee -a "$ENV_FILE" >/dev/null
        echo "[OK] 已写入 $key"
    fi
}

pull_latest() {
    echo "[1/5] 拉取最新代码: $BRANCH"
    git -C "$REPO_DIR" fetch origin "$BRANCH"
    git -C "$REPO_DIR" pull --ff-only origin "$BRANCH"
}

update_env() {
    echo "[2/5] 检查环境变量文件: $ENV_FILE"
    ensure_env_file
    validate_license_url "$LICENSE_SERVER_URL_VALUE"
    upsert_env_var LICENSE_SERVER_URL "$LICENSE_SERVER_URL_VALUE"
    upsert_env_var LICENSE_ADMIN_KEY "$LICENSE_ADMIN_KEY_VALUE"
    if sudo grep -q '^LICENSE_SERVER_URL=' "$ENV_FILE"; then
        sudo grep -n '^LICENSE_SERVER_URL=' "$ENV_FILE"
    else
        echo "[WARN] LICENSE_SERVER_URL 未配置，激活码代理功能会不可用"
    fi
    if sudo grep -q '^LICENSE_ADMIN_KEY=' "$ENV_FILE"; then
        echo "[OK] LICENSE_ADMIN_KEY 已配置"
    else
        echo "[WARN] LICENSE_ADMIN_KEY 未配置，激活码代理功能会不可用"
    fi
}

restart_service() {
    echo "[3/5] 重启服务: $SERVICE_NAME"
    sudo systemctl restart "$SERVICE_NAME"
}

reload_nginx() {
    if [ "$DO_NGINX_RELOAD" -eq 0 ]; then
        return 0
    fi
    echo "[4/5] 检查并重载 nginx"
    sudo nginx -t
    sudo systemctl reload nginx
}

status_service() {
    if [ "$DO_STATUS" -eq 0 ]; then
        return 0
    fi
    echo "[5/5] 服务状态"
    sudo systemctl status "$SERVICE_NAME" --no-pager -l || true
}

print_super_totp() {
    if [ "$DO_PRINT_SUPER_TOTP" -eq 0 ]; then
        return 0
    fi
    if [ ! -x "$VENV_PY" ]; then
        echo "[ERROR] Python 解释器不存在或不可执行: $VENV_PY"
        exit 1
    fi
    echo "[TOTP] 打印 super_admin Google Authenticator 绑定信息"
    sudo env REPO_DIR="$REPO_DIR" bash -lc "set -a; source '$ENV_FILE'; set +a; cd '$REPO_DIR/public_admin'; '$VENV_PY' -" <<'PY'
import asyncio
import os
import sys

sys.path.insert(0, os.environ["REPO_DIR"])

from public_admin.server import database_pg as db
from public_admin.server.config import DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_MIN_POOL, DB_MAX_POOL
from public_admin.server.security.operation_auth.repository import OperationAuthRepository
from public_admin.server.security.operation_auth.service import OperationAuthService

async def main():
    await db.init_db(
        host=DB_HOST,
        port=DB_PORT,
        database=DB_NAME,
        user=DB_USER,
        password=DB_PASSWORD,
        min_size=DB_MIN_POOL,
        max_size=DB_MAX_POOL,
    )
    service = OperationAuthService(
        repository=OperationAuthRepository(db),
        super_admin_role="super_admin",
        sub_admin_role="sub_admin",
    )
    item = await service.ensure_secret("super_admin", "")
    print("账号: super_admin")
    print("Secret:", item.get("secret"))
    print("otpauth_uri:", item.get("otpauth_uri"))

asyncio.run(main())
PY
}

export REPO_DIR

if [ "$DO_PULL" -eq 1 ]; then
    pull_latest
else
    echo "[1/5] 跳过 git pull"
fi

update_env

if [ "$DO_RESTART" -eq 1 ]; then
    restart_service
else
    echo "[3/5] 跳过服务重启"
fi

reload_nginx
status_service

if [ "$DO_PRINT_SUPER_TOTP" -eq 1 ]; then
    print_super_totp
fi

echo "[OK] AK Proxy 维护流程完成"
