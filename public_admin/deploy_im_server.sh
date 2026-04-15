#!/bin/bash
set -e

REPO_DIR="/home/ubuntu/ak-proxy"
IM_DIR="$REPO_DIR/im_server"
IM_BIN_DIR="$IM_DIR/bin"
IM_BIN="$IM_BIN_DIR/im-server"
SERVICE_NAME="im-server"
GO_BIN="${GO_BIN:-/usr/local/go/bin/go}"
DB_URL="${IM_DATABASE_URL:-postgres://ak_proxy:ak2026db@127.0.0.1:5432/ak_proxy?sslmode=disable}"

if [ ! -x "$GO_BIN" ]; then
    echo "❌ Go 未安装或不可执行: $GO_BIN"
    exit 1
fi

if [ ! -d "$IM_DIR" ]; then
    echo "❌ im_server 目录不存在: $IM_DIR"
    exit 1
fi

mkdir -p "$IM_BIN_DIR"

cd "$IM_DIR"
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
