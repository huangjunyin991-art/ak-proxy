#!/bin/bash
# 上传sing-box配置到服务器并重启服务

echo "正在上传配置到服务器..."

# 复制配置文件
scp singbox_config.json ubuntu@10-7-136-153:~/sing-box/config.json

echo "重启sing-box服务..."
ssh ubuntu@10-7-136-153 "sudo systemctl restart sing-box && sudo systemctl status sing-box"

echo "完成！"
