# AK Proxy 安全与性能复扫报告

日期：2026-06-09
范围：`D:\PycharmProjects\ak-proxy` 源码只读扫描，覆盖后端管理接口、IM/通知、后端性能、前端运行态性能。
方法：主线程本地横切复核 + 4 个并行 agent 分区扫描。
约束：本次只生成文档，未修改业务代码，未提交，未连接生产数据库，未执行压测或 `EXPLAIN`。

## 1. 执行摘要

本次复扫没有发现明确 P0 级别问题，但发现多处 P1/P2 风险和高收益性能优化点。系统经过前几轮修复后，WebSocket 短票、UrlFetchGateway、OperationAuth、性能监控、静态缓存等基础能力已经存在；现在主要问题从“完全缺失防线”转为“防线覆盖率、失败模式、长尾边界和高负载行为”。

优先处理建议：

1. 安全优先：OperationAuth fail-open、IM 身份明文 Cookie 回退、IM 内部接口代码层鉴权、AK 浏览代理操作租约覆盖缺口。
2. 凭据治理：DB 二级 token 绑定会话，只读 SQL 收口，AK/子管理员凭据去明文化，TOTP 登录改为身份 + 双因子。
3. 通知与前端边界：通知打开 token 缩短有效期，Service Worker 限制同源跳转，通知/图片预览 URL allowlist。
4. 性能优先：IM 发送事务拆短、会话列表分页与聚合下沉、AK Web 代理大响应流式化、视频上传转后台任务。
5. 前端优先：IM 首屏最小化、管理页拆包、IM 局部渲染、消息缓存迁移 IndexedDB 或加全局配额。

## 2. 扫描分工与主要结论

| 分区 | 结论 |
| --- | --- |
| 后端管理接口安全 | 未发现 P0；P1 是 OperationAuth fail-open 与 AK 浏览代理租约覆盖缺口；P2 是 DB token、SQL、凭据、TOTP 登录模型。 |
| IM/通知安全 | 未发现 P0；P1 是签名身份密钥缺失时回退明文 Cookie、内部会议发布接口缺代码层鉴权。 |
| 后端性能 | 高收益点集中在 IM 写链路、会话列表、AK Web 大响应体、视频转码、点数统计补齐期。 |
| 前端与运行态性能 | 高收益点集中在 IM 首屏脚本链、管理页巨型 HTML、全量重渲染、localStorage 膨胀、重连风暴。 |

## 3. 安全发现

### S1. OperationAuth 导入或初始化失败时 fail-open

级别：P1
位置：

- `public_admin/server/proxy_server.py:546`
- `public_admin/server/proxy_server.py:3960`
- `public_admin/server/proxy_server.py:5367`

证据：`operation_auth` 导入异常被捕获后置为 `None`；后续只记录 warning，且只有模块对象非空才安装 `OperationAuthMiddleware`。

影响：一旦依赖、编码、迁移、导入路径或初始化失败，依赖 `X-Operation-Lease` 的敏感操作会退回普通管理员 token 鉴权。此时二次操作授权这一层防线整体失效。

建议：

- 生产环境 fail-closed：OperationAuth 不可用时敏感接口返回 503 或服务启动失败。
- 仅允许显式开发开关关闭 OperationAuth。
- 管理首页、健康检查和日志中暴露醒目告警。
- 增加启动自检，确保 scope resolver、repository、middleware 全部可用。

### S2. AK 内嵌浏览代理存在操作租约覆盖缺口

级别：P1，需结合上游副作用接口验证
位置：

- `public_admin/server/security/operation_auth/middleware.py:19`
- `public_admin/server/security/operation_auth/scope_resolver.py:109`
- `public_admin/server/proxy_server.py:14866`
- `public_admin/server/proxy_server.py:15702`
- `public_admin/server/proxy_server.py:15704`
- `public_admin/server/proxy_server.py:14140`

证据：OperationAuth middleware 在 resolver 无 scope 时放行。resolver 覆盖 `POST /admin/ak-rpc/`、`POST /admin/ak-site/`、`POST /admin/ak-web/`，但路由允许 `PUT/DELETE`，且 `/ak-web/{path}` 的 `POST/PUT/DELETE/OPTIONS` 未完全列入 scope。代理鉴权还依赖 browse-session cookie。

影响：已有 browse session 时，部分状态变更请求可能绕过操作租约。若出现同源 XSS、CORS/Origin 配置错误，或上游 GET/PUT/DELETE 有副作用，会扩大后台代理操作面。

建议：

