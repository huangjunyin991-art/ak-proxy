#!/bin/bash
# AK-Proxy 完整部署脚本
# 用途：创建systemd服务，实现自动重启和开机自启
# 使用：chmod +x deploy_ak_proxy.sh && ./deploy_ak_proxy.sh

set -e

echo "========================================="
echo "AK-Proxy 部署脚本"
echo "========================================="

# 检查是否为root用户或使用sudo
if [ "$EUID" -eq 0 ]; then 
    echo "警告: 不要使用root用户运行此脚本"
    echo "请使用: ./deploy_ak_proxy.sh"
    exit 1
fi

echo -e "\n[1/6] 创建 systemd 服务文件..."
sudo tee /etc/systemd/system/ak-proxy.service > /dev/null <<'EOF'
[Unit]
Description=AK Proxy Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/ak-proxy/public_admin
Environment="PATH=/home/ubuntu/ak-proxy/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=/home/ubuntu/ak-proxy/venv/bin/python proxy_server.py
Restart=always
RestartSec=10
StandardOutput=append:/home/ubuntu/ak-proxy/public_admin/proxy.log
StandardError=append:/home/ubuntu/ak-proxy/public_admin/proxy.log
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

if [ $? -eq 0 ]; then
    echo "✅ systemd 服务文件创建成功"
else
    echo "❌ systemd 服务文件创建失败"
    exit 1
fi

# 初始化日志文件（避免权限问题）
sudo touch /home/ubuntu/ak-proxy/public_admin/proxy.log
sudo chown ubuntu:ubuntu /home/ubuntu/ak-proxy/public_admin/proxy.log
echo "✅ 日志文件权限已设置"

echo -e "\n[2/6] 重新加载 systemd 配置..."
sudo systemctl daemon-reload
echo "✅ systemd 配置已重新加载"

echo -e "\n[3/6] 启用开机自启动..."
sudo systemctl enable ak-proxy
echo "✅ 已启用开机自启动"

echo -e "\n[4/6] 启动 ak-proxy 服务..."
sudo systemctl start ak-proxy
sleep 3
echo "✅ 服务已启动"

echo -e "\n[5/6] 检查服务状态..."
sudo systemctl status ak-proxy --no-pager || true

echo -e "\n[6/6] 验证服务..."
echo -e "\n--- 最新日志（最后20行）---"
tail -20 ~/ak-proxy/public_admin/proxy.log

echo -e "\n--- API 测试 ---"
if curl -I http://localhost:8080/api/stats 2>/dev/null | grep -q "HTTP"; then
    echo "✅ API 测试成功"
else
    echo "⚠️  API 测试失败，请检查日志"
fi

echo -e "\n--- 网站测试 ---"
if curl -I https://ak2025.vip 2>/dev/null | grep -q "HTTP"; then
    echo "✅ 网站访问正常"
else
    echo "⚠️  网站访问失败"
fi

echo -e "\n========================================="
echo "✅ 部署完成！"
echo "========================================="
echo ""
echo "管理命令："
echo "  启动服务: sudo systemctl start ak-proxy"
echo "  停止服务: sudo systemctl stop ak-proxy"
echo "  重启服务: sudo systemctl restart ak-proxy"
echo "  查看状态: sudo systemctl status ak-proxy"
echo "  实时日志: sudo journalctl -u ak-proxy -f"
echo "  应用日志: tail -f ~/ak-proxy/public_admin/proxy.log"
echo ""
echo "========================================="
