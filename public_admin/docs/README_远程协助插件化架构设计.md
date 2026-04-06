# 远程协助插件化架构设计文档

> 最后更新：2026-04-06
> 
> 本文档用于指导后续“远程协助 / 只读镜像 / 轻量远控”能力的设计与开发。目标不是替代传统远程桌面，而是在现有透明代理体系上构建一套**低带宽、可审计、最小侵入、可插件化迁移**的业务级协助能力。

---

## 目录

1. [设计背景与目标](#一设计背景与目标)
2. [核心设计原则](#二核心设计原则)
3. [当前工程的现实基础](#三当前工程的现实基础)
4. [总体架构](#四总体架构)
5. [推荐目录结构](#五推荐目录结构)
6. [核心数据模型](#六核心数据模型)
7. [关键流程设计](#七关键流程设计)
8. [最小侵入接入点](#八最小侵入接入点)
9. [插件化与站点适配器设计](#九插件化与站点适配器设计)
10. [稳定性与故障隔离](#十稳定性与故障隔离)
11. [可维护性设计](#十一可维护性设计)
12. [可拓展性设计](#十二可拓展性设计)
13. [安全、权限与审计](#十三安全权限与审计)
14. [分阶段落地规划](#十四分阶段落地规划)
15. [明确不做与克制项](#十五明确不做与克制项)
16. [验收标准](#十六验收标准)
17. [模块职责矩阵](#十七模块职责矩阵)
18. [宿主接入点清单](#十八宿主接入点清单)
19. [协助专用 WS 协议草案](#十九协助专用-ws-协议草案)

---

## 一、设计背景与目标

### 1.1 背景

当前项目已经具备以下现实基础：

1. 透明代理转发能力已经存在，可承接 AK 页面与 RPC 请求
2. 管理员后台已经存在，可作为协助发起与观察端
3. WebSocket 在线与状态同步基础已经存在，可承接实时事件流
4. AK 网页代理链路已经支持页面侧注入逻辑，这为协助桥接脚本提供了落点

因此，“远程协助”不应被理解为传统像素流远程桌面，而应被设计成：

- 基于代理页面的**只读镜像**
- 基于事件的**点击描红与路由同步**
- 基于响应观察的**会话级内容复用**
- 基于权限的**管理员只读协助**

### 1.2 目标

本能力的核心目标如下：

- **低带宽**
  - 尽量传递结构化页面数据、路由与交互事件，而不是传输画面帧

- **最小侵入**
  - 功能必须旁路化，不能破坏现有代理、登录、后台、AK 浏览等主流程

- **可维护**
  - 模块边界清晰，功能职责单一，便于替换、扩展和回滚

- **可稳定运行**
  - 协助功能异常时只能表现为协助不可用，不能影响主站点与主代理

- **可插件化迁移**
  - 第一版服务于 AK 代理页面，但架构上应能迁移到其他“被代理网站”场景

- **只读优先**
  - 第一阶段以“管理员观察 + 同步描红 + 路由同步”为主，不默认提供控制能力

### 1.3 非目标

第一版明确**不是**以下目标：

- 通用远程桌面替代品
- 任意网站无适配直接接入
- 操作系统级远控
- 100% 像素级还原
- 默认开启的管理员反向控制
- 一上来就做 DOM 全量实时双向同步

---

## 二、核心设计原则

### 2.1 最小侵入原则

远程协助必须是**旁路能力**，不是主链路能力。

工程约束：

- 不修改现有主流程的业务语义
- 不改变既有登录/会话/鉴权结果
- 不在功能关闭时改变原有响应内容与行为
- 不把协助逻辑混进主转发决策

### 2.2 故障不扩散原则

远程协助链路的任何失败都必须被限制在自身范围内。

要求：

- 协助缓存写入失败：忽略
- 协助广播失败：忽略并记录日志
- 协助桥接脚本注入失败：当前协助失效，不影响页面基本访问
- 协助专用 WebSocket 异常：只影响协助会话，不影响现有在线/聊天/后台主能力

### 2.3 按会话启用原则

功能默认关闭，只对明确进入协助态的用户/管理员生效。

要求：

- 没有 `assist_session` 时，系统应表现得像该功能不存在
- 注入、缓存、广播、事件同步都必须是条件启用
- 不允许全站默认注入协助脚本

### 2.4 插件化原则

远程协助能力必须拆分为：

- 与业务无关的**核心引擎**
- 针对具体网站的**适配器**

这样才能做到：

- AK 站点先落地
- 其他代理网站后续只换适配器而不是重写整套功能

### 2.5 只读优先原则

第一版优先做：

- 路由同步
- 点击描红同步
- 页面观察镜像
- 管理员只读视图

明确后置：

- 反向控制
- 输入接管
- 自动操作回放
- 会修改用户状态的远控能力

### 2.6 可审计原则

协助能力必须天然具备审计落点，至少记录：

- 谁发起协助
- 谁被协助
- 协助持续时间
- 进入/退出时间
- 关键页面切换
- 关键点击高亮事件
- 是否发生控制类动作（如果后续扩展）

---

## 三、当前工程的现实基础

### 3.1 已存在的关键能力

根据当前工程现状，以下能力已具备：

- **透明代理链路**
  - `public_admin/proxy_server.py` 中已有 `/RPC/*` 与 AK 页面代理转发能力

- **AK 网页代理入口**
  - `/admin/ak-web/{path:path}`
  - `/admin/ak-site/{path:path}`

- **页面注入能力**
  - 现有 AK 网页代理链路已经具备注入拦截逻辑的现实基础

- **WebSocket 管理基础**
  - 当前已有在线用户与后台实时交互相关的 WebSocket 管理器

- **管理员后台承载能力**
  - `public_admin/admin.html` 可作为协助发起端与观察端 UI 容器

### 3.2 这意味着什么

这意味着远程协助不需要从零开始做：

- 无需先补齐代理基础
- 无需先补齐后台入口
- 无需先从零做实时通道

真正要补的是：

- 会话级协助抽象
- 站点级适配器
- 事件同步协议
- 只读镜像视图
- 协助缓存与观察侧逻辑

### 3.3 已确认的源码锚点

以下锚点已经通过当前源码审查确认，后续设计与实现必须围绕这些现实入口展开，而不是另起一套虚构链路。

#### A. 管理员端 AK 浏览入口已存在

在 `public_admin/admin.html` 中，当前管理员侧已经有一套现成的 AK 浏览面板：

- `openAkBrowser(username)`
- `refreshAkBrowser()`
- `closeAkBrowser()`
- `iframe#akBrowserFrame`

其当前真实链路是：

```text
管理员点击“打开后台”
    -> POST /admin/api/browse_login
    -> iframe 加载 /admin/ak-web/pages/account/login.html
```

这意味着：

- `akBrowserPanel` 仍然是“打开后台”的真实入口，但它不应再被等同为“远程协助”
- 真正的远程协助应围绕**在线用户当前页面**展开，而不是管理员重新打开一套后台
- 当前阶段已改为：管理员通过独立只读协助面板承载用户侧 HTML 快照，而不是复用 `POST /admin/api/browse_login` + `iframe -> /admin/ak-web/pages/account/login.html`

#### B. 浏览态会话机制已存在

在 `public_admin/proxy_server.py` 中，已经有现成的浏览态与登录态承载结构：

- `_browse_sessions`
- `_ak_auth_cache`
- `_BROWSE_SESSION_COOKIE = "ak_admin_bs"`
- `_resolve_browse_session(...)`
- `_persist_browse_session_auth(...)`
- `_apply_cached_auth_to_browse_session(...)`

这意味着：

- 远程协助设计不能假设自己从零管理页面会话
- 第一阶段应尽量围绕现有 `bs_id / browse session` 体系做附加能力
- 协助会话与浏览态会话应是“关联关系”，不是“替代关系”

#### C. AK 页面代理与 HTML 注入链路已存在

当前真实入口：

- `/admin/ak-web/{path:path}`
- `ak_web_proxy(...)`

且 `ak_web_proxy(...)` 当前已经在做：

- 上游请求转发
- cookie 同步
- HTML/CSS/JS 路径改写
- 基于 `_build_injector(...)` / `_build_native_injector(...)` 的 HTML 注入

这意味着：

- 远程协助桥接脚本的接入点应优先复用现有 HTML 注入位置
- 第一阶段不建议新建另一条独立的页面代理主链路
- 当前已确认由管理员前端直接使用的是 `/admin/ak-web/*`
- `/admin/ak-site/*` 与 `/ak-web/*` 当前在源码中存在，但未见到管理员前端直接引用，第一阶段不应把它们当作主接入基线

#### D. 实时通道基础已存在

当前已确认的实时通道与管理对象：

- `ConnectionManager`
- `OnlineUserManager`
- `/admin/ws`
- `/chat/ws`

这意味着：

- 远程协助不必从零设计“是否使用 WebSocket”
- 当前已确认管理员后台真实在用的是 `/admin/ws`
- `chat_widget.js` 使用的是 `/chat/ws`，但这属于聊天链路，不应作为远程协助的接入基线
- 远程协助应优先考虑单独增加协助专用 WS 端点，而不是直接把协议塞进现有 `/admin/ws`

### 3.4 仍属架构假设的部分

以下内容目前是**经过约束优化后的推荐架构**，但尚不是仓库中已经存在的现实实现：

- `snapshot_cache.py` 快照缓存模块
- HTML 快照增量 patch / 压缩同步
- 事件审计持久化与回放能力

### 3.5 当前代码已落地范围（第一阶段截至目前）

当前仓库中，已经按最小侵入原则落下的部分包括：

- `public_admin/remote_assist/` 独立模块目录与门面层
- 协助会话 / 事件基础：`flags.py`、`types.py`、`session_manager.py`、`event_bus.py`、`facade.py`
- AK Web 适配器：`adapters/ak_web.py`
- 宿主后端接线：
  - `POST /admin/api/remote_assist/start`
  - `POST /admin/api/remote_assist/close`
  - `WS /admin/assist/ws`
- 用户侧绑定链路：
  - `chat_widget.js` 处理 `remote_assist_bind` / `remote_assist_unbind`
  - 用户在线链路 `WS /chat/ws`
  - `OnlineUserManager.send_payload_to_user(...)` 用于向目标用户下发协助绑定/解绑消息
  - 用户侧通过 `snapshot_replace` / `route_changed` / `click_highlight` 上报 HTML 快照与定位事件
- 管理员前端入口：`admin.html` 中在现有使用情况表增加“远程协助”按钮，并使用独立 `remoteAssistPanel` 渲染用户侧 HTML 快照

当前实现刻意保持的边界：

- 远程协助不再依赖 `browse_login` 打开管理员后台，也不再把“打开后台”误当成“协助用户页面”
- 用户侧协助绑定只复用当前已在用的 `chat_widget.js -> /chat/ws` 在线链路，不额外引入新的用户代理入口
- 第一阶段只做**全量 HTML 快照 + 路由同步 + 精准描红**，暂不做快照增量 patch、审计持久化和更重的可视化能力

这些内容的性质是：

- 它们不是当前源码中的既有能力
- 但它们是为了满足“最小侵入、可维护、可插件化”而设计出的目标结构

因此，本文件在当前阶段应被理解为：

> **已贴合现有主要链路的实现前设计文档，而非已经与全部源码细节一一对齐的施工图。**

---

## 四、总体架构

### 4.1 总体分层

建议将系统拆成四层：

1. **宿主层（Host）**
   - 现有代理服务、管理员后台、AK 浏览代理页

2. **协助核心层（Core）**
   - 远程协助会话管理、事件总线、缓存、策略控制

3. **站点适配层（Adapter）**
   - 面向 AK 页面或其他被代理网站的特定适配规则

4. **前端桥接层（Bridge）**
   - 用户端桥接脚本、管理员只读镜像运行时、高亮渲染逻辑

### 4.2 架构示意

```text
管理员后台 UI
    │
    │ 发起协助 / 查看镜像 / 只读观察
    ▼
Remote Assist Core
    ├── AssistSessionManager
    ├── AssistEventBus
    ├── AssistSnapshotCache
    ├── AssistPolicyEngine
    ├── AssistAuditLogger
    └── SiteAdapterRegistry
                │
                ├── AkWebAdapter
                ├── GenericHttpAdapter
                └── FutureSiteAdapter

用户代理页面 ── Bridge(User) ── WS/Event ── Bridge(Admin Mirror)
       │                               │
       └────────── Host Proxy / AK Web Proxy ──────────┘
```

### 4.3 核心结论

主代理永远是主代理。

远程协助核心只做三类事：

- 观察
- 同步
- 复用

它不应该负责：

- 替代现有主转发
- 接管主站点登录语义
- 直接改变既有代理逻辑的结果

---

## 五、推荐目录结构

建议后续将远程协助模块目录规划为：

```text
public_admin/
├── proxy_server.py                 # 宿主，保留为主入口
├── admin.html                      # 宿主 UI
├── docs/
│   ├── README_多隧道与限速研究.md
│   └── README_远程协助插件化架构设计.md
└── remote_assist/
    ├── __init__.py
    ├── facade.py                   # 宿主唯一调用入口
    ├── flags.py                    # 功能开关与灰度配置
    ├── types.py                    # 数据结构定义
    ├── session_manager.py          # 协助会话管理
    ├── policy_engine.py            # 权限与策略判断
    ├── event_bus.py                # 协助事件发布/订阅
    ├── snapshot_cache.py           # 响应镜像缓存（可插拔）
    ├── audit_logger.py             # 审计日志
    ├── injector.py                 # 条件注入逻辑
    ├── ws_handlers.py              # 协助专用 WS 处理
    ├── bridge/
    │   ├── user_bridge.js          # 用户页面桥接脚本
    │   ├── admin_bridge.js         # 管理员镜像桥接脚本
    │   └── highlight.css           # 描红样式
    └── adapters/
        ├── __init__.py
        ├── base.py                 # 抽象适配器接口
        ├── ak_web.py               # AK 网站适配器
        └── generic_http.py         # 未来通用 HTTP 站点适配器
```

### 5.1 目录设计要求

- `proxy_server.py` 只做**宿主接线**，不堆协助业务细节
- 远程协助核心逻辑应集中在 `remote_assist/`
- 站点差异化逻辑一律进 `adapters/`
- 页面桥接逻辑一律进 `bridge/`

这样未来迁移到其他业务时，原则上只需要：

- 替换适配器
- 调整桥接脚本策略
- 保留核心引擎不变

---

## 六、核心数据模型

### 6.1 AssistSession

表示一次协助会话。

建议字段：

| 字段 | 含义 |
|------|------|
| `session_id` | 协助会话唯一 ID |
| `site_type` | 当前站点类型，如 `ak_web` |
| `target_user` | 被协助用户标识 |
| `admin_user` | 管理员标识 |
| `browse_session_id` | 关联浏览态 ID |
| `status` | `pending / active / closing / closed` |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |
| `last_route` | 最近同步页面路径 |
| `readonly` | 是否只读 |
| `capabilities` | 当前协助能力集合 |

### 6.2 AssistParticipant

表示协助会话中的参与者。

建议字段：

- `participant_id`
- `role`：`admin` / `user`
- `connected`
- `ws_id`
- `last_heartbeat`
- `client_meta`

### 6.3 AssistEvent

表示通过 WebSocket 或总线传递的事件。

建议字段：

- `event_id`
- `session_id`
- `event_type`
- `site_type`
- `timestamp`
- `source_role`
- `payload`
- `schema_version`

建议事件类型：

- `route_changed`
- `click_highlight`
- `hover_highlight`
- `scroll_changed`
- `snapshot_ready`
- `session_closed`
- `mirror_unavailable`

### 6.4 AssistSnapshot

表示一份可供管理员镜像使用的响应快照或结构化页面数据。

建议字段：

- `snapshot_id`
- `session_id`
- `route_key`
- `method`
- `request_fingerprint`
- `status_code`
- `content_type`
- `headers_meta`
- `body_ref`
- `created_at`
- `expires_at`

### 6.5 AdapterCapability

用于声明适配器支持的能力。

建议示例：

- `supports_route_sync`
- `supports_click_highlight`
- `supports_snapshot_replay`
- `supports_dom_patch`
- `supports_control`

---

## 七、关键流程设计

### 7.1 建立协助会话

```text
管理员发起协助
    → Core 创建 AssistSession
    → 校验权限与站点类型
    → 用户进入协助态
    → 管理员镜像页连接协助 WS
    → 用户页面桥接脚本开始上报事件
```

### 7.2 用户访问代理页面

```text
用户请求页面
    → Host Proxy 正常转发到上游
    → 主响应返回给用户
    → Assist Core 旁路观察本次请求/响应
    → 若命中协助会话，则生成快照或事件摘要
    → 通过 EventBus 通知管理员镜像页可更新
```

**关键要求：**

- 主响应必须优先返回
- 协助快照写入不得阻塞主请求

### 7.3 点击描红同步

```text
用户点击页面组件
    → User Bridge 采集元素定位信息
    → 上报 click_highlight 事件
    → Admin Bridge 接收事件
    → 管理员镜像页对应元素描红
```

可选地，管理员只读侧也可允许点击后仅做“描红指示”，不触发真实业务动作。

### 7.4 路由同步

```text
用户切换页面/路由
    → User Bridge 上报 route_changed
    → AssistSession 更新 last_route
    → 管理员镜像页跳转到相同代理路径
    → 需要时优先复用协助快照
```

### 7.5 协助异常降级

```text
Assist Cache / WS / Bridge 任一异常
    → 记录日志
    → 标记本次协助能力退化
    → 主代理流程保持不变
    → 协助界面显示“协助暂不可用”
```

---

## 八、最小侵入接入点

### 8.1 接入原则

宿主对协助模块的调用必须通过一个非常薄的门面层完成，例如：

- `remote_assist.facade.observe_response(...)`
- `remote_assist.facade.should_inject(...)`
- `remote_assist.facade.build_injection(...)`
- `remote_assist.facade.publish_event(...)`

宿主不应直接了解：

- 协助缓存细节
- 协助 WS 细节
- 站点适配器细节
- 事件编码细节

### 8.2 推荐接入位置

第一阶段只建议在以下位置挂接：

- **AK 网页代理响应输出点**
  - 用于观察响应、条件注入桥接脚本

- **管理员后台协助面板入口**
  - 用于发起/关闭协助会话

- **协助专用 WebSocket 端点**
  - 用于传输协助事件

### 8.3 明确禁止的做法

- 在所有路由中硬编码大量协助逻辑
- 全站默认注入协助脚本
- 为了协助功能改写原有登录/鉴权结果
- 为了协助缓存重构主响应路径
- 把协助状态混写进现有主业务核心对象

---

## 九、插件化与站点适配器设计

### 9.1 为什么必须做适配器

远程协助未来如果要迁移到“代理其他网站”的场景，最大的差异通常不是核心引擎，而是：

- 路由结构不同
- 页面注入点不同
- DOM 元素选择策略不同
- 站点资源替换规则不同
- 敏感字段脱敏规则不同

因此必须把“站点特定逻辑”抽成适配器。

### 9.2 BaseSiteAdapter 抽象

建议抽象接口至少包含：

- `site_type()`
- `match_request(request) -> bool`
- `should_enable_assist(session, request) -> bool`
- `build_injection_context(session, request, response) -> dict`
- `normalize_route(request, response) -> str`
- `extract_click_target(dom_meta) -> dict`
- `redact_snapshot(content_type, body) -> body`
- `supports(capability) -> bool`

### 9.3 AK 站点适配器

第一版的 `AkWebAdapter` 负责：

- 识别 `/admin/ak-web/*` 与 `/admin/ak-site/*`
- 构造 AK 站点的协助注入上下文
- 提供 AK 页面元素定位、高亮与路由标准化逻辑
- 指定哪些页面允许协助、哪些页面需要脱敏或禁止

### 9.4 通用 HTTP 适配器

后续如果要支持其他站点，可基于 `GenericHttpAdapter` 做轻量迁移。

它应尽量抽象出：

- 通用页面注入模式
- 通用点击目标编码规则
- 通用路由识别方式
- 通用事件协议

### 9.5 插件迁移边界

插件化不是说“对所有网站都零适配”。

更准确地说：

- **核心引擎可复用**
- **站点适配器可替换**
- **桥接脚本策略可微调**

达到的目标是：

> 切换到其他业务代理站点时，不需要重写协助系统，只需要替换适配器与少量桥接规则。

---

## 十、稳定性与故障隔离

### 10.1 功能开关

必须支持多级开关：

- 全局开关：是否启用远程协助模块
- 站点开关：是否对某类站点启用
- 会话开关：是否对当前会话启用
- 能力开关：是否启用描红、路由同步、快照复用等子能力

### 10.2 超时与资源上限

协助模块必须配置：

- 快照缓存大小上限
- 单会话事件队列上限
- 单会话心跳超时
- 注入上下文构造超时
- 广播发送超时

### 10.3 失败处理策略

统一策略：**no-op + 日志 + 退化**。

例如：

- 桥接脚本构造失败：不注入
- 快照写入失败：跳过快照
- 广播失败：当前管理员看不到更新，但用户页面正常
- 适配器异常：当前站点协助失效，但站点访问正常

### 10.4 隔离策略

建议隔离：

- 独立命名空间的协助 WS
- 独立缓存前缀
- 独立审计日志标签
- 独立事件 schema
- 独立功能开关

### 10.5 主链路保护原则

任何时候都必须遵守：

- 先主响应，后协助观察
- 先业务可用，后协助增强
- 协助异常绝不改变主返回值

---

## 十一、可维护性设计

### 11.1 门面模式

宿主只调用 `facade.py`，把内部复杂度全部藏起来。

收益：

- 宿主改动少
- 回滚方便
- 便于后续重构实现细节

### 11.2 明确的 schema version

所有事件协议都必须带 `schema_version`。

原因：

- 后续桥接脚本升级时兼容旧版本更容易
- 管理员端与用户端脚本不同步时更容易定位问题

### 11.3 强类型数据结构

后续实现时应优先使用统一的数据结构定义，而不是随意拼 dict。

建议：

- `types.py` 中统一声明核心对象
- 事件 payload 尽量结构化、可校验

### 11.4 适配器注册机制

适配器必须通过注册表统一管理，而不是在各处 `if site == xxx`。

收益：

- 新站点接入可控
- 差异化逻辑不污染核心

### 11.5 文档先行

开发时必须同步维护：

- 事件协议文档
- 会话状态机文档
- 适配器开发规范
- 功能开关说明

---

## 十二、可拓展性设计

### 12.1 从只读协助扩展到轻控制

后续若需要从“只读协助”扩展到“有限控制”，建议顺序如下：

1. 点击描红
2. 只读定位
3. 管理员建议点击
4. 用户确认后执行
5. 明确授权下的有限控制

不建议直接跳到完全控制。

### 12.2 从 AK 站点扩展到其他站点

扩展路线：

- 保持 Core 不变
- 新增 SiteAdapter
- 按站点补桥接策略
- 按站点补脱敏规则

### 12.3 从响应复用扩展到 DOM patch

扩展路线：

- MVP：路由同步 + 点击描红 + 只读镜像
- V1：响应摘要/快照缓存
- V2：局部 DOM 差异同步
- V3：有限交互控制

### 12.4 与传统远控并存

远程协助插件不应排斥传统远控，未来可以形成：

- 业务内协助：默认方案
- 系统级问题：兜底远控

---

## 十三、安全、权限与审计

### 13.1 权限原则

第一版必须遵守：

- 管理员默认只读
- 用户进入协助态必须明确触发
- 敏感页面可禁用协助
- 敏感字段必须可脱敏

### 13.2 审计要求

建议至少记录：

- 协助发起人
- 被协助对象
- 协助会话 ID
- 会话开始/结束时间
- 关键路由切换
- 关键描红事件
- 是否进入控制态（如后续扩展）

### 13.3 敏感信息处理

后续实现时必须预留：

- 字段级脱敏规则
- 页面级禁用名单
- 站点级审计开关

---

## 十四、分阶段落地规划

### P0：架构骨架（只接线，不影响主功能）

目标：

- 建立 `remote_assist/` 模块框架
- 完成功能开关、门面层、会话模型、空实现适配器
- 宿主完成极小接线，但默认关闭

验收：

- 功能关闭时，现有系统行为与现在一致

### P1：MVP 只读协助

目标：

- 协助会话建立/关闭
- 管理员只读镜像页
- 用户路由同步
- 点击描红同步

验收：

- 用户页面正常访问
- 管理员可只读观察并看到高亮
- 协助异常不影响主流程

### P2：响应观察与快照复用

目标：

- 对协助会话中的关键响应做旁路缓存
- 管理员镜像端尽量复用而非重复拉取

验收：

- 主响应延迟无明显恶化
- 快照失败不影响页面可用性

### P3：增强同步

目标：

- 滚动同步
- 局部状态同步
- 部分 DOM patch

验收：

- 一致性增强，但仍保持故障不扩散

### P4：有限控制（可选）

目标：

- 在审计、授权、权限边界清晰的前提下，提供极有限控制能力

说明：

- 此阶段不应纳入第一版范围

---

## 十五、明确不做与克制项

第一版明确克制以下事项：

- 不做全站通用一键接入
- 不做系统级远控
- 不做默认管理员控制用户
- 不把协助模块直接揉进主代理核心逻辑
- 不以“尽量可用”为理由破坏主链路边界
- 不为了省开发量把站点差异逻辑硬编码进核心层

---

## 十六、验收标准

后续开发必须以以下标准验收：

### 16.1 最小侵入验收

- 功能关闭时，现有主系统行为与当前一致
- 不启用协助时，无额外全局注入与全局副作用

### 16.2 稳定性验收

- 协助模块异常时，用户正常访问不受影响
- 协助模块失败只表现为协助不可用

### 16.3 可维护性验收

- 宿主只依赖门面层，不直接依赖内部细节
- 站点逻辑与核心逻辑分离
- 事件协议有版本号

### 16.4 可拓展性验收

- AK 适配器与核心引擎边界清楚
- 后续新增站点时原则上只新增适配器，不重写核心

### 16.5 产品能力验收

- 管理员能只读观察用户页面
- 用户切换页面可同步
- 用户点击组件可同步描红
- 协助失败不影响既有功能

---

## 十七、模块职责矩阵

本节用于把后续实现中每个模块“能做什么、不能做什么、依赖谁”写死，避免后续开发时职责漂移。

| 模块 | 核心职责 | 允许依赖 | 禁止承担 |
|------|----------|----------|----------|
| `facade.py` | 宿主唯一调用入口；对外暴露稳定 API | `flags.py`、`session_manager.py`、`policy_engine.py`、`event_bus.py` 等内部模块 | 宿主业务细节、站点专属逻辑、页面 DOM 逻辑 |
| `flags.py` | 功能开关、灰度开关、能力开关 | 配置源 | 业务判断、缓存逻辑、事件发送 |
| `session_manager.py` | 协助会话创建、状态流转、参与者绑定 | 存储层、类型定义 | 页面注入、站点适配、直接广播前端事件 |
| `policy_engine.py` | 权限校验、只读策略、页面禁用策略、脱敏策略 | 会话、适配器、配置 | 直接操作响应体、直接持有 WS 连接 |
| `event_bus.py` | 协助事件发布、订阅、批量发送、退化处理 | 会话管理、WS 处理层 | 站点识别、DOM 解析、页面注入 |
| `snapshot_cache.py` | 协助快照缓存、TTL、裁剪与回收 | 存储层、类型定义、策略层 | 改写主响应、决定主链路转发 |
| `injector.py` | 条件注入桥接脚本，构造注入上下文 | 适配器、策略层、会话层 | 直接管理协助会话、直接访问数据库业务表 |
| `ws_handlers.py` | 协助专用 WS 握手、心跳、协议解码 | 会话层、事件总线、策略层 | 站点业务判断、HTML 注入 |
| `audit_logger.py` | 协助日志与审计日志落点 | 会话、事件、策略结果 | 业务流程控制 |
| `adapters/base.py` | 站点适配器抽象接口 | 类型定义 | 宿主路由注册、WS 管理 |
| `adapters/ak_web.py` | AK 站点适配、路由识别、元素定位规范、脱敏规则 | `base.py`、策略层 | 直接修改协助核心状态机 |
| `bridge/user_bridge.js` | 用户页面事件采集、路由变化采集、描红上报 | WS 协议、注入上下文 | 主业务逻辑、复杂控制指令 |
| `bridge/admin_bridge.js` | 管理员镜像页只读渲染、事件接收、描红显示 | WS 协议、镜像容器 | 主站点业务交互、反向控制默认开启 |

### 17.1 依赖方向约束

后续实现时必须遵守以下依赖方向：

```text
Host(proxy_server.py / admin.html)
    -> facade.py
        -> core modules(session/policy/event/cache/inject/audit)
            -> adapters
                -> bridge runtime contract
```

明确禁止的反向依赖：

- `adapters/*` 反向依赖宿主路由实现
- `bridge/*.js` 直接依赖管理员后台其他 tab 的内部脚本
- `snapshot_cache.py` 直接影响主响应返回路径
- `ws_handlers.py` 直接参与主代理转发决策

### 17.2 模块拆分原则

后续如果新增能力，应优先判断它属于哪一层：

- **会话问题**：放 `session_manager.py`
- **权限/禁用/脱敏问题**：放 `policy_engine.py`
- **站点差异问题**：放 `adapters/*`
- **页面桥接问题**：放 `bridge/*.js`
- **宿主接线问题**：只允许通过 `facade.py` 暴露最小接口

---

## 十八、宿主接入点清单

本节用于明确：后续实现时到底应该改哪些文件、哪些位置允许小改、哪些地方尽量不要碰。

### 18.1 推荐接入点

#### A. `public_admin/proxy_server.py`

这是第一阶段最主要的宿主接入点，但必须坚持**小块接线**。

建议只做以下类型改动：

- 注册协助专用 API/WS 路由
- 在 AK 页面代理响应点调用 `facade.observe_response(...)`
- 在 HTML 输出前调用 `facade.try_inject(...)`
- 在管理员协助入口调用 `facade.create_session(...)`

建议接入位置：

- AK 页面代理响应生成完成之后
- HTML 文本确认可注入之后
- 协助专用 WS 路由处
- 管理员发起/关闭协助的 API 处

#### B. `public_admin/admin.html`

这是管理员端 UI 接入点。

建议只做以下改动：

- 增加协助面板容器或弹层容器
- 增加协助只读镜像 iframe / 容器
- 增加协助 WS 客户端接线
- 增加描红展示层

要求：

- 不污染现有 tab 的业务逻辑
- 不把协助逻辑散落到大量无关函数中
- 尽量把新增 JS 聚合到独立模块或独立作用域

#### C. 新增 `public_admin/remote_assist/` 目录

后续绝大多数协助逻辑都应新增到这里。

原则：

- 优先新增文件
- 其次做宿主小接线
- 最后才考虑改已有核心逻辑

### 18.2 尽量不动的文件

#### A. `proxy_server.py`（仓库根目录）

第一阶段不建议把远程协助逻辑接到根级透明代理服务中。

原因：

- 风险面更大
- 更接近主流量入口
- 与当前 `public_admin` 内的 AK 页面协助场景并不完全一致

#### B. `public_admin/database_pg.py`

除非后续需要持久化协助会话、审计与统计，否则第一阶段不建议强行改数据库层。

优先策略：

- 先内存态 / 轻量缓存态
- 再决定是否持久化

#### C. 现有登录/浏览态核心代码块

尤其不要为了协助功能去重构：

- 现有登录态判定
- 浏览态缓存主逻辑
- 与 AK 浏览已稳定运行的主路径

### 18.3 明确的低风险接线方式

推荐使用如下模式：

```python
# 宿主伪代码
response = await existing_proxy_logic(...)

try:
    remote_assist.facade.observe_response(context, response)
except Exception:
    pass

try:
    response = remote_assist.facade.try_inject(context, response)
except Exception:
    pass

return response
```

该模式的关键点：

- 宿主逻辑先完成
- 协助逻辑后挂接
- 协助异常被限制在自身范围

### 18.4 明确禁止的大改方式

禁止：

- 大段替换 `public_admin/proxy_server.py`
- 以远程协助为理由重写现有 AK 代理主逻辑
- 把协助状态混进现有所有全局对象
- 在大量历史函数中散点插入复杂协助分支

后续开发必须坚持：

> **新增模块优先，宿主小接线其次，重构主链路最后。**

---

## 十九、协助专用 WS 协议草案

本节定义第一版远程协助的实时协议草案，目标是：

- 简单
- 稳定
- 可版本化
- 可扩展
- 默认只读优先

### 19.1 总体原则

第一版协议遵守以下原则：

- 默认单向观察：用户侧事件 -> 服务端 -> 管理员侧
- 管理员侧不默认拥有控制权
- 所有消息带版本号
- 未识别事件一律忽略，不得导致连接断开
- 事件尽量结构化，不传大块无必要 HTML

### 19.2 基础信封格式

```json
{
  "v": 1,
  "type": "route_changed",
  "session_id": "as_xxx",
  "site": "ak_web",
  "source": "user_bridge",
  "ts": 1770000000000,
  "payload": {}
}
```

字段说明：

| 字段 | 含义 |
|------|------|
| `v` | 协议版本号 |
| `type` | 事件类型 |
| `session_id` | 协助会话 ID |
| `site` | 当前站点类型 |
| `source` | 事件来源 |
| `ts` | 毫秒时间戳 |
| `payload` | 事件负载 |

### 19.3 第一版建议事件类型

#### A. 握手与会话类

- `client_hello`
- `client_ready`
- `session_state`
- `heartbeat`
- `session_closing`

#### B. 页面同步类

- `route_changed`
- `snapshot_ready`
- `mirror_unavailable`
- `scroll_sync`

#### C. 交互提示类

- `click_highlight`
- `hover_highlight`
- `focus_highlight`

#### D. 控制类（第一版默认关闭）

- `control_request`
- `control_denied`
- `control_approved`

### 19.4 关键事件载荷建议

#### `client_hello`

用途：建立连接时声明角色与能力。

```json
{
  "v": 1,
  "type": "client_hello",
  "session_id": "as_xxx",
  "site": "ak_web",
  "source": "admin_bridge",
  "ts": 1770000000000,
  "payload": {
    "role": "admin",
    "readonly": true,
    "capabilities": ["route_sync", "highlight_view"]
  }
}
```

#### `route_changed`

用途：同步当前代理页面路径。

```json
{
  "v": 1,
  "type": "route_changed",
  "session_id": "as_xxx",
  "site": "ak_web",
  "source": "user_bridge",
  "ts": 1770000000000,
  "payload": {
    "route": "/admin/ak-web/home/index.html",
    "title": "首页",
    "replace": false
  }
}
```

#### `click_highlight`

用途：同步描红目标，而不是执行真实点击。

```json
{
  "v": 1,
  "type": "click_highlight",
  "session_id": "as_xxx",
  "site": "ak_web",
  "source": "user_bridge",
  "ts": 1770000000000,
  "payload": {
    "selector_hint": "button.submit-order",
    "text_hint": "确认",
    "rect": {"x": 120, "y": 260, "w": 88, "h": 32},
    "path_hint": [0, 3, 2, 1]
  }
}
```

#### `snapshot_ready`

用途：告知管理员镜像端某个页面快照已可用。

```json
{
  "v": 1,
  "type": "snapshot_ready",
  "session_id": "as_xxx",
  "site": "ak_web",
  "source": "assist_core",
  "ts": 1770000000000,
  "payload": {
    "route": "/admin/ak-web/home/index.html",
    "snapshot_id": "snap_xxx",
    "content_type": "text/html"
  }
}
```

#### `heartbeat`

用途：连接保活。

```json
{
  "v": 1,
  "type": "heartbeat",
  "session_id": "as_xxx",
  "site": "ak_web",
  "source": "admin_bridge",
  "ts": 1770000000000,
  "payload": {
    "role": "admin"
  }
}
```

### 19.5 服务端路由规则

第一版推荐：

- 用户桥接侧只发语义事件
- 服务端做会话校验、权限校验、事件过滤
- 管理员镜像侧只接收允许的只读事件

推荐转发规则：

```text
user_bridge  -> assist_core -> admin_bridge
admin_bridge -> assist_core -> (默认不向 user_bridge 下发控制类事件)
```

### 19.6 第一版协议边界

第一版明确不做：

- 鼠标移动高频流式同步
- 键盘逐字输入控制
- 全量 DOM 变更广播
- 全量 HTML 片段经 WS 推送

原因：

- 对性能不友好
- 对一致性帮助有限
- 会显著增加侵入性与复杂度

### 19.7 协议演进建议

后续如果要升级协议，建议按以下顺序演进：

1. `v1`：路由、描红、心跳、快照通知
2. `v2`：滚动同步、有限页面状态同步
3. `v3`：有限控制请求与授权流程
4. `v4`：必要场景的 DOM patch 或更高精度同步

---

## 结语

这套远程协助能力的正确定位不是“网页版远程桌面”，而是：

> **建立在透明代理之上的、只读优先的、低带宽的、可审计的业务级协助插件。**

后续开发必须始终遵守本文档的最高约束：

> **远程协助可以失效，但不能影响主功能；功能必须默认旁路化、按会话启用、可被独立替换。**

---

*本文档用于后续设计与开发指导。若后续进入实现阶段，应继续细化接口说明、事件字段规范、适配器开发规范与测试策略。*