- 对 AK 浏览代理前缀的所有非安全方法统一要求操作租约。
- 补齐 `/ak-web/`、必要时 `/cdn-cgi/` 的 scope。
- 不需要的 `PUT/DELETE/OPTIONS` 直接禁用。
- Cookie 鉴权的状态变更接口补 Origin/Referer/CSRF 校验。

### S3. IM 身份在签名密钥缺失时回退可伪造明文 Cookie

级别：P1，需验证生产环境密钥是否强制配置
状态：已处理。IM 服务默认要求签名身份密钥，缺失时启动失败；明文 `ak_username` / `ak_im_username` Cookie 仅在显式 `IM_ALLOW_UNSIGNED_IDENTITY=1` 开发开关下作为回退，不再成为生产默认身份事实。
位置：

- `im_server/internal/app/app.go:703`
- `im_server/internal/app/app.go:723`
- `im_server/internal/config/config.go:31`
- `public_admin/plugins/im/user/im_client.js:3246`

证据：IM `resolveUsername` 优先读签名身份；但当 `NotifyCenterIdentitySecret` 为空时，会回退到 `ak_username` / `ak_im_username` 明文 Cookie。前端 JS 会写入这些非 HttpOnly Cookie。

影响：若生产或测试环境未强制配置签名密钥，用户可以手动改 Cookie 冒充任意已授权账号，影响 IM REST、消息、附件、会议等身份边界。

建议：

- 生产环境启动时强制要求签名身份密钥，缺失直接 fail-closed。
- 删除明文 Cookie 的服务端鉴权回退，或仅在显式 dev flag 下启用。
- 明文 Cookie 只能作为 UI hint，不能成为服务端权限事实。

### S4. IM 内部会议发布接口缺少代码层内部鉴权

级别：P1，需验证部署暴露面
状态：已处理。所有 `/im/internal/*` 路由注册点已统一套用代码层 loopback guard，非本机来源直接 403；现有 handler 内的局部 loopback 检查保留为重复保险。后续如需抵抗同机 SSRF，可在该 guard 内平滑升级 HMAC/时间戳/nonce 校验。
位置：

- `im_server/internal/app/app.go:373`
- `im_server/internal/app/meeting_features.go:1198`
- `im_server/internal/app/conversation_features.go:1828`
- `public_admin/config/nginx.conf:135`

证据：`/im/internal/meetings/publish` 注册到 `handleInternalMeetingPublish`，处理时直接读取 `sender_username` 并发布。同类内部接口如 group profile/file config/emoji import 有 loopback 检查。Nginx 当前有 `/im/internal/` 返回 404，IM 默认监听 `127.0.0.1:18081`，但 handler 本身没有统一内部鉴权。

影响：若 IM 端口误暴露，或被某个内网 SSRF 打到，攻击者可构造 `sender_username` 以具备发布权限的身份创建会议并广播通知。

建议：

- 给所有 `/im/internal/*` 加统一内部鉴权中间件。
- 至少 loopback 校验，最好再加 HMAC/时间戳/nonce 内部签名。
- Nginx 拦截保留为外层防线，不代替代码层鉴权。

### S5. DB 二级 token 是全局 bearer，未绑定管理员会话/IP/UA

级别：P2
位置：

- `public_admin/server/security/session/db_auth_session.py:9`
- `public_admin/server/security/session/db_auth_session.py:19`
- `public_admin/server/proxy_server.py:4297`
- `public_admin/server/proxy_server.py:7315`
- `public_admin/server/proxy_server.py:7385`

证据：`DbAuthSessionService` 保存 `token -> expire`；校验只看 `X-DB-Token` 是否存在且未过期。

影响：泄露的 DB token 在 TTL 内可与任意具备 `database` 权限的管理员 token 组合使用，无法按签发者、IP、UA、角色撤销。

建议：

- DB token 绑定签发管理员 token hash、role/sub_name、IP/UA。
- 管理员 token 失效、踢出或改权时联动撤销 DB token。
- 考虑用 OperationAuth 的 `db_read_ops` / `db_write_ops` 替代独立 bearer。

### S6. 自定义只读 SQL 权限边界过宽

级别：P2
状态：已处理。`/admin/api/db/sql` 现在统一要求系统总管理员和 `db_write_ops` 操作授权；执行层增加单语句、危险函数/系统 schema 拦截、`statement_timeout` 与返回行数上限，避免 raw SQL 以“只读”名义读穿或拖垮数据库。固定表结构、分页查询和监控统计接口不走 raw SQL 限制。
位置：

- `public_admin/server/db/sql_policy.py:4`
- `public_admin/server/proxy_server.py:7546`
- `public_admin/server/database_pg.py:2478`
- `public_admin/server/database_pg.py:108`
- `public_admin/server/db_guard/guard.py:111`

