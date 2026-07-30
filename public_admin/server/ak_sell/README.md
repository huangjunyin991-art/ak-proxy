# AK 挂卖 API

所有接口都位于 `/admin/api/ak-sell`，需要总管理员身份和有效的 AK 自动挂卖机器授权。请求体为 JSON；服务端只接受本文列出的字段，经现有 Nginx 和出口调度转发到 AK。登录、助记词、子账号和挂卖提交还与现有用户请求共享 RPC 锁，不保存请求参数、密码、Key、助记词或 Google 验证码。

每次请求都必须同时携带两个不同的请求头：

```http
Authorization: Bearer <管理员令牌>
X-AK-Authorization: <ak_auto_sell 八小时授权码>
```

`X-AK-Authorization` 是 `/api/v1/offline-authorization` 签发的 `authorization_code`。服务端会验签、确认产品为 `ak_auto_sell`，并实时查询激活码和机器绑定状态；授权码过期、设备禁用、激活码撤销/过期或授权中心不可用时，均不会转发任何上游 AK 请求。

所有请求都由服务端使用已 NTP 同步的北京时间计算上游 `v`（`年 + 月 + 日 + 时 + 分`）；客户端传入的 `v` 会被忽略。每个成功或失败响应均带有 `server_time`，客户端不应使用自身时钟生成上游参数。

## 时间同步

`GET /time`

```json
{
  "success": true,
  "server_time": {
    "epoch_ms": 1785417120000,
    "utc": "2026-07-30T13:12:00Z",
    "beijing": "2026-07-30T21:12:00+08:00",
    "v": "2096"
  }
}
```

响应带 `Cache-Control: no-store`。客户端在发起请求和收到响应时各记录一次本地毫秒时间，用 `server_time.epoch_ms - (sent_ms + received_ms) / 2` 计算时钟偏移；网络延迟异常大的样本应丢弃。

## 登录

`POST /login`

```json
{"account":"账号","password":"密码"}
```

服务端固定补充 `client=WEB`。成功响应中的 `payload.Key` 与 `payload.UserData.Id` 可用于后续接口。

## 读取助记词校验位

`POST /mnemonic`

```json
{"key":"Key","UserID":"用户 ID","lang":"cn"}
```

## 读取主账号余额

`POST /balance`

```json
{"key":"Key","UserID":"用户 ID","lang":"cn"}
```

余额位于上游响应的 `payload.Data.ACECount`。

## 读取子账号

`POST /subaccounts`

```json
{"key":"Key","UserID":"用户 ID","lang":"cn","account":"","p":1,"pageSize":50}
```

`account` 可以为空字符串；`p` 与 `pageSize` 为正整数，`pageSize` 最大为 100。

## 提交挂卖

`POST /submit`

```json
{
  "key":"Key",
  "UserID":"用户 ID",
  "lang":"cn",
  "mnemonicid1":1,
  "mnemonickey":"助记词校验 Key",
  "mnemonicstr1":"对应助记词",
  "gCode":"Google OTP",
  "count":100,
  "sonId":""
}
```

`sonId` 为空时调用 `ACE_Sell`，有值时调用 `ACE_Sell_Son`。服务端固定传递空的 `amount` 和 `password`，与原客户端逻辑一致。

## 响应约定

- 上游正常响应均在 `payload` 原样返回；`success` 依据上游 `Error` 判断。
- `state=completed` 表示上游业务成功，`state=rejected` 表示上游已明确拒绝。
- `state=waiting` 表示同一账号的 RPC 正在排队，客户端可以稍后重试。
- 提交挂卖出现读取超时时返回 HTTP 504 及 `state=unknown`。客户端不得自动重发该请求，因为上游可能已完成挂卖。
- 客户端定时任务只在定时点调用上述接口；服务端没有自动任务或凭据缓存，因此服务重启不会产生补发行为。
