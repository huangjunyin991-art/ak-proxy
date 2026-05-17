# AK Client Runtime 重构记录

## 背景

原 `public_admin/frontend/host/chat_widget.js` 已不再只是聊天组件，而是被代理 AK 用户页面的客户端运行时。它同时承担登录保持、API 重写、PWA、IM 插件启动、在线状态、远程协助、远程语音和页面补丁等职责。

继续使用 `chat_widget` 命名会误导维护者，也会让后续功能继续堆叠到单一大文件中。因此重构目标是逐步把它迁移为模块化、松耦合、可降级的 AK client runtime。

## 重构原则

1. 每次只做一个阶段，避免一次性大拆。
2. 外部行为优先保持兼容，旧 URL 和旧入口不要直接删除。
3. 模块应该尽可能独立运行。
4. 单个模块失败时，只缺少对应功能，不应导致整站崩溃。
5. 新功能或重构前先给出设计方案，确认后再写代码。
6. Git 操作和验证命令必须在明确授权后执行。
7. 用户取消操作后必须立即停止，并询问原因，不继续执行。

## 当前运行时定位

当前运行时负责以下能力：

- 登录保持与自动登录
- 登录请求凭据捕获
- API URL 重写
- fetch / XMLHttpRequest / jQuery AJAX 拦截
- PWA manifest 与 Service Worker 注册
- 首页 IM 插件与通知组件启动
- ChatWS 在线状态、心跳和管理员消息
- 远程协助请求、连接恢复、路由同步、快照同步、点击高亮、滚动同步
- 远程语音邀请、绑定、静音和状态条
- 特定页面补丁，例如附近玩家首卡返回上一级

## 已完成：第一阶段内部源码迁移

### 新源码路径

```text
public_admin/frontend/host/runtime/ak_client_runtime.js
```

### 旧源码路径

```text
public_admin/frontend/host/chat_widget.js
```

旧文件当前按要求暂时保留，不删除。

### 后端读取路径

`public_admin/server/proxy_server.py` 中新增：

```python
AK_CLIENT_RUNTIME_JS_PATH = os.path.join(FRONTEND_HOST_DIR, "runtime", "ak_client_runtime.js")
```

以下逻辑已切换到新路径：

- `_iter_widget_asset_paths()` 的运行时源码版本号计算
- `/chat/widget.bundle.js` 的运行时源码读取

## 已完成：第二阶段外部运行时 URL 兼容迁移

### 新语义化 URL

```text
/ak/client-runtime.js
```

### 旧兼容 URL

```text
/chat/widget.bundle.js
```

两者当前返回同一个运行时源码：

```text
public_admin/frontend/host/runtime/ak_client_runtime.js
```

### Loader 当前行为

新 loader 入口：

```text
/admin/api/ak-client-runtime-loader
```

旧 loader 入口仍保留兼容：

```text
/chat/widget.js
/admin/api/chat-widget-loader
```

但 loader 当前优先加载新运行时 URL：

```text
/ak/client-runtime.js?v=...
```

### URL 重写兼容范围

`_rewrite_widget_asset_urls()` 当前识别：

```text
/chat/widget.js
/chat/widget.bundle.js
/ak/client-runtime.js
/chat/notification-widget.js
/chat/plugins/notification/user/widget.js
```

## 当前未完成事项

### 1. 旧源码文件未删除

暂时保留：

```text
public_admin/frontend/host/chat_widget.js
```

后续确认稳定后再删除。

### 2. 运行时源码尚未模块拆分

当前 `ak_client_runtime.js` 仍是原大文件内容，只完成命名和路径迁移。

## 已完成：第三阶段语义化 loader

### 新 loader URL

```text
/admin/api/ak-client-runtime-loader
```

### 旧 loader URL

```text
/admin/api/chat-widget-loader
```

### 旧 PWA 兼容 URL

```text
/admin/api/pwa-widget
```

以上三个 URL 当前都返回同一个 loader 响应。

### 内部 URL 重写

`_rewrite_widget_asset_url()` 现在会把：

```text
/chat/widget.js
```

重写为：

```text
/admin/api/ak-client-runtime-loader
```

旧 `/admin/api/chat-widget-loader` 仍保留给 Nginx 和旧缓存兼容。

## 已完成：第四阶段迁移 Nginx 注入路径

`public_admin/config/nginx.conf` 已将 `/chat/widget.js` 的替换目标从：

```html
/admin/api/chat-widget-loader
```

迁移到：

```html
/admin/api/ak-client-runtime-loader
```

`<head>` 注入脚本也已迁移为：

```html
<script src="/admin/api/ak-client-runtime-loader"></script>
```

旧路径继续保留兼容。

## 已完成：第五阶段第一步 manifest 与页面补丁模块

当前已引入运行时模块清单：

```text
public_admin/frontend/host/runtime/runtime_manifest.json
```

后端只读取 manifest，并按 manifest 顺序拼接运行时模块。

