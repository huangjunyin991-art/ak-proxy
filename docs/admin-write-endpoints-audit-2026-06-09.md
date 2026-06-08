# 管理端写接口权限边界审计（2026-06-09）

## 目标

复核管理端和插件的写接口是否只依赖后端权限判断，而不是前端隐藏按钮。重点关注：

- `POST / PUT / PATCH / DELETE` 写接口。
- `admin/api`、调度器、数据库、通知、远程协助、监控等管理路径。
- 通过工厂函数注入权限校验的插件路由。
- 业务公开入口与管理入口的边界是否混淆。

## 扫描范围

本次扫描覆盖：

- `public_admin/server/proxy_server.py`
- `public_admin/server/**/routes.py`
- `public_admin/server/**/router.py`
- `public_admin/plugins/**/server/*.py`

未纳入本次修复的范围：

- 上游 K937 的业务 RPC 权限模型。
- 客户端公开授权接口，例如 license 激活、license verify、AK 上游页面代理的用户态登录请求。
- WebSocket 握手消费逻辑，本轮只检查发票据入口是否有身份校验。

## 当前权限模型

| 类型 | 典型接口 | 结论 |
| --- | --- | --- |
| 超级管理员 | 调度器变更、数据库写入、监控策略、静态缓存策略、子管理员管理 | 后端使用 `super_admin_only=True` 或等价角色判断。 |
| 权限位管理员 | 封禁、在线管理、license 管理、点数统计同步 | 后端使用 `_require_admin_token(request, permission)` 或插件内 `require_*_admin`。 |
| 账号作用域 | 白名单账号、AK 登录代理、ntfy 绑定、用户 real_name | 后端使用 `_require_admin_account_scope` 或 `require_admin_user_scope`。 |
| 内部签名 | IM 通知中心内部事件 | 使用 `verify_signature` 校验服务间调用。 |
| 用户态会话 | `/ak-web/**`、`/admin/ak-web/**`、`/admin/ak-site/**` | 不按管理员 token 判定，而是通过 browse session / 上游登录态守门。 |
| 业务公开入口 | `/admin/api/login`、license 客户端激活/校验 | 不属于已登录管理员写接口，走独立业务认证流程。 |

## 本次发现

没有发现“裸露的高危管理写接口”。大多数高危写操作已经在后端做了超级管理员或权限位校验。

发现一个边界不一致问题：

- `POST /admin/api/remote_assist/close`
- `POST /admin/api/remote_voice/start`
- `POST /admin/api/remote_voice/close`

这些接口原本会校验管理员登录态，并检查会话归属关系，但没有显式复用 `online` 权限位。也就是说，若某个子管理员的在线管理权限被撤销，仍可能在已有会话上下文里调用部分远程协助/实时语音写操作。

## 已修复

已在上述 3 个接口中补充：

```python
_, permission_error = await _require_admin_token(request, 'online')
if permission_error is not None:
    return permission_error
```

修复后的行为：

- 超级管理员不受影响。
- 拥有 `online` 权限的子管理员不受影响。
- 没有 `online` 权限的子管理员不能关闭远程协助会话、发起或关闭远程语音。
- 原有的“只能操作自己发起/拥有的会话”约束仍然保留。

## 已人工排除的误报

| 接口/模块 | 原因 |
| --- | --- |
| `meeting` 管理接口 | 统一走 `_resolve_meeting_admin_context()`，内部调用 `_require_admin_token()`，并对账号归属做作用域收敛。 |
| `license_center` 插件管理接口 | 路由工厂内统一使用 `require_license_admin()`，并校验 `license` 权限位。 |
| `monitoring` 插件接口 | 路由工厂内统一使用 `require_super_admin()`。 |
| `ws-ticket` 管理发票据接口 | 通过 `_resolve_ws_ticket_admin_identity()` 校验管理员 token，再由 `_validate_ws_ticket_issue()` 校验 audience 与资源作用域。 |
| `/admin/ak-web/**`、`/admin/ak-site/**` | 不是管理员 API 写接口，是 AK 上游网页代理；通过 browse session 和上游登录态守门。 |
| `/admin/api/login` | 登录入口本身，不能要求已有管理员 token。 |

## 后续建议

1. 把主文件里的远程协助/实时语音权限判断抽成小 helper，例如 `require_online_admin_identity()`，减少重复校验代码。
2. 建一个轻量脚本或测试，持续扫描新增 `POST/PUT/PATCH/DELETE` 路由，要求写接口必须命中以下任一守门方式：
   - super admin
   - permission scope
   - account scope
   - internal signature
   - documented public business auth
3. 对 `admin_session` 级写接口继续逐个复核业务语义，确认是否应该提升到具体权限位。
4. 长期可以把 `proxy_server.py` 中的大量管理接口拆到独立路由模块，避免权限边界分散在超大文件里。
