#!/bin/bash
set -e

REPO_DIR="${REPO_DIR:?请设置 REPO_DIR}"
BRANCH="${DEPLOY_BRANCH:-main}"
SKIP_GIT_PULL="${DEPLOY_SKIP_GIT_PULL:-0}"
RESTORE_GENERATED_GO_DIFF="${DEPLOY_RESTORE_GENERATED_GO_DIFF:-1}"

AK_PROXY_SCRIPT="$REPO_DIR/public_admin/deploy_ak_proxy.sh"
IM_SERVER_SCRIPT="$REPO_DIR/public_admin/deploy_im_server.sh"
MEDIA_WORKER_SCRIPT="$REPO_DIR/public_admin/deploy_im_media_worker.sh"

if [ "$EUID" -eq 0 ]; then
    echo "[ERROR] 不要使用 root 用户运行此脚本，请使用 ubuntu 用户执行"
    exit 1
fi

if [ ! -d "$REPO_DIR/.git" ]; then
    echo "[ERROR] Git 仓库不存在: $REPO_DIR"
    exit 1
fi

echo "========================================="
echo "AK Proxy 全服务一键部署"
echo "========================================="

cd "$REPO_DIR"

if [ "$SKIP_GIT_PULL" != "1" ]; then
    if ! git diff --quiet -- im_server/go.mod im_server/go.sum; then
        if [ "$RESTORE_GENERATED_GO_DIFF" = "1" ]; then
            echo "[CLEAN] 恢复 im_server/go.mod im_server/go.sum 的本地漂移"
            git checkout -- im_server/go.mod im_server/go.sum
        else
            echo "[ERROR] 检测到 im_server/go.mod 或 im_server/go.sum 有本地改动"
            echo "   默认会自动恢复这两个文件；如需保留本地改动，请执行："
            echo "   DEPLOY_RESTORE_GENERATED_GO_DIFF=0 bash $0"
            exit 1
        fi
    fi
    echo -e "\n[1/5] 拉取最新代码..."
    git fetch origin "$BRANCH"
    git pull --ff-only origin "$BRANCH"
else
    echo -e "\n[1/5] 跳过 git pull"
fi

for script_path in "$AK_PROXY_SCRIPT" "$IM_SERVER_SCRIPT" "$MEDIA_WORKER_SCRIPT"; do
    if [ ! -f "$script_path" ]; then
        echo "[ERROR] 部署脚本不存在: $script_path"
        exit 1
    fi
done

echo -e "\n[2/5] 部署 ak-proxy Web/API 服务..."
bash "$AK_PROXY_SCRIPT"

echo -e "\n[3/5] 部署 im-server 服务..."
bash "$IM_SERVER_SCRIPT"

echo -e "\n[4/5] 部署 im-media-worker 服务..."
bash "$MEDIA_WORKER_SCRIPT"

echo -e "\n[5/5] 检查服务状态..."
for service_name in ak-proxy im-server im-media-worker; do
    if sudo systemctl is-active --quiet "$service_name"; then
        echo "[OK] $service_name 运行中"
    else
        echo "[ERROR] $service_name 未运行"
        sudo systemctl status "$service_name" --no-pager | head -20 || true
        exit 1
    fi
done

echo -e "\n--- 服务摘要 ---"
sudo systemctl status ak-proxy --no-pager | head -8 || true
sudo systemctl status im-server --no-pager | head -8 || true
sudo systemctl status im-media-worker --no-pager | head -8 || true

echo -e "\n========================================="
echo "[OK] 全服务部署完成"
echo "========================================="