当前 manifest 包含：

```text
patches/recommend_friend_patch.js  optional
ak_client_runtime.js              required
```

已抽离的页面补丁模块：

```text
public_admin/frontend/host/runtime/patches/recommend_friend_patch.js
```

该模块通过以下命名空间暴露安装函数：

```js
window.AKClientRuntimePatches.installRecommendFriendFirstCardBackPatch
```

主运行时只做能力检测式调用：

```js
if (window.AKClientRuntimePatches && typeof window.AKClientRuntimePatches.installRecommendFriendFirstCardBackPatch === 'function') {
    window.AKClientRuntimePatches.installRecommendFriendFirstCardBackPatch();
}
```

如果该 optional 模块缺失，只会导致“附近玩家首卡返回上一级”功能失效，不影响登录、API 拦截、IM、PWA、ChatWS、远程协助和远程语音。

后端拼接策略：

- `required: true` 模块缺失时，返回 `// not found`
- `required: false` 模块缺失时，跳过该模块并继续返回主运行时
- `runtime_manifest.json` 与各模块文件都会参与版本号计算

## 后续推荐阶段

### 后续内部模块化拆分

建议目录：

```text
public_admin/frontend/host/runtime/
  core/
    runtime_context.js
    feature_registry.js
    scheduler.js
  auth/
    credential_store.js
    login_capture.js
    auto_login.js
  network/
    api_url_rewriter.js
    request_interceptor.js
  pwa/
    pwa_runtime.js
  im/
    im_loader.js
    notification_widget.js
  chat/
    chat_ws_client.js
    presence_client.js
    admin_message_widget.js
  assist/
    assist_ws_client.js
    assist_route_sync.js
    assist_snapshot.js
    assist_scroll_sync.js
    assist_click_highlight.js
  voice/
    remote_voice_runtime.js
    remote_voice_ui.js
  patches/
    recommend_friend_patch.js
  index.js
```

### 推荐拆分顺序

1. `patches/recommend_friend_patch.js`
2. `pwa/pwa_runtime.js`
3. `im/im_loader.js` 与 `im/notification_widget.js`
4. `auth/`
5. `network/`
6. `chat/`
7. `assist/`
8. `voice/`

远程协助和语音风险最高，应最后拆。

## 启动策略约束

### 所有页面立即执行

- 登录保持
- 登录捕获
- API 重写
- 网络请求拦截
- 页面补丁注册

### 所有页面延迟执行

- ChatWS 在线状态
- 远程协助主体

原因：远程协助必须跨页面同步，不能只在首页启动。

### 仅首页执行

只在以下页面执行：

```text
/
/pages/home.html
```

能力：

- PWA
- IM 插件
- 通知组件

原因：AK/EP 等交易页不需要这些插件，避免移动端性能回退。

## 验证清单

每个阶段完成后建议验证：

```powershell
node --check public_admin/frontend/host/runtime/patches/recommend_friend_patch.js
node --check public_admin/frontend/host/runtime/ak_client_runtime.js
python -m json.tool public_admin/frontend/host/runtime/runtime_manifest.json
python -m py_compile public_admin/server/proxy_server.py
```

部署后建议验证：

```bash
curl -I https://ak2025.vip/ak/client-runtime.js
curl -I https://ak2025.vip/chat/widget.bundle.js
curl -s https://ak2025.vip/admin/api/ak-client-runtime-loader | grep '/ak/client-runtime.js'
curl -s https://ak2025.vip/admin/api/chat-widget-loader | grep '/ak/client-runtime.js'
```

功能验证：

- 登录保持仍正常
- AK/EP 交易页加载不卡顿
- 首页 IM/PWA/通知仍正常
- 远程协助跨页面同步正常
- 远程协助管理员端只响应点击
- 附近玩家首卡返回上一级正常

## 回滚策略

如果新 URL 或新路径出现问题：

1. 将 `_build_widget_loader_response()` 中的运行时 URL 从：

```text
/ak/client-runtime.js
```

恢复为：

```text
/chat/widget.bundle.js
```

2. 将 `AK_CLIENT_RUNTIME_JS_PATH` 恢复为旧路径：

```python
os.path.join(FRONTEND_HOST_DIR, "chat_widget.js")
```

3. 保留旧外部 URL，不删除兼容路由。

## 当前注意事项

- 当前阶段已提交并推送：`ccbb3d7 重构用户侧运行时入口命名`。
- 第五阶段第一步 manifest 与页面补丁模块拆分尚未提交。
- 当前尚未删除旧 `chat_widget.js`。
- 上一提交已执行本地静态验证：`node --check public_admin/frontend/host/runtime/ak_client_runtime.js`、`python -m py_compile public_admin/server/proxy_server.py`、`git diff --check -- public_admin/server/proxy_server.py public_admin/config/nginx.conf`。
- 后续新的验证命令或 Git 操作仍需要用户明确授权后执行。