证据：`select/show/describe/explain` 被视为 readonly；非 super admin 只要有 `database` 权限和 DB token 即可执行；readonly 直接 `conn.fetch(sql)`。大表 guard 主要靠首表、WHERE、LIMIT 启发式判断。输出脱敏按列名匹配，raw SQL 可通过别名绕过敏感字段名脱敏。

影响：可读取 DB role 可见表、系统 catalog，或通过昂贵 JOIN、函数、`pg_sleep` 类查询拖垮连接。敏感字段脱敏不能作为 raw SQL 的安全边界。

建议：

- raw SQL 默认仅 super admin。
- 普通管理员只允许查询 allowlist view。
- 使用只读 DB role、statement timeout、强制 LIMIT/行数上限。
- 禁止危险函数、跨 schema/system catalog、写入型 CTE。

### S7. AK 账号与子管理员凭据存在明文存储/客户端注入风险

级别：P2
位置：

- `public_admin/server/database_pg.py:1013`
- `public_admin/server/database_pg.py:1323`
- `public_admin/server/database_pg.py:2842`
- `public_admin/server/security/identity/admin_password.py:17`
- `public_admin/server/proxy_server.py:14899`
- `public_admin/server/proxy_server.py:15217`

证据：成功登录/同步会写入 `user_stats.password`；`sub_admins.password` 明文保存并明文比较；browse session 保存 AK 密码，注入脚本会填充密码并写入 `AK_local_login_info`。

影响：DB 泄露、raw SQL 脱敏绕过、后台 XSS、浏览器扩展或上游页面脚本都可能拿到可重放凭据。

建议：

- 子管理员密码改强哈希。
- AK 账号密码尽量不落库，改服务端短期 token/cookie。
- 必须留存时使用 KMS/环境密钥加密。
- 不把密码写入客户端 localStorage/sessionStorage。

### S8. 管理员登录允许 6 位 TOTP 单因子直接换 token

级别：P2，需确认是否为有意设计
位置：

- `public_admin/server/proxy_server.py:5864`
- `public_admin/server/security/operation_auth/service.py:112`

证据：`/admin/api/login` 收到 6 位数字时直接调用 `verify_google_login_code`；该函数遍历所有 TOTP secret，唯一匹配即返回对应管理员身份并签发 token。

影响：TOTP code 同时承担“身份选择 + 凭证”角色。获得当前验证码即可登录对应管理员，不需要用户名/密码，审计和限速维度也较弱。

建议：

- 要求先提交管理员身份，再校验该身份的 TOTP。
- 更稳妥方案是密码 + TOTP 双因子。
- 限速按 identity + IP 做，审计中记录明确 identity。

### S9. 通知打开后的 IM 身份切换 token 有效期偏长

级别：P2
位置：

- `public_admin/server/proxy_server.py:14311`
- `public_admin/server/proxy_server.py:14349`
- `public_admin/plugins/notify_center/server/formatter.py:75`
- `public_admin/frontend/host/runtime/ntfy/identity_switch_prelude.js:15`

证据：通知 URL 拼接 `im_switch_ts/nonce/sig`，服务端 `_IM_SWITCH_TOKEN_MAX_AGE_SECONDS = 86400`，前端本地 open ticket TTL 也是 24 小时。数据库消费能防重放，但首次使用窗口很长。

影响：ntfy、web-push、浏览器历史、日志或转发中泄露该 URL 时，攻击者可在 24 小时内首次消费 token，触发目标账号静默身份切换。

建议：

- 有效期降到 5-15 分钟。
- 页面打开后立即移除 query。
- 日志脱敏 URL 中的签名参数。
- 增加 `Referrer-Policy`。
- 可考虑绑定 UA/IP 或设备指纹。

### S10. Service Worker 通知点击未限制目标 URL 同源

级别：P2，需验证 payload 来源
位置：

- `public_admin/sw.js:73`
- `public_admin/sw.js:115`
- `public_admin/sw.js:119`
- `public_admin/sw.js:133`

证据：push payload 的 `payload.url` 写入 notification data。点击时 `new URL(target, self.location.origin).href` 后直接 `clients.navigate/openWindow`，没有检查 `targetUrl.origin === self.location.origin`，还把完整 URL 写入诊断状态。

影响：若通知 payload URL 可被子管理员、上游事件或污染数据控制，用户点击系统通知可能跳到外部钓鱼站、深链，或把携带签名参数的 URL 持久化到诊断状态。

建议：

