# 高保障加固蓝图（2026-06-06）

本文档是在第一轮源码审计基础上的高保障复核结果，目标不是“能跑”，而是把系统按高敏感生产系统来约束：身份边界必须可证明，凭据泄露半径必须受控，内部接口不能依赖部署偶然性，任何失败路径都应默认拒绝。

## 1. 高保障准则

### 1.1 不可违反的安全不变量

| 编号 | 不变量 | 说明 |
|---|---|---|
| INV-01 | 客户端可写状态不能作为身份事实 | `cookie`、`localStorage`、请求头、URL 查询参数只能作为候选输入，不能直接授权。 |
| INV-02 | 数据库泄露不应等于账号接管 | 密码、AK userkey、会话 Cookie、TOTP 密钥、Admin Token 必须哈希、加密或不可逆化。 |
| INV-03 | 反向代理后的 loopback 不等于内部调用 | 如果 Nginx 把公网请求代理到 `127.0.0.1`，后端看到的 `RemoteAddr` 仍可能是 loopback。 |
| INV-04 | 高危操作必须有作用域能力票据 | 不能用一个全局二次验证租约覆盖所有危险动作。 |
| INV-05 | 白名单、鉴权、上游状态异常时必须 fail closed | 无法确认权限时拒绝，而不是按公开模式放行。 |
| INV-06 | 日志和前端持久化不得包含可复用凭据 | trace/debug 只能记录不可逆摘要、长度、状态码、请求 ID。 |
| INV-07 | WebSocket 建连前必须完成身份和权限绑定 | 不能先接入连接池再等客户端自报身份。 |
| INV-08 | 对外 HTTP 拉取必须经过 SSRF 策略网关 | 任何用户可配置 URL 都需要协议、域名、IP 段、重定向和超时控制。 |

### 1.2 资产分级

| 级别 | 资产 | 保护目标 |
|---|---|---|
| S0 | AK 密码、AK userkey、登录 Cookie、Admin Token、TOTP Secret、内部 Notify Secret | 不落明文；不进浏览器持久化；泄露后可快速吊销和审计。 |
| S1 | 账号身份、IM 用户身份、授权账号列表、通知订阅、远程协助会话 | 只能由服务端会话或签名令牌推导；不能由客户端自报。 |
| S2 | 运行状态、调度器摘要、账号在线状态、错误追踪 | 对普通用户最小可见；对外响应去敏。 |

## 2. P0 风险与加固设计

### P0-EDGE-001：IM internal 接口可经公网代理命中

**证据**

- [public_admin/config/nginx.conf](D:/PycharmProjects/ak-proxy/public_admin/config/nginx.conf) 将 `/im/` 统一代理到 `http://127.0.0.1:18081`。
- [im_server/internal/app/conversation_features.go](D:/PycharmProjects/ak-proxy/im_server/internal/app/conversation_features.go) 的 internal group profile 入口只检查 `r.RemoteAddr` 是否 loopback。
- 在上述部署组合下，公网请求进入 Nginx 后，Go 服务看到的来源可能是 `127.0.0.1`，从而绕过“内部接口”假设。

**设计**

- `EdgeBoundary`：Nginx 默认拒绝 `/im/internal/`，只允许显式内网 location 或 Unix socket。
- `InternalAuthMiddleware`：内部接口要求 `X-AK-Internal-Timestamp`、`X-AK-Internal-Nonce`、`X-AK-Internal-Signature`，使用服务端共享密钥 HMAC，带时间窗和 nonce replay cache。
- `RouteRegistry`：所有 `/internal/` 路由集中注册，启动时输出路由清单，CI 检查是否被公网 location 覆盖。

**验收**

- 公网请求 `/im/internal/*` 返回 404/403。
- 直接 loopback 请求缺少签名也返回 401/403。
- 签名过期、nonce 重放、签名错误都有单元测试。

### P0-ID-001：客户端可写身份贯穿 IM、Chat、Notify

**证据**

