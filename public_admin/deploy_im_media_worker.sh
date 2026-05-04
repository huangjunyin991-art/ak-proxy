#!/bin/bash
set -e

REPO_DIR="/home/ubuntu/ak-proxy"
IM_DIR="$REPO_DIR/im_server"
IM_BIN_DIR="$IM_DIR/bin"
WORKER_BIN="$IM_BIN_DIR/im-media-worker"
SERVICE_NAME="im-media-worker"
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

ensure_command_package vips libvips-tools
ensure_go

if [ ! -x "$GO_BIN" ]; then
    echo "❌ Go 未安装或不可执行: $GO_BIN"
    exit 1
fi

mkdir -p "$IM_BIN_DIR"

cd "$IM_DIR"
"$GO_BIN" version
vips --version
"$GO_BIN" mod tidy
"$GO_BIN" build -o "$WORKER_BIN" ./cmd/media_worker

sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=AK IM Media Worker
After=network.target postgresql.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=${IM_DIR}
Environment="IM_DATABASE_URL=${DB_URL}"
Environment="IM_IMAGE_STORE_DIR=$IM_DIR/data/im/image_assets"
Environment="IM_MEDIA_WORKER_SCAN_SECONDS=5"
Environment="IM_MEDIA_WORKER_BATCH_SIZE=4"
Environment="IM_MEDIA_PREVIEW_LONG_EDGE=1920"
ExecStart=${WORKER_BIN}
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