- 通知点击只允许同源 path 或明确 allowlist。
- 拒绝外链、`javascript:`、`data:`、`vbscript:`。
- 诊断状态只存 path、hash 或脱敏 URL。

### S11. `/chat/im/image-preview` 可作为任意图片 URL 包装页

级别：P3
状态：已处理。预览页现在只允许 IM 图片资源路径和同源 `blob:` 临时预览，拒绝外链、`data:`、`javascript:`、协议相对 URL 与非图片资源；响应同时增加 CSP、`Referrer-Policy: no-referrer` 和 `X-Content-Type-Options: nosniff`。
位置：

- `public_admin/server/proxy_server.py:12373`
- `public_admin/server/proxy_server.py:12381`
- `public_admin/server/proxy_server.py:12400`
- `public_admin/plugins/im/user/modules/im_image_manage.js:218`

证据：`src` HTML escape 后直接放入 `<img src="...">`，没有 scheme/path allowlist。正常 IM 图片后端会归一化为 `/im/assets/...`，但该路由可被直接访问。

影响：不构成直接 XSS，但可用同源预览页加载外部跟踪图、data 图片或诱导式预览内容。

建议：

- 只允许 `/im/assets/image/`、`/im/assets/image-preview/` 等同源资源。
- 拒绝外链、`data:`、`javascript:`。
- 加 CSP：`img-src 'self' blob:`。

### S12. 单个会议标记已读未校验可见性

级别：P3
状态：已处理。单个会议标记已读现在先校验当前用户对会议是否可见，不可见时返回 404 且不写入 `im_meeting_reads`；批量已读继续沿用可见范围 SQL。
位置：

- `im_server/internal/app/meeting_features.go:1378`
- `im_server/internal/app/meeting_features.go:1398`
- `im_server/internal/app/meeting_features.go:883`
- `im_server/internal/app/meeting_features.go:1139`

证据：`handleMeetingRead` 对 `meeting_id` 直接调用 `dbMeetingMarkRead`；而 join 会先 `dbMeetingGetVisible`，mark all 也用可见范围 SELECT。

影响：授权用户可对不可见或语义外会议 ID 写入 read 记录，污染未读数和统计，但不泄露会议内容。

建议：

- 单个 read 前先调用 `dbMeetingGetVisible`。
- 或把 `dbMeetingMarkRead` 改成基于可见会议 SELECT 的插入。

### S13. `/admin/ws` 仍保留无 ticket 的旧式 token 认证路径

级别：P3
状态：已处理。`/admin/ws` 现在强制消费 `audience=admin` 的一次性 WS ticket，不再接受连接后发送 `{type:"auth", token}` 的旧式长期 token 认证；管理前端拿不到短票时不再回退旧路径。
位置：

- `public_admin/server/proxy_server.py:9604`
- `public_admin/server/proxy_server.py:9668`
- `public_admin/server/proxy_server.py:9691`

证据：`/chat/ws`、assist、voice 都强制消费一次性 ticket；但 `/admin/ws` 只有 query 带 ticket 时才消费，否则 accept 后等待 `{type:"auth", token}` 并校验长期 admin token。

影响：不是未授权漏洞，但削弱统一 WS 短票收敛效果。一旦 admin token 泄露，可直接复用建立 WS。

建议：

- 迁移期后强制 `/admin/ws` 必须带一次性 ticket。
- 旧 `{type:"auth"}` 路径加短期开关、审计日志和下线时间。

## 4. 性能发现

### P1. IM 发送链路事务过长，成员查询重复

收益：高
风险：中高
位置：

- `im_server/internal/app/app.go:2226`
- `im_server/internal/app/app.go:2240`
- `im_server/internal/app/app.go:2255`
- `im_server/internal/app/app.go:2284`
- `im_server/internal/app/app.go:2742`
- `im_server/internal/app/message_notify.go:177`

证据：`insertMessage` 开事务后用 `MAX(seq_no)+1` 分配序号，事务提交前做发送者身份补全和消息格式化；提交后查成员读进度。广播再次查成员，通知中心又查会话元信息和成员。

影响：大群或并发发送时事务持有时间变长，成员表重复扫描，`seq_no` 并发竞争导致唯一键冲突或重试压力。

建议：

- 用 `im_conversation.last_seq_no` 原子 `UPDATE ... RETURNING` 或 advisory lock 分配序号。
- 把身份补全、文件 payload hydration、通知元信息移出写事务。
- 加一次成员快照加载，复用于读进度、广播、通知。

### P2. IM 会话列表重复聚合且无分页

收益：高
风险：中高
位置：

