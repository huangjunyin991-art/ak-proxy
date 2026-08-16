# AK 挂卖 API

所有接口都位于 `/admin/api/ak-sell`，只需要有效的 AK 自动挂卖机器授权，不要求管理后台 Bearer Token。请求体为 JSON；服务端只接受本文列出的字段，经现有 Nginx 和出口调度转发到 AK。挂卖服务调用使用进程内随机受信标记，并按账号互斥、允许不同账号并行；普通用户 RPC 仍保留全局优先锁。AK Sell 不创建第二份凭据库，登录仍经过现有 `/RPC/Login` 拦截器，并复用 `user_stats` 中已保存的密码、Key、登录响应和 Cookie。

每次请求必须携带机器授权请求头：

```http
X-AK-Authorization: <ak_auto_sell 八小时授权码>
```

`X-AK-Authorization` 是 `/api/v1/offline-authorization` 签发的 `authorization_code`。服务端会验签、确认产品为 `ak_auto_sell`，并实时查询激活码和机器绑定状态；授权码过期、设备禁用、激活码撤销/过期或授权中心不可用时，均不会转发任何上游 AK 请求。

所有请求都由服务端使用已 NTP 同步的北京时间计算上游 `v`（`年 + 月 + 日 + 时 + 分`）；客户端传入的 `v` 会被忽略。每个成功或失败响应均带有 `server_time`，客户端不应使用自身时钟生成上游参数。

## 账号登录态复用

除 `/login` 外，认证接口同时支持两种方式：

- 兼容方式：传入 `key` 与 `UserID`。
- 推荐方式：只传入 `account`。服务端从该账号在 `user_stats` 中的有效登录态补齐 `key` 和 `UserID`。

登录态有效时不会再调用上游登录。登录态缺失或过期时，服务端仅在 `user_stats` 已有该账号密码的前提下登录一次，并由既有登录拦截器更新同一份缓存。若账号未保存密码，先调用 `/login` 完成一次登录。

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

服务端固定补充 `client=WEB`。成功响应中的 `payload.Key` 与 `payload.UserData.Id` 会由现有登录拦截器写入 `user_stats`，供后续 `account` 方式复用。

## 读取助记词校验位

`POST /mnemonic`

```json
{"account":"账号","lang":"cn"}
```

## 读取主账号余额

`POST /balance`

```json
{"account":"账号","lang":"cn"}
```

余额位于上游响应的 `payload.Data.ACECount`。

## 读取子账号

`POST /subaccounts`

```json
{"account":"账号","lang":"cn","p":1,"pageSize":50}
```

`account` 是登录态所属账号；`p` 与 `pageSize` 为正整数，`pageSize` 最大为 100。

## 提交挂卖

`POST /submit`

```json
{
  "account":"账号",
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

## 谷歌验证绑定

`POST /google-bind`

```json
{
  "account":"账号",
  "lang":"cn",
  "activationCode":"谷歌激活码",
  "tradePassword":"交易密码"
}
```

服务端临时向 AK 换取谷歌密钥、以服务端时间生成验证码并完成绑定。成功响应额外包含一次性的 `google_secret`，客户端须立即存入本机安全存储；服务端不保存密钥、激活码或交易密码。

## 谷歌验证解绑

`POST /google-unbind`

```json
{
  "account":"账号",
  "lang":"cn",
  "tradePassword":"交易密码",
  "mnemonicWords":["助记词 1", "助记词 2"]
}
```

服务端临时读取本次解绑所需的三个助记词校验位后转发解绑请求，不保存助记词或交易密码。

## 响应约定

- 上游正常响应均在 `payload` 原样返回；`success` 依据上游 `Error` 判断。
- `state=completed` 表示上游业务成功，`state=rejected` 表示上游已明确拒绝。
- `state=waiting` 表示同一账号的 RPC 正在排队，客户端可以稍后重试。
- `state=auth_expired` 表示上游明确拒绝了已缓存的登录态。服务端已清除该 Key；客户端再次提交时会先刷新登录。
- 已发出的挂卖提交、Google 绑定和解绑出现读取超时时返回 HTTP 504 及 `state=unknown`。客户端不得自动重发该请求，因为上游可能已完成写入；提交前登录态刷新等前置步骤超时会按普通失败返回，客户端可稍后重试。
- 客户端定时任务只在定时点调用上述接口；服务端没有自动业务任务，服务重启不会产生补发行为。