- [im_server/internal/app/app.go](D:/PycharmProjects/ak-proxy/im_server/internal/app/app.go) 从 `X-AK-Username`、`ak_username`、`username` 查询参数解析身份。
- [public_admin/server/proxy_server.py](D:/PycharmProjects/ak-proxy/public_admin/server/proxy_server.py) 的 `/chat/ws`、远程协助、语音 WebSocket 主要依赖 query/session/role。
- [public_admin/plugins/notify_center/server/router.py](D:/PycharmProjects/ak-proxy/public_admin/plugins/notify_center/server/router.py) 信任 `X-AK-IM-Username` 和 `ak_im_username`。
- 前端多处写入 `ak_username`、`ak_im_username`，这些 Cookie 对 JS 可写。

**设计**

- `IdentityGateway`：登录成功后由服务端签发短期 `ak_session`，`HttpOnly`、`Secure`、`SameSite=Lax/Strict`。
- `ImAuthToken`：IM 和 Notify 使用服务端签发的 audience-scoped JWT/PASETO 或 HMAC token，包含 `sub`、`aud`、`exp`、`sid`、`roles`。
- `RealtimeAuthGateway`：WebSocket 握手阶段验证 token，未通过时不进入连接管理器。
- `ClientHints`：保留 `username`、`X-AK-Username` 仅用于日志关联或 UI hint，不能授权。

**验收**

- 修改浏览器 Cookie、localStorage、`X-AK-Username` 不能切换身份。
- WebSocket 不带 token 不能建立业务连接。
- Notify user endpoint 的用户名只能来自服务端会话解析。

### P0-CRED-001：AK 凭据在数据库和浏览器持久化

**证据**

- [public_admin/server/database_pg.py](D:/PycharmProjects/ak-proxy/public_admin/server/database_pg.py) 的 `user_stats`、`authorized_accounts` 保存密码、AK userkey、登录 Cookie、payload。
- [public_admin/frontend/host/runtime/auth/session.js](D:/PycharmProjects/ak-proxy/public_admin/frontend/host/runtime/auth/session.js) 和 [public_admin/frontend/host/chat_widget.js](D:/PycharmProjects/ak-proxy/public_admin/frontend/host/chat_widget.js) 使用 `_ak_sl` 在 `localStorage` 保存账号和密码。
- 前端还保存 `AK_user_model`，其中包含 AK `Key`。

**设计**

- `CredentialVault`：统一封装 AK 凭据保存、读取、轮换、清理。调用方只能拿到短期解密结果或引用 ID。
- 服务端使用 envelope encryption：主密钥来自环境或 KMS，数据库只保存密文、版本、创建时间、最后使用时间。
- 浏览器不保存密码和 userkey；“记住我”只保存服务端 session refresh handle，且可吊销。
- `CredentialMigration`：一次性迁移明文字段到密文字段，迁移后清空历史明文。

**验收**

- 浏览器存储中不存在密码、AK userkey、登录 Cookie。
- 数据库 dump 中不存在可直接复用的 S0 明文。
- 密钥轮换和单账号吊销有测试。

### P0-ADMIN-001：Admin Token、TOTP Secret、二次验证租约保护不足

**证据**

- [public_admin/server/security/session/admin_session.py](D:/PycharmProjects/ak-proxy/public_admin/server/security/session/admin_session.py) 生成 token 后，数据库层保存 raw token。
- [public_admin/server/database_pg.py](D:/PycharmProjects/ak-proxy/public_admin/server/database_pg.py) 的 `admin_tokens.token`、`admin_totp_secrets.secret` 为明文存储。
- [public_admin/server/security/operation_auth/service.py](D:/PycharmProjects/ak-proxy/public_admin/server/security/operation_auth/service.py) 签发二次验证 lease 时固定为全局 scope。

**设计**

- `AdminSessionStore`：数据库只保存 token hash，内存只缓存必要元数据；校验时 hash 后查找。
- `TotpSecretVault`：TOTP secret 使用 envelope encryption；展示 secret 只允许初始化或 reset 后一次性返回。
- `OperationCapabilityService`：二次验证 lease 绑定 `admin_id`、`scope`、`resource`、`method`、`exp`、`nonce`，高风险操作逐项声明所需 scope。