- `im_server/internal/app/app.go:1740`
- `im_server/internal/app/app.go:1753`
- `im_server/internal/app/session_list_optimization.go:145`

证据：`/im/api/sessions` 一次返回所有会话。SQL 对每个会话重复计算成员数、未读数、mention 未读；群预览会把所有群的全部成员取回 Go 后再截取前 9 个。

影响：用户会话数、群成员数、消息数增长后，单次会话列表成为 DB 热点和大对象内存热点。

建议：

- 会话列表加分页/游标。
- 未读数用增量表或按会话批量 CTE 聚合。
- 群成员预览用 SQL 窗口函数 `row_number() <= 9` 在数据库侧截断。
- 成员数维护计数列。

### P3. AK Web 代理响应体全量入内存

收益：高
风险：中
位置：

- `public_admin/server/proxy_server.py:15843`
- `public_admin/server/proxy_server.py:15887`
- `public_admin/server/proxy_server.py:15916`
- `public_admin/server/proxy_server.py:16027`
- `public_admin/server/static_resource_cache/config.py:10`

证据：请求体用 `await request.body()` 全量读取，上游响应用 `resp.content` 全量读取；文本再 decode/encode；静态缓存允许最大 30MB body。

影响：图片、字体、WASM、视频等大静态资源会造成多份内存拷贝，并发时推高 RSS 和 GC/分配成本。

建议：

- HTML/CSS/JS 继续全量重写。
- 二进制或超阈值资源走 `StreamingResponse`。
- 缓存写入改为流式临时文件或小文件内存、大文件磁盘。
- 非需解析路径使用流式透传请求体。

### P4. 视频上传在 HTTP 请求内同步跑 ffmpeg

收益：高
风险：中
位置：

- `im_server/internal/app/video_messages.go:303`
- `im_server/internal/app/video_messages.go:351`
- `im_server/internal/app/video_messages.go:165`
- `im_server/internal/app/video_messages.go:217`

证据：上传接口保存临时文件后立即 `persistVideoAsset`，同步 `ffprobe/ffmpeg` 转封装、转码、截封面；转码超时可达 20 分钟。

影响：上传请求长时间占用 handler、CPU、磁盘 IO；多用户视频上传会拖慢 IM 服务整体响应。

建议：

- 改为任务队列：上传原文件后返回 pending 消息。
- 后台 worker 限并发转码并更新消息 payload。
- 前端展示 pending/failed 状态。

### P5. 点数统计未补齐时 fetch-all 后 Python 分类/分页

收益：中高
风险：中
位置：

- `public_admin/server/performance/point_stats/summary_service.py:44`
- `public_admin/server/performance/point_stats/summary_service.py:49`
- `public_admin/server/performance/point_stats/detail_service.py:29`
- `public_admin/server/performance/point_stats/detail_service.py:51`
- `public_admin/server/performance/point_stats/backfill.py:11`

证据：只要存在未解析分类记录，就拉取全部匹配明细再在 Python 中分类/分页。补齐任务循环间隔仅 0.02 秒。

影响：老数据未补齐期间，单个明细页可能读取大量历史记录；补齐任务与在线查询抢 DB。

建议：

- 优先完成结构化补齐。
- 补齐未完成时也做数据库侧分页。
- 补齐 loop 加自适应 sleep、批量上限、低峰运行。

### P6. 消息附件鉴权依赖 JSONB 表达式扫描

收益：中高
风险：中
位置：

- `im_server/internal/app/app.go:2589`
- `im_server/internal/app/app.go:2595`
- `im_server/internal/app/app.go:2604`
- `im_server/internal/app/attachment_messages.go:1267`

证据：访问图片、文件、语音、视频资产时，从 `im_message.content_payload::jsonb ->> storage_name` 等字段反查消息权限。当前 schema 主要是消息按会话序号索引和 mention 索引。

影响：附件访问频繁时难以稳定走普通索引，消息表越大越慢。

建议：

- 建 `im_message_asset(message_id, conversation_id, storage_name, asset_role)` 映射表。
- 或至少增加表达式索引。
- 发送消息时同步写资产映射，历史消息做回填。

### P7. 内部 HTTP client 生命周期不统一

收益：中
风险：低到中
位置：

- `public_admin/server/proxy_server.py:1081`
- `public_admin/server/proxy_server.py:1163`
- `public_admin/server/proxy_server.py:1247`
- `public_admin/server/proxy_server.py:1787`

证据：IM 内部同步、JSON helper、multipart helper、监控上报在调用点 `async with httpx.AsyncClient(...)` 新建 client。主 AK Web 和 outbound dispatcher 已有池化，风格不一致。

