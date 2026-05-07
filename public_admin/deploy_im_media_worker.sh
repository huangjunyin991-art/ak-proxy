#!/bin/bash
set -e

REPO_DIR="${REPO_DIR:?请设置 REPO_DIR}"
IM_DIR="$REPO_DIR/im_server"
IM_BIN_DIR="$IM_DIR/bin"
WORKER_BIN="$IM_BIN_DIR/im-media-worker"
SERVICE_NAME="${IM_MEDIA_WORKER_SERVICE_NAME:-im-media-worker}"
SERVICE_USER="${IM_MEDIA_WORKER_SERVICE_USER:?请设置 IM_MEDIA_WORKER_SERVICE_USER}"
GO_BIN="${GO_BIN:-/usr/local/go/bin/go}"
DB_URL="${IM_DATABASE_URL:?请设置 IM_DATABASE_URL}"
APT_UPDATED=0
CPU_CORES="$(nproc 2>/dev/null || echo 2)"
CPU_QUOTA_PERCENT="${IM_MEDIA_WORKER_CPU_QUOTA_PERCENT:-$((CPU_CORES * 50))}"
TOTAL_MEMORY_MB="$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null)"
if [ -z "$TOTAL_MEMORY_MB" ] || [ "$TOTAL_MEMORY_MB" -le 0 ]; then
    TOTAL_MEMORY_MB=2048
fi
DEFAULT_MEMORY_HIGH_MB="$((TOTAL_MEMORY_MB * 40 / 100))"
if [ "$DEFAULT_MEMORY_HIGH_MB" -lt 512 ]; then
    DEFAULT_MEMORY_HIGH_MB=512
fi
MEMORY_HIGH_MB="${IM_MEDIA_WORKER_MEMORY_HIGH_MB:-$DEFAULT_MEMORY_HIGH_MB}"

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

ensure_command_package vips libvips-tools
ensure_go

if [ ! -x "$GO_BIN" ]; then
    echo "[ERROR] Go 未安装或不可执行: $GO_BIN"
    exit 1
fi

mkdir -p "$IM_BIN_DIR"

cd "$IM_DIR"
"$GO_BIN" version
vips --version
"$GO_BIN" mod download
"$GO_BIN" build -o "$WORKER_BIN" ./cmd/media_worker

sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=AK IM Media Worker
After=network.target postgresql.service

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${IM_DIR}
Environment="IM_DATABASE_URL=${DB_URL}"
Environment="IM_IMAGE_STORE_DIR=$IM_DIR/data/im/image_assets"
Environment="IM_MEDIA_WORKER_SCAN_SECONDS=5"
Environment="IM_MEDIA_WORKER_BATCH_SIZE=1"
Environment="IM_MEDIA_PREVIEW_LONG_EDGE=1920"
Environment="IM_MEDIA_BACKFILL_PREVIEW_LONG_EDGE=1280"
Environment="IM_MEDIA_BACKFILL_ENQUEUE_LIMIT=4"
Environment="IM_MEDIA_BACKFILL_MIN_FILE_SIZE=131072"
Environment="IM_MEDIA_WORKER_RESERVE_CPU_PERCENT=50"
Environment="IM_MEDIA_WORKER_MEMORY_HIGH_WATER_PERCENT=75"
Environment="IM_MEDIA_WORKER_MIN_AVAILABLE_MEMORY_MB=512"
Environment="IM_MEDIA_WORKER_MAX_CONCURRENCY=1"
Environment="VIPS_CONCURRENCY=1"
Environment="VIPS_CACHE_MAX=0"
Environment="VIPS_CACHE_MAX_MEM=0"
Environment="VIPS_CACHE_MAX_FILES=0"
Environment="G_DEBUG=gc-friendly"
Environment="G_SLICE=always-malloc"
Environment="MALLOC_ARENA_MAX=1"
Environment="MALLOC_TRIM_THRESHOLD_=131072"
ExecStart=${WORKER_BIN}
Restart=always
RestartSec=5
LimitNOFILE=65536
CPUQuota=${CPU_QUOTA_PERCENT}%
MemoryAccounting=true
MemoryHigh=${MEMORY_HIGH_MB}M
Nice=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"
sleep 2
sudo systemctl status "$SERVICE_NAME" --no-pager | head -12
