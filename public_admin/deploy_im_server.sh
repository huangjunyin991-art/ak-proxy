#!/bin/bash
set -e

REPO_DIR="${REPO_DIR:?请设置 REPO_DIR}"
IM_DIR="$REPO_DIR/im_server"
IM_BIN_DIR="$IM_DIR/bin"
IM_BIN="$IM_BIN_DIR/im-server"
SERVICE_NAME="${IM_SERVER_SERVICE_NAME:-im-server}"
SERVICE_USER="${IM_SERVER_SERVICE_USER:?请设置 IM_SERVER_SERVICE_USER}"
GO_BIN="${GO_BIN:-/usr/local/go/bin/go}"
DB_URL="${IM_DATABASE_URL:?请设置 IM_DATABASE_URL}"
ALLOWED_ORIGIN="${IM_ALLOWED_ORIGIN:?请设置 IM_ALLOWED_ORIGIN}"
AK_PROXY_ENV_FILE="${AK_PROXY_ENV_FILE:-/etc/ak-proxy/ak-proxy.env}"
if [ -f "$AK_PROXY_ENV_FILE" ]; then
    set -a
    . "$AK_PROXY_ENV_FILE"
    set +a
fi
NOTIFY_CENTER_WEBHOOK_URL="${IM_NOTIFY_CENTER_WEBHOOK_URL:-http://127.0.0.1:8080/internal/notify-center/im-message}"
NOTIFY_CENTER_WEBHOOK_SECRET="${IM_NOTIFY_CENTER_WEBHOOK_SECRET:-${NOTIFY_CENTER_INTERNAL_SECRET:-}}"
NOTIFY_CENTER_ENABLED="${IM_NOTIFY_CENTER_ENABLED:-${NOTIFY_CENTER_ENABLED:-}}"
if [ -z "$NOTIFY_CENTER_ENABLED" ]; then
    if [ -n "$NOTIFY_CENTER_WEBHOOK_SECRET" ]; then
        NOTIFY_CENTER_ENABLED="1"
    else
        NOTIFY_CENTER_ENABLED="0"
    fi
fi
APT_UPDATED=0

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

apt_update_once() {
    if [ "$APT_UPDATED" -eq 0 ]; then
        sudo apt-get update
        APT_UPDATED=1
    fi
}

install_apt_packages() {
    apt_update_once
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
}

ensure_command_package() {
    local command_name="$1"
    local package_name="$2"
    if ! command_exists "$command_name"; then
        echo "[INFO] 安装依赖: $package_name"
        install_apt_packages "$package_name"
    fi
}

ensure_runtime_dependencies() {
    ensure_command_package ffmpeg ffmpeg
    ensure_command_package curl curl
    ensure_command_package git git
    install_apt_packages ca-certificates
    sudo update-ca-certificates >/dev/null
}

ensure_go() {
    if [ -x "$GO_BIN" ]; then
        return
    fi
    if command_exists go; then
        GO_BIN="$(command -v go)"
        return
    fi
    echo "[INFO] 安装依赖: golang-go"
    install_apt_packages golang-go
    GO_BIN="$(command -v go)"
}

if [ ! -d "$IM_DIR" ]; then
    echo "[ERROR] im_server 目录不存在: $IM_DIR"
    exit 1
fi

ensure_runtime_dependencies
ensure_go

if [ ! -x "$GO_BIN" ]; then
    echo "[ERROR] Go 未安装或不可执行: $GO_BIN"
    exit 1
fi

case "$NOTIFY_CENTER_ENABLED" in
    1|true|TRUE|yes|YES|on|ON|enabled|ENABLED)
        if [ -z "$NOTIFY_CENTER_WEBHOOK_SECRET" ]; then
            echo "[ERROR] 已启用 IM 通知中心，但缺少 IM_NOTIFY_CENTER_WEBHOOK_SECRET 或 NOTIFY_CENTER_INTERNAL_SECRET"
            exit 1
        fi
        ;;
esac

mkdir -p "$IM_BIN_DIR"

cd "$IM_DIR"
"$GO_BIN" version
ffmpeg -version | head -1
"$GO_BIN" mod download
"$GO_BIN" build -o "$IM_BIN" ./cmd/im_server

sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=AK Internal IM Server
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${IM_DIR}
Environment="IM_ADDR=127.0.0.1:18081"
Environment="IM_DATABASE_URL=${DB_URL}"
Environment="IM_ALLOWED_ORIGIN=${ALLOWED_ORIGIN}"
Environment="IM_AUTH_COOKIE=ak_username"
Environment="IM_NOTIFY_CENTER_ENABLED=${NOTIFY_CENTER_ENABLED}"
Environment="IM_NOTIFY_CENTER_WEBHOOK_URL=${NOTIFY_CENTER_WEBHOOK_URL}"
Environment="IM_NOTIFY_CENTER_WEBHOOK_SECRET=${NOTIFY_CENTER_WEBHOOK_SECRET}"
ExecStart=${IM_BIN}
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"
sleep 2
sudo systemctl status "$SERVICE_NAME" --no-pager | head -12