影响：批量白名单同步、告警上报、管理端 IM 操作时重复建连，增加握手和端口抖动。

建议：

- 建应用生命周期级 `InternalHttpClientPool`。
- 按目标服务配置 timeout/verify/limits。
- shutdown 时统一 `aclose()`。

### P8. 静态缓存清理/列表是全目录扫描

收益：中
风险：低
位置：

- `public_admin/server/static_resource_cache/store.py:95`
- `public_admin/server/static_resource_cache/store.py:113`
- `public_admin/server/static_resource_cache/store.py:137`
- `public_admin/server/proxy_server.py:5676`

证据：`cleanup_expired` 和 `list_entries` 都 `root.glob('*/*.meta.json')` 扫全量并读取 meta；清理任务定时运行。

影响：缓存文件长期增长后出现周期性磁盘 IO 峰值，并占用 `run_blocking` 的有限并发。

建议：

- 清理按 shard 分批、每轮限制数量。
- 维护轻量索引/manifest。
- 后台列表只读最近 N 个，或使用目录 mtime 快速筛选。

### P9. 登录审计队列满时回退同步写

收益：中
风险：中
位置：

- `public_admin/server/performance/login_events/audit_queue.py:67`
- `public_admin/server/performance/login_events/audit_queue.py:73`
- `public_admin/server/proxy_server.py:2383`

证据：队列未启动或满时返回 `False` 并 fallback sync write；登录主链路 `await db.record_login(...)`。

影响：DB 抖动时，登录请求从异步削峰退化为同步等待，尾延迟升高。

建议：

- 区分关键安全事件和普通审计。
- 普通事件落本地 WAL/批量文件或丢弃低价值字段，后台补写。
- 队列满时采样告警，避免每次 warning。

### P10. 管理端统计缓存 TTL 短，刷新仍跑重聚合

收益：中
风险：中
位置：

- `public_admin/server/performance/cache/admin_stats_cache.py:11`
- `public_admin/server/performance/admin_summary/repository.py:49`
- `public_admin/server/performance/admin_summary/repository.py:86`

证据：stats TTL 15s、dashboard TTL 30s；刷新时仍对 `user_stats`、`ip_stats`、`user_assets`、`ban_list` 做全局 count/sum。

影响：缓存挡住并发读，但挡不住周期性重查询。数据量大后管理页稳定制造 DB 背景负载。

建议：

- 增加汇总表或物化视图。
- 登录、资产、封禁变更时增量更新。
- 管理页 TTL 改为事件失效 + 慢刷新。

### P11. IM 用户态首屏脚本链过重

收益：高
风险：中
位置：

- `public_admin/plugins/im/user/im_entry.js:26`
- `public_admin/plugins/im/user/im_client.js:2669`

证据：`im_entry.js` 串行加载 8 个核心脚本，`script.async = false`；`im_client.js` 登录后 `ensureChatFeatureModules()` 一次性拉取近 20 个可选模块。`im_client.js` 约 320KB，`im_call_manage.js` 约 217KB，`im_app_shell.js` 约 156KB。

影响：弱网和移动端首屏可交互时间变长。用户只看会话列表时也提前支付通话、视频、文件、位置等模块成本。

建议：

- 拆成最小 IM core：身份、会话列表、消息基础渲染先加载。
- 通话、视频、文件、位置、表情、群管理按入口触发加载。
- 非关键模块用 `requestIdleCallback` 或空闲预取。
- 模块缺失时降级为“功能不可用”，不影响主聊天。

### P12. 管理页巨型 HTML 与全局 Chart 首屏成本

收益：高
风险：中
位置：

- `public_admin/frontend/pages/admin.html:3370`
- `public_admin/frontend/pages/admin.html:4887`

证据：`admin.html` 约 626KB，主内联脚本从约 4887 行持续到 11542 行。`chart.umd.min.js` 约 206KB，在 head 中全局 `defer` 加载。

影响：HTML 解析、JS 编译和 deferred 脚本执行抢占首屏主线程；非 dashboard 场景也下载和执行图表库。

建议：

- 拆 `admin-core`、面板 controller、工具模块。
- Chart.js 仅 dashboard 首次打开时加载。
- 保留核心登录、权限、导航和 toast，其它面板走 lazy loader。

### P13. IM 消息与会话列表全量重渲染

收益：高
风险：中
位置：

- `public_admin/plugins/im/user/im_client.js:5686`
- `public_admin/plugins/im/user/modules/im_message_manage.js:620`
- `public_admin/plugins/im/user/modules/im_session_manage.js:159`

