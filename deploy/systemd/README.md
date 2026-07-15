# AK Proxy systemd deployment

## 1) Install service file

```bash
sudo cp /home/ubuntu/ak-proxy/deploy/systemd/ak-proxy.service /etc/systemd/system/ak-proxy.service
sudo systemctl daemon-reload
sudo systemctl enable --now ak-proxy
```

## 2) Configure secret (token-based ntfy account switch)

Create `/etc/ak-proxy.env`:

```bash
sudo bash -lc 'cat > /etc/ak-proxy.env <<"EOF"
NOTIFY_CENTER_INTERNAL_SECRET=CHANGE_ME_TO_A_LONG_RANDOM_SECRET
EOF'

sudo systemctl restart ak-proxy
```

## Notes
- `EnvironmentFile=-/etc/ak-proxy.env` is optional; service still starts without it.
- If `NOTIFY_CENTER_INTERNAL_SECRET` is missing, token verification for `/admin/api/ak_auth/switch_by_token` will fail.
