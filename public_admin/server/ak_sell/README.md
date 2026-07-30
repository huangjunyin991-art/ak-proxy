# AK 挂卖 API

所有接口都位于 `/admin/api/ak-sell`，需要总管理员身份。请求体为 JSON；服务端只接受本文列出的字段，经现有 Nginx 和出口调度转发到 AK。登录、助记词、子账号和挂卖提交还与现有用户请求共享 RPC 锁，不保存请求参数、密码、Key、助记词或 Google 验证码。

除登录外，上游要求 `v`。客户端按当前北京时间计算：`年 + 月 + 日 + 时 + 分`，例如 2026-07-30 21:12 的值为 `2096`。

## 登录

`POST /login`

```json
{"account":"账号","password":"密码"}
```

服务端固定补充 `client=WEB`。成功响应中的 `payload.Key` 与 `payload.UserData.Id` 可用于后续接口。

## 读取助记词校验位

`POST /mnemonic`

```json
{"key":"Key","UserID":"用户 ID","v":"2069","lang":"cn"}
```

## 读取主账号余额

`POST /balance`

```json
{"key":"Key","UserID":"用户 ID","v":"2069","lang":"cn"}
```

余额位于上游响应的 `payload.Data.ACECount`。

## 读取子账号

`POST /subaccounts`

```json
{"key":"Key","UserID":"用户 ID","v":"2069","lang":"cn","account":"","p":1,"pageSize":50}
```

`account` 可以为空字符串；`p` 与 `pageSize` 为正整数，`pageSize` 最大为 100。

## 提交挂卖

`POST /submit`

```json
{
  "key":"Key",
  "UserID":"用户 ID",
  "v":"2069",
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