证据：`render()` 每次调用都会渲染会话、资料、表情、消息、弹窗等多个区域。消息列表清空后逐条 append，并为每条绑定事件；会话列表同样清空再重建。

影响：WebSocket 新消息、已读状态、上传进度、模块加载完成都可能触发整屏重建；移动端更容易卡顿。

建议：

- 引入局部 dirty flag、keyed diff、`DocumentFragment` 批量插入、事件委托。
- 消息列表优先做 append/update/revoke 单条更新。
- 长列表再做虚拟滚动。

### P14. localStorage 消息缓存缺少全局配额与清理

收益：高
风险：中高
位置：

- `public_admin/plugins/im/user/modules/message_store/im_message_store.js:4`
- `public_admin/plugins/im/user/modules/message_store/im_message_store.js:81`
- `public_admin/plugins/im/user/modules/message_sync/im_message_sync.js:153`

证据：每会话最多 200 条，但 key 按 `ak.im.messages.v2:{username}:{conversationId}` 分散写入；未见全局会话数量、TTL、LRU 或 quota 清理。最近 12 个会话会预取并写入。

影响：长期使用或群聊多的账号会让 localStorage 膨胀。同步读写和 JSON parse/stringify 阻塞主线程，quota 满时可能静默丢缓存。

建议：

- 迁移到 IndexedDB。
- 增加全局上限、TTL、按更新时间 LRU 淘汰、写入队列和失败 telemetry。
- localStorage 只保留轻量索引或最近会话摘要。

### P15. WebSocket 固定重连可能放大故障流量

收益：中高
风险：低到中
位置：

- `public_admin/frontend/pages/admin.html:5835`
- `public_admin/frontend/pages/admin.html:5876`
- `public_admin/frontend/shared/polling/polling_registry.js:139`

证据：`ws.onclose` 固定 `setTimeout(initWebSocket, 3000)`，未见指数退避、抖动、单例 reconnect timer 或 logout/hidden 停止条件。Registry 在 WS 不新鲜时会启用 fallback。

影响：服务端故障、网络断续、多标签页场景会形成同步重连，同时 fallback 拉接口，放大后端压力。

建议：

- 增加带 jitter 的指数退避、单例重连计时器、最大重连间隔。
- 页面隐藏、退出登录时取消。
- 多标签使用 BroadcastChannel 选主连接。

### P16. 懒加载失败重试会强刷缓存

收益：中
风险：低到中
位置：

- `public_admin/frontend/pages/admin.html:11574`
- `public_admin/frontend/pages/admin.html:12395`
- `public_admin/plugins/im/user/im_client.js:2615`

证据：多个面板 loader 失败后删除脚本并以 `?t=Date.now()` 重试，且设置 `async=false/defer=false`；IM lazy module 失败后删除 promise，下次动作可再次触发。

影响：网络波动或资源 404 时，用户反复切换面板/功能会重复请求 cache-bust URL。顺序加载资源时单个失败拖慢整个面板初始化。

建议：

- 加失败冷却窗口、错误状态缓存和手动重试按钮。
- 区分 required/optional。
- 动态脚本改 `async=true`，依赖由 loader promise 控制。

## 5. 横切治理建议

### 5.1 RoutePolicy 清单化

当前很多安全机制已经存在，但覆盖率主要靠人工维护。建议建立一份机器可读 route policy：

| 字段 | 说明 |
| --- | --- |
| path/method | 路由路径和方法 |
| exposure | public/admin/internal/loopback/static |
| auth | none/admin-token/user-session/ws-ticket/hmac-internal/license |
| operation_scope | 高危操作对应的二次授权 scope |
| subject_source | server session/token claim/HMAC subject，禁止 client hint 做权限事实 |
| csrf/origin | Cookie 鉴权变更接口是否需要 |
| rate_limit | 认证前后限速策略 |
| audit | 是否记录 actor、subject、scope、result |

目标：新增高危路由如果没有 policy，CI 或启动自检直接失败。

### 5.2 SubjectResolver 统一身份事实源

需要把“显示账号”和“权限账号”分开：

- 浏览器 Cookie、query、localStorage 只作为 UI hint。
- 写操作和资源读取必须来自签名身份、服务端 session、短票 claim 或内部 HMAC。
- 签名身份密钥缺失时生产环境 fail-closed。

### 5.3 InternalEndpointAuth 统一内部接口

所有 `/im/internal/*`、通知内部回调、Python 到 Go IM 的内部操作都应消费统一内部签名：

- HMAC(secret, timestamp, nonce, method, path, body_hash)
- timestamp 短窗口
- nonce 消费表或 Redis
- audience / purpose 绑定
- 失败只返回最小错误