**验收**

- DB 泄露不能直接复用 admin token。
- `delete_account` 的二次验证不能用于 `execute_sql`。
- TOTP secret 不可被普通“查看配置”接口反复取回。

### P0-WS-001：实时通道使用查询参数和客户端自报角色

**证据**

- [public_admin/server/proxy_server.py](D:/PycharmProjects/ak-proxy/public_admin/server/proxy_server.py) 的远程协助、语音、chat WebSocket 接收 `session_id`、`voice_session_id`、`role`、`username` 等查询参数。
- 部分连接在身份确认前已经 `accept()`。

**设计**

- `RealtimeSessionTicket`：会话创建方由服务端签发一次性短期 ticket，包含通道类型、角色、资源 ID、过期时间。
- 握手前解析和验证 ticket，失败直接拒绝，不进入 active manager。
- 所有 URL 查询参数只作为 ticket 载体，不再作为权限事实。

**验收**

- 篡改 role 不能升级权限。
- 重放过期 ticket 失败。
- 未认证连接不会出现在在线连接集合。

### P0-LOGIN-001：授权检查异常时按公开模式放行

**证据**

- [public_admin/server/proxy_server.py](D:/PycharmProjects/ak-proxy/public_admin/server/proxy_server.py) 登录流程中，白名单状态或授权状态异常时存在“按公开访问模式放行”的路径。

**设计**

- `AuthorizationPolicy`：将 `allow`、`deny`、`unknown` 显式建模，`unknown` 默认拒绝。
- 错误响应区分用户可见提示和审计事件；审计记录原因、请求 ID、账号、策略版本。

**验收**

- 数据库不可用、配置读取失败、白名单状态未知时登录失败。
- 相关失败可被监控和告警捕获。

## 3. P1 加固项

| 编号 | 风险 | 证据 | 加固方向 |
|---|---|---|---|
| P1-NET-001 | 服务默认监听所有网卡 | `PROXY_HOST=0.0.0.0`、`IM_ADDR=:18081` | 默认绑定 loopback，公网只经 Nginx/网关暴露。 |
| P1-CORS-001 | CORS 通配与 credentials 组合 | FastAPI 和 Nginx 中存在 wildcard CORS | 按部署域名生成 allowlist。 |
| P1-TLS-001 | 上游 TLS 校验关闭 | 多处 `verify=False`、Nginx `proxy_ssl_verify off` | 统一 CA 配置，临时例外必须有到期时间。 |
| P1-BOOT-001 | 维护脚本存在默认 license key | `maintain_ak_proxy.sh` 写入默认 key | 禁止默认密钥，首次启动必须显式配置。 |
| P1-NTFY-001 | 用户可配置 ntfy server URL | ntfy client 接受 http/https URL | 经过 SSRF 网关，禁止内网 IP、metadata 地址和危险重定向。 |
| P1-LOG-001 | trace/debug 可能记录敏感片段 | 登录、转发、脚本注入日志 | 统一 `AuditRedactor`，只留摘要。 |
| P1-DEPLOY-001 | systemd 与 env 路径不一致 | `EnvironmentFile=-/etc/ak-proxy.env` 与新脚本路径不同 | 收敛为单一 env 规范，缺失关键 env 时启动失败。 |
| P1-TEST-001 | 缺少 CI、安全扫描和 Go 测试 | 无 pytest/CI，Go 包无 `_test.go` | 建立分层验证门禁。 |

## 4. 目标架构模块

