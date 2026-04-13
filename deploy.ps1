# AK代理 - 一键部署脚本
$ErrorActionPreference = "Stop"

Write-Host "=== AK透明代理 - Nginx部署 ===" -ForegroundColor Cyan

# 获取密码
$securePassword = Read-Host "请输入SSH密码" -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$password = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)

Write-Host "连接服务器..." -ForegroundColor Yellow

# SSH命令
$sshCommand = @"
sudo -S bash << 'DEPLOY_END'
NGINX_CONF_PATH=/etc/nginx/sites-enabled/nginx.conf
LEGACY_NGINX_CONF=/etc/nginx/sites-enabled/ak2025.conf

echo '统一活动配置...'
if [ ! -f "$NGINX_CONF_PATH" ] && [ -f "$LEGACY_NGINX_CONF" ]; then
    cp "$LEGACY_NGINX_CONF" "$NGINX_CONF_PATH"
    rm -f "$LEGACY_NGINX_CONF"
    echo '✅ 已迁移旧配置到 nginx.conf'
elif [ -f "$LEGACY_NGINX_CONF" ] && [ "$LEGACY_NGINX_CONF" != "$NGINX_CONF_PATH" ]; then
    cp "$LEGACY_NGINX_CONF" "${LEGACY_NGINX_CONF}.bak"
    rm -f "$LEGACY_NGINX_CONF"
    echo '✅ 已备份并移除旧 ak2025.conf'
fi

echo '备份配置...'
cp "$NGINX_CONF_PATH" "${NGINX_CONF_PATH}.bak"

if ! grep -q 'location.*\/api\/' "$NGINX_CONF_PATH"; then
    echo '添加/api路由...'
    sed -i '/location \^~ \/admin {/a\
\
        location ^~ /api/ {\
            proxy_pass http://127.0.0.1:8080;\
            proxy_set_header Host \$host;\
            proxy_set_header X-Real-IP \$remote_addr;\
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;\
            proxy_set_header X-Forwarded-Proto \$scheme;\
            proxy_http_version 1.1;\
            proxy_connect_timeout 30s;\
            proxy_read_timeout 300s;\
            add_header Access-Control-Allow-Origin "https://ak2025.vip" always;\
            add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;\
            add_header Access-Control-Allow-Headers "Content-Type, Authorization" always;\
            if (\$request_method = OPTIONS) { return 204; }\
        }' "$NGINX_CONF_PATH"
    echo '✅ /api路由已添加'
else
    echo '⚠️  /api路由已存在'
fi

echo '测试配置...'
nginx -t

echo '重载Nginx...'
nginx -s reload

echo '✅ 部署完成！'
DEPLOY_END
"@

# 执行
echo $password | ssh ubuntu@152.32.216.95 $sshCommand

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n✅ 部署成功！" -ForegroundColor Green
    Write-Host "请刷新管理后台 (Ctrl+Shift+R) 查看35个服务器" -ForegroundColor Cyan
} else {
    Write-Host "`n❌ 部署失败" -ForegroundColor Red
}