### 5.4 UrlFetchGateway 覆盖率复扫

`UrlFetchGateway` 已经具备协议限制、主机解析、内网/metadata 阻断、跳转限制、超时和响应体大小限制。下一步不是再造网关，而是做覆盖率：

- 所有用户/配置可控 URL 必须通过网关。
- 所有 `httpx.AsyncClient`、`urllib`、外部 provider SDK 的出网点分类登记。
- 对订阅、PushDeer、ntfy、license/check-update、健康探测等按用途设置不同 policy。

### 5.5 运行时预算化

性能问题的共同根因是缺少预算：

- DB acquire timeout / statement timeout / pool max
- HTTP client per-host limits
- ffmpeg worker concurrency
- frontend polling budget
- localStorage / IndexedDB quota
- static cache cleanup budget

建议每个预算都有监控指标和管理员面板可视化，但默认不开昂贵诊断。

## 6. 优先路线图

### 0-3 天：安全短板热修

1. OperationAuth 不可用时 fail-closed。
2. IM 签名身份密钥生产强制配置，禁用明文 Cookie 鉴权回退。
3. `/im/internal/*` 增加统一代码层鉴权，先覆盖会议发布接口。
4. AK 浏览代理所有非安全方法纳入操作租约或禁用。
5. 通知打开 token 有效期降到 5-15 分钟，并打开后清 query。
6. Service Worker notification click 限制同源 path。

### 1-2 周：凭据与后台权限收口

1. DB 二级 token 绑定管理员会话/IP/UA，并联动撤销。
2. raw SQL 默认仅 super admin；普通管理员改 allowlist view。
3. 子管理员密码改强哈希。
4. AK password/userkey/cookies 逐步 vault 化或缩短生命周期。
5. TOTP 登录改为 identity + TOTP，最好升级为密码 + TOTP。
6. `/admin/ws` 下线旧式 token auth，强制一次性 ticket。

### 2-4 周：性能高收益改造

1. IM message sequencer：用会话级原子序号替代 `MAX(seq_no)+1`。
2. IM 发送事务拆短，成员快照复用。
3. 会话列表分页/游标，群成员预览数据库侧截断。
4. AK Web 代理大响应流式化。
5. 视频上传转任务队列。
6. 内部 HTTP client 池化。

### 1-2 月：前端和缓存架构改造

1. IM 首屏拆 core，通话/视频/文件/位置等按需加载。
2. 管理页拆 `admin-core` 和面板模块，Chart.js 按需加载。
3. IM 消息、会话列表做局部渲染。
4. 消息缓存迁移 IndexedDB 或加全局配额/LRU。
5. 管理端 WS 重连加指数退避、jitter、多标签选主。
6. 静态缓存清理改 shard 分批和 manifest。

## 7. 验证清单

安全验证：

- OperationAuth 模块人为加载失败时，高危接口必须 503 或启动失败。
- 缺少签名身份密钥时，生产 IM 服务不能启动或不能接受用户写操作。
- 修改 `ak_username` / `ak_im_username` 明文 Cookie 不能改变 IM 服务端身份。
- `/im/internal/meetings/publish` 无内部签名不能调用成功。
- 通知打开链接超过 15 分钟后失效；首次消费后再次打开失效。
- Service Worker 点击外链 payload 不跳转。
- `/chat/im/image-preview?src=https://example.com/a.png` 被拒绝。
- 不可见会议 ID 标记已读失败。

性能验证：

- 并发发送同一会话消息时 seq_no 无冲突，事务耗时下降。
- 大群会话列表 p95 下降，返回体受分页限制。
- 大静态资源代理时 RSS 不随资源大小线性放大。
- 视频上传接口快速返回 pending，ffmpeg 并发受控。
- 点数补齐期间详情查询不 fetch-all。
- 管理端 WS 断线后重连间隔有 jitter，不产生同步风暴。
- localStorage/IndexedDB 缓存达到上限后按 LRU 淘汰。

## 8. 文档结论

当前系统已经有较多安全和性能基础设施，但下一阶段应该从“补功能”转向“补覆盖率和失败模式”。最值得优先投入的是：

1. 安全 fail-closed：OperationAuth、签名身份、内部接口。
2. 身份事实源统一：服务端签名/短票/HMAC，而不是浏览器可写字段。
3. 高负载削峰：IM 写链路、视频转码、AK Web 大响应、统计聚合。
4. 前端主线程减负：按需加载、局部渲染、缓存配额、重连退避。

这些改造都建议按独立模块推进，做到模块缺失时只损失局部功能，不拖垮主系统。
