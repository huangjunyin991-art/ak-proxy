# 事故记录：Cloudflare 共享边缘 IP 被错误封禁

## 影响

2026-09-03，正常网页用户在从浏览器后台恢复后收到 IP 封禁提示。封禁记录中的 `162.159.113.53` 与 `172.71.*` 是 Cloudflare 边缘地址，不是用户设备的真实公网 IP。

受影响的规则是 `/RPC/Login` 的短间隔防御：连续三次小于五秒的调用会触发一小时 IP 封禁。由于多个真实用户被聚合到同一个 Cloudflare 边缘 IP，任何一个用户都可能命中其他用户累计的计数。

## 根因

Nginx 向应用传递 `X-Real-IP $remote_addr`，但没有配置 Cloudflare Real IP 模块。经 Cloudflare 访问时，`$remote_addr` 是 Cloudflare 回源节点。应用层信任来自本地 Nginx 的 `X-Real-IP`，于是将共享边缘地址作为防御计数和封禁键。

该问题长期潜伏：规则按边缘节点的请求量触发，只有多个用户恰好被调度到相同边缘节点并在短窗口内登录时才会暴露。

## 修复

1. Nginx 模板仅对 Cloudflare 官方 IP 段信任 `CF-Connecting-IP`，恢复真实访客地址后再写入 `X-Real-IP`。
2. 应用层将 Cloudflare 边缘地址视为未知来源，不参与任何主动防御或 IP 封禁。即使 Nginx 配置遗漏，也不会再封禁共享边缘地址。
3. 新增回归测试，覆盖 Cloudflare IPv4 地址、转发头回退和已恢复真实客户端地址。

## 防复发验证

部署后应确认 `nginx -T` 包含 `real_ip_header CF-Connecting-IP` 与所有 `set_real_ip_from` 网段；从 Cloudflare 访问一次后，应用登录日志中的 IP 应为设备真实公网 IP，而不是 `162.158.*`、`172.64.*` 或 `172.71.*`。
