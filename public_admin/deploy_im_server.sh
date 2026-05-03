#!/bin/bash
set -e

REPO_DIR="/home/ubuntu/ak-proxy"
IM_DIR="$REPO_DIR/im_server"
IM_BIN_DIR="$IM_DIR/bin"
IM_BIN="$IM_BIN_DIR/im-server"
SERVICE_NAME="im-server"
GO_BIN="${GO_BIN:-/usr/local/go/bin/go}"
DB_URL="${IM_DATABASE_URL:-postgres://ak_proxy:ak2026db@127.0.0.1:5432/ak_proxy?sslmode=disable}"
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
        echo "📦 安装依赖: $package_name"
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
    echo "📦 安装依赖: golang-go"
    install_apt_packages golang-go
    GO_BIN="$(command -v go)"
}

if [ ! -d "$IM_DIR" ]; then
    echo "❌ im_server 目录不存在: $IM_DIR"
    exit 1
fi

ensure_runtime_dependencies
ensure_go

if [ ! -x "$GO_BIN" ]; then
    echo "❌ Go 未安装或不可执行: $GO_BIN"
    exit 1
fi

mkdir -p "$IM_BIN_DIR"

cd "$IM_DIR"
"$GO_BIN" version
ffmpeg -version | head -1
"$GO_BIN" mod tidy
"$GO_BIN" build -o "$IM_BIN" ./cmd/im_server

sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=AK Internal IM Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=${IM_DIR}
Environment="IM_ADDR=:18081"
Environment="IM_DATABASE_URL=${DB_URL}"
Environment="IM_ALLOWED_ORIGIN=https://ak2025.vip"
Environment="IM_AUTH_COOKIE=ak_username"
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
