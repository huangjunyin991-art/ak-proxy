# AK Proxy systemd deployment

## 1) Install service file

```bash
sudo cp /home/ubuntu/ak-proxy/deploy/systemd/ak-proxy.service /etc/systemd/system/ak-proxy.service
sudo systemctl daemon-reload
sudo systemctl enable --now ak-proxy
```

## 2) Configure secret (token-based ntfy account switch)

Create `/etc/ak-proxy/ak-proxy.env`:

```bash
sudo install -d -m 700 /etc/ak-proxy
sudo bash -lc 'cat > /etc/ak-proxy/ak-proxy.env <<"EOF"
NOTIFY_CENTER_INTERNAL_SECRET=CHANGE_ME_TO_A_LONG_RANDOM_SECRET
EOF'

sudo systemctl restart ak-proxy
```

## Notes
- `EnvironmentFile=/etc/ak-proxy/ak-proxy.env` is required so a missing database
  password fails at service startup instead of causing a restart loop later.
- 进程级资源守卫会在文件描述符持续达到 85%（默认 15 秒）时发送 `SIGTERM`，
  由 systemd 自动重启；systemd 同时限制 5 分钟内最多连续启动 5 次，避免重启风暴。
- If `NOTIFY_CENTER_INTERNAL_SECRET` is missing, token verification for `/admin/api/ak_auth/switch_by_token` will fail.