| 模块 | 责任 | 失败模式 |
|---|---|---|
| `EdgeBoundary` | 统一公网路由、内部路由、CORS、TLS、限流 | 配置缺失时拒绝暴露内部路由。 |
| `IdentityGateway` | 登录会话、用户身份、角色解析 | 无法解析身份时返回未认证。 |
| `CapabilityTokenService` | 二次验证、内部调用、实时通道 ticket | scope 不匹配或过期时拒绝。 |
| `CredentialVault` | S0 凭据加密、迁移、轮换、吊销 | 解密失败时停止相关账号操作。 |
| `RealtimeAuthGateway` | WebSocket 握手认证和连接绑定 | 未认证连接不进入连接池。 |
| `UrlFetchGateway` | ntfy/webhook/外部 URL 拉取 SSRF 防护 | URL 策略未知时拒绝。 |
| `AuditRedactor` | 日志、trace、错误响应去敏 | 未注册字段默认按敏感处理。 |
| `VerificationGate` | CI、安全扫描、契约测试、性能基线 | P0 检查失败禁止发布。 |

这些模块应保持松耦合：业务代码只依赖接口，不直接读写 token、secret、密码字段。任一模块降级时，系统可以失去部分功能，但不能扩大权限。

## 5. 整改顺序

### Phase 0：立即止血配置

1. Nginx 阻断公网 `/im/internal/`。
2. IM 默认监听 `127.0.0.1:18081`，公网只允许经边界网关访问。
3. 登录授权异常改为 fail closed。
4. `/api/status` 最小化为公开健康检查；详细诊断信息不保留通用状态接口。
5. 禁用默认 license key，缺失关键 secret 时启动失败。
6. 关闭敏感 trace 输出，禁止记录 cookie、password、userkey。

### Phase 1：身份和实时通道

1. 引入服务端 session 作为唯一身份来源。
2. IM、Notify、Chat、Remote Assist、Voice 改为 audience-scoped token/ticket。
3. 所有 WebSocket 握手前鉴权，角色由服务端 ticket 决定。

### Phase 2：凭据保险库

1. 新增密文字段和 vault 接口。
2. 迁移历史明文密码、userkey、cookie、payload。
3. 前端移除 `_ak_sl` 密码保存和 AK userkey 持久化。
4. 建立吊销、轮换和审计。

### Phase 3：Admin 与二次验证

1. Admin token 数据库落 hash。
2. TOTP secret 加密存储，一次性展示。
3. 二次验证 lease 绑定具体 scope 和资源。
4. 高危 SQL/账号/配置操作全部接入 operation capability。

### Phase 4：验证与发布门禁

1. 建立 Python、Go、前端基础 CI。
2. 增加安全单测、契约测试、动态边界测试。
3. 增加依赖漏洞扫描和 secret 扫描。
4. 建立性能基线和回归阈值。

## 6. 发布准入标准

| 等级 | 准入要求 |
|---|---|
| P0 | 必须全部修复并有自动化测试；不得以“配置规避”作为长期方案。 |
| P1 | 必须修复或记录风险接受人、期限、补偿控制。 |
| P2 | 可进入技术债列表，但必须有 owner 和复查日期。 |

任何发布候选版本必须满足：

1. 安全不变量测试全绿。
2. 无新增 S0 明文持久化。
3. 无新增客户端自报身份授权路径。
4. 公网路由清单不包含内部接口。
5. 依赖扫描和 secret 扫描无高危未处理项。

## 7. 回滚原则

- 安全修复回滚不能恢复明文凭据、客户端身份信任或 internal 公网暴露。
- 配置回滚必须保留 deny-by-default。
- 数据迁移必须支持只读校验和分批回滚，但不得把已清理明文字段重新写回。

## 8. 整改落地记录

| 日期 | 项目 | 状态 | 关键行为 |
|---|---|---|---|
| 2026-06-08 | P0-LOGIN-001 登录授权异常 fail closed | 已落地 | `/RPC/Login` 在白名单状态或授权信息读取异常时返回 503，不再按公开访问模式放行；明确开启公开访问模式时行为保持不变。 |
| 2026-06-08 | Phase 0 `/api/status` 信息最小化 | 已落地 | 公开 `/api/status` 仅返回最小探活信息；原详细代理诊断信息不再通过通用状态接口提供，后续如有运维展示需求应接入专用监控接口。 |
