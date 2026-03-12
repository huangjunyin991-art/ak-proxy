#!/bin/bash
# AK透明代理 - Nginx API路由部署脚本
# 使用方法: 将此文件上传到服务器后执行 bash deploy_nginx_api.sh

set -e  # 遇到错误立即退出

echo "========================================"
echo "  AK透明代理 - Nginx API路由部署"
echo "========================================"
echo ""

# 检查是否为root或sudo
if [[ $EUID -ne 0 ]] && ! sudo -n true 2>/dev/null; then
   echo "❌ 需要sudo权限，请使用 sudo bash deploy_nginx_api.sh"
   exit 1
fi

# 1. 备份当前配置
echo "📦 步骤1: 备份Nginx配置..."
BACKUP_FILE="/etc/nginx/sites-enabled/ak2025.conf.backup_$(date +%Y%m%d_%H%M%S)"
sudo cp /etc/nginx/sites-enabled/ak2025.conf "$BACKUP_FILE"
echo "✅ 备份完成: $BACKUP_FILE"
echo ""

# 2. 检查/api路由是否已存在
echo "🔍 步骤2: 检查/api路由..."
if sudo grep -q "location.*\/api\/" /etc/nginx/sites-enabled/ak2025.conf; then
    echo "⚠️  /api路由已存在，跳过添加"
    SKIP_ADD=true
else
    echo "➕ 准备添加/api路由"
    SKIP_ADD=false
fi
echo ""

# 3. 添加/api路由
if [ "$SKIP_ADD" = false ]; then
    echo "✏️  步骤3: 添加/api路由到Nginx配置..."
    
    # 创建临时文件
    TEMP_FILE=$(mktemp)
    
    # 在/admin路由后添加/api路由
    sudo awk '
    /location \^~ \/admin \{/,/^[[:space:]]*\}[[:space:]]*$/ {
        print
        if (/^[[:space:]]*\}[[:space:]]*$/ && !added) {
            print ""
            print "        # 透明代理管理API"
            print "        location ^~ /api/ {"
            print "            proxy_pass http://127.0.0.1:8080;"
            print "            proxy_set_header Host $host;"
            print "            proxy_set_header X-Real-IP $remote_addr;"
            print "            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;"
            print "            proxy_set_header X-Forwarded-Proto $scheme;"
            print "            proxy_http_version 1.1;"
            print "            proxy_connect_timeout 30s;"
            print "            proxy_read_timeout 300s;"
            print "            "
            print "            add_header Access-Control-Allow-Origin \"https://ak2025.vip\" always;"
            print "            add_header Access-Control-Allow-Methods \"GET, POST, PUT, DELETE, OPTIONS\" always;"
            print "            add_header Access-Control-Allow-Headers \"Content-Type, Authorization\" always;"
            print "            "
            print "            if ($request_method = OPTIONS) {"
            print "                return 204;"
            print "            }"
            print "        }"
            added=1
        }
        next
    }
    {print}
    ' /etc/nginx/sites-enabled/ak2025.conf > "$TEMP_FILE"
    
    # 替换原文件
    sudo mv "$TEMP_FILE" /etc/nginx/sites-enabled/ak2025.conf
    echo "✅ /api路由已添加"
else
    echo "⏭️  步骤3: 跳过（路由已存在）"
fi
echo ""

# 4. 测试Nginx配置
echo "🧪 步骤4: 测试Nginx配置..."
if sudo nginx -t 2>&1 | grep -q "successful"; then
    echo "✅ Nginx配置测试通过"
else
    echo "❌ Nginx配置测试失败，请检查语法"
    echo "恢复备份: sudo cp $BACKUP_FILE /etc/nginx/sites-enabled/ak2025.conf"
    sudo nginx -t
    exit 1
fi
echo ""

# 5. 重载Nginx
echo "🔄 步骤5: 重载Nginx服务..."
sudo nginx -s reload
echo "✅ Nginx已重载"
echo ""

# 6. 验证/api路由
echo "✅ 步骤6: 验证/api路由..."
sleep 2
if curl -s -k https://127.0.0.1/api/dispatcher 2>/dev/null | grep -q "total_exits"; then
    echo "✅ /api路由工作正常"
elif curl -s http://127.0.0.1:8080/api/dispatcher 2>/dev/null | grep -q "total_exits"; then
    echo "✅ 代理服务器运行正常（直接访问8080端口）"
    echo "⚠️  HTTPS路由可能需要调整，但不影响功能"
else
    echo "⚠️  无法验证/api路由，请手动检查"
    echo "测试命令: curl -s http://127.0.0.1:8080/api/dispatcher"
fi
echo ""

# 7. 显示出口状态
echo "📊 步骤7: 当前出口状态..."
EXITS_COUNT=$(curl -s http://127.0.0.1:8080/api/dispatcher 2>/dev/null | grep -o '"total_exits":[0-9]*' | grep -o '[0-9]*')
if [ -n "$EXITS_COUNT" ]; then
    echo "✅ 调度器当前有 $EXITS_COUNT 个出口"
else
    echo "⚠️  无法获取出口数量"
fi
echo ""

echo "========================================"
echo "  ✅ 部署完成！"
echo "========================================"
echo ""
echo "📋 下一步操作："
echo "1. 刷新管理后台: https://ak2025.vip/admin (按 Ctrl+Shift+R)"
echo "2. 查看负载均衡页面，应该显示 $EXITS_COUNT 个服务器"
echo "3. 如遇问题，恢复备份: sudo cp $BACKUP_FILE /etc/nginx/sites-enabled/ak2025.conf"
echo ""
