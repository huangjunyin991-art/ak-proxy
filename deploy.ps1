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
echo '备份配置...'
cp /etc/nginx/sites-enabled/ak2025.conf /etc/nginx/sites-enabled/ak2025.conf.bak

if ! grep -q 'location.*\/api\/' /etc/nginx/sites-enabled/ak2025.conf; then
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
        }' /etc/nginx/sites-enabled/ak2025.conf
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
