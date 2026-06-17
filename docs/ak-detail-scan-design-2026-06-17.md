# AK 订单详情补扫与统计设计

日期：2026-06-17

## 背景

`/RPC/Public_ACE` 公开列表存在分页上限：当前验证中 `p=1~100` 有效，`p=101` 起重复第 100 页。仅依赖公开列表最多只能拿到最近 1500 条，而且会过滤部分卖家 `FlowNumber=0` 的订单。

`/RPC/Public_ACE_Detail` 可以按 `tId` 直接查询订单详情，已经验证公开列表缺失的 `tId` 仍可通过详情接口查到。因此后续统计应以 `tId` 详情补扫为主，公开列表只作为发现最新 `tId` 的入口。

## 目标

- 按连续 `tId` 扫描，突破 `/RPC/Public_ACE` 1500 条限制。
- 每个订单同时调用详情接口和买入明细接口。
- 只保存用户标注 `#` 的业务字段；未标注字段不落业务表。
- 支持断点续扫、限速、重复数据 upsert。
- 后续可以按日统计挂卖量、交易销毁、成交量、成交价值、买家数量、卖家数量、特殊卖家 `FlowNumber=0` 数据。

## 数据源

### 订单详情

接口：

```text
GET /RPC/Public_ACE_Detail
```

参数：

```text
tId=<订单ID>
key=<登录Key>
UserID=<当前用户ID>
v=<动态版本>
lang=cn
```

只保存用户标注 `#` 的业务字段：

| 字段 | 来源 | 含义 |
| --- | --- | --- |
| single_price | `Data.SinglePrice` | 成交价 |
| readonly_stock_count | `Data.ReadonlyStockCount` | 挂卖总数 |
| mycancel | `Data.mycancel` | 交易销毁 |
| success | `Data.success` | 成交量，也等于买入明细 AceAmount 合计 |
| success_value | `Data.successvalue` | 成交价值 |
| create_time | `Data.CreateTime` | 成交时间 |
| seller_flow_number | `Data.User.FlowNumber` | 卖家 ID |

不保存：

- `Data.Id`
- `TradeState`
- `StockCount`
- `Data.User.Id`
- `NickName`
- `Avatar`
- 其他展示字段
- 原始响应全文

说明：`tId` 作为扫描和关联用的内部主键必须保存，但它来自请求参数，不作为上游响应业务字段统计。

### 买入明细

接口：

```text
GET /RPC/Public_ACE_Detail_List
```

参数：

```text
p=<页码>
pageSize=15
tId=<订单ID>
uId=<订单详情里的 Data.User.Id>
key=<登录Key>
UserID=<当前用户ID>
v=<动态版本>
lang=cn
```

数组成员只保存用户标注 `#` 的业务字段：

| 字段 | 来源 | 含义 |
| --- | --- | --- |
| buyer_flow_number | `User.FlowNumber` | 买家 ID |
| ak_amount | `AceAmount` | 买入数量 |

不重复保存：

- `Id`
- `SinglePrice`
- `CreateTime`
- 买家 `NickName`
- 买家 `Avatar`

这些字段都共用订单详情表中的成交价和成交时间。
说明：买入明细仍需保存当前 `tId` 作为关联键，否则无法知道买家明细属于哪笔订单。`tId` 来自请求参数，不来自响应字段。

## 存储设计

### `ak_trade_summary`

按订单一行保存，只存标注字段和内部关联键。

建议唯一键：

```text
trade_id
```

字段：

```text
trade_id BIGINT PRIMARY KEY
single_price NUMERIC
readonly_stock_count NUMERIC
mycancel NUMERIC
success NUMERIC
success_value NUMERIC
create_time TIMESTAMP
date_key DATE
seller_flow_number TEXT
updated_at TIMESTAMP
created_at TIMESTAMP
```

### `ak_trade_buyers`

按买入明细数组成员保存，只存标注字段和内部关联键。

字段：

```text
id BIGSERIAL PRIMARY KEY
trade_id BIGINT
buyer_flow_number TEXT
ak_amount NUMERIC
created_at TIMESTAMP
```

去重建议：

```text
UNIQUE(trade_id, buyer_flow_number, ak_amount)
```

如果同一订单内同一买家可能出现多条完全相同 `AceAmount`，则改成每次重抓该 `trade_id` 前先删除旧买家明细，再整体插入，避免依赖响应里的 `Id`。

建议索引：

```text
idx_ak_trade_summary_date_key(date_key)
idx_ak_trade_summary_create_time(create_time)
idx_ak_trade_summary_seller_flow(seller_flow_number)
idx_ak_trade_buyers_trade_id(trade_id)
idx_ak_trade_buyers_flow(buyer_flow_number)
```

### `ak_scan_checkpoint`

保存扫描断点。

字段：

```text
scan_name TEXT PRIMARY KEY
next_trade_id BIGINT
direction TEXT
target_date DATE
last_success_trade_id BIGINT
last_seen_create_time TIMESTAMP
status TEXT
last_error TEXT
updated_at TIMESTAMP
```

## 扫描流程

1. 使用 `/RPC/Public_ACE` 第 1 页获取最新订单 ID，作为扫描起点。
2. 从起点 `tId` 开始递减扫描。
3. 对每个 `tId` 调用 `/RPC/Public_ACE_Detail`。
4. 如果 `Error=false` 且 `Data` 存在，则保存订单概要字段。
5. 取订单详情里的 `Data.User.Id` 只作为下一步请求 `Detail_List` 的临时参数，不入库。
6. 调用 `/RPC/Public_ACE_Detail_List` 获取买入明细。
7. 保存数组中每个成员的 `buyer_flow_number / ak_amount`，并用当前 `tId` 关联订单。
8. 校验 `SUM(ak_amount) == success`，不一致时记录告警但不阻断扫描。
9. 更新断点为下一个 `tId`。
10. 当 `create_time` 早于目标日期下界时停止。

## Detail_List 分页策略

默认先请求：

```text
p=1&pageSize=15
```

如果返回条数小于 `pageSize`，说明明细已取完。

如果返回条数等于 `pageSize`，需要继续请求下一页，直到：

- 返回空数组
- 返回条数小于 `pageSize`
- 页面签名重复
- 达到安全页数上限

建议单个订单明细页上限：

```text
max_detail_pages_per_trade = 200
```

## 统计口径

订单级统计以 `ak_trade_summary` 为准：

```text
挂卖总数 = SUM(readonly_stock_count)
交易销毁 = SUM(mycancel)
成交量 = SUM(success)
成交价值 = SUM(success_value)
平台差额 = SUM(readonly_stock_count - mycancel - success)
```

买家统计以 `ak_trade_buyers` 为准：

```text
买入明细数 = COUNT(*)
买入数量 = SUM(ak_amount)
唯一买家数 = COUNT(DISTINCT buyer_flow_number)
买家 ID 区间 = MIN/MAX(CAST(buyer_flow_number AS BIGINT))
```

卖家统计以订单详情为准：

```text
唯一卖家数 = COUNT(DISTINCT seller_flow_number)
FlowNumber=0 订单数 = COUNT(*) WHERE seller_flow_number = '0'
```

## 数据校验

每个订单保存后做轻量校验：

```text
buyer_amount_sum = SUM(ak_amount WHERE trade_id = tId)
buyer_amount_sum 应等于 success
```

如果不一致，记录：

```text
trade_id
success
buyer_amount_sum
difference
detail_list_pages
```

不一致的可能原因：

- Detail_List 分页未取全
- 明细接口临时返回不完整
- 上游字段口径变化

## 限速与容错

建议默认：

```text
订单详情请求间隔：1.5 秒
明细分页请求间隔：1.0 ~ 1.5 秒
遇到 403：立即暂停 10 ~ 30 分钟
连续网络错误：指数退避
连续无效 tId：允许继续，达到阈值后暂停人工确认
```

无效 `tId` 不应直接终止，因为订单 ID 可能存在空洞或其他业务记录。

建议阈值：

```text
consecutive_invalid_trade_limit = 100
```

## 与旧脚本的差异

旧脚本主要依赖 `/RPC/Public_ACE` 列表保存记录，会受到 100 页上限和公开列表过滤影响。

新逻辑以 `/RPC/Public_ACE_Detail` 为准：

- 能补到公开列表未展示的 `seller_flow_number=0` 订单。
- 能继续向旧 `tId` 扫描，突破 1500 条限制。
- 统计字段来自真实详情，不再用固定公式替代 `mycancel`。
- 买家明细只保存买家 ID 和买入数量，避免冗余存储。

## 后续实现建议

第一阶段只做离线/后台任务：

- 管理员手动启动扫描。
- 输入起始 `tId`、目标日期、请求间隔。
- 显示进度、已保存订单数、已保存买入明细数、错误数、最近成交时间。
- 支持暂停和继续。

第二阶段再接入管理员面板统计：

- 按日期查看订单统计。
- 查看 `FlowNumber=0` 特殊订单数量。
- 查看买家区间、唯一买家数。
- 导出 CSV。

## 自动采集与管理员看板设计

本节是在前面 `tId` 详情补扫方案上的增强：让系统在普通 `/RPC/Public_ACE` 调用成功后自动感知新订单，并由后台全局单例任务补扫缺口。

### 触发入口

入口仍然是用户正常调用：

```text
GET /RPC/Public_ACE?p=1&pageSize=15&key=...&UserID=...&v=...&lang=cn
```

当代理层确认上游响应成功：

```text
Error=false
Data.List[0].Id 存在
```

取首个订单 ID：

```text
latest_public_trade_id = Data.List[0].Id
```

例如当前验证值：

```text
latest_public_trade_id = 13339050
```

然后与数据库已保存的最大订单 ID 对比：

```text
db_max_trade_id = SELECT MAX(trade_id) FROM ak_trade_summary
```

如果：

```text
latest_public_trade_id > db_max_trade_id
```

则启动或唤醒后台补扫任务，目标区间为：

```text
db_max_trade_id + 1  至  latest_public_trade_id
```

注意：这个触发不能阻塞用户的 `/RPC/Public_ACE` 响应。代理层只负责记录高水位并异步唤醒任务，用户请求仍按原样返回。

### 为什么只看首个 ID 足够

`/RPC/Public_ACE` 首个元素代表公开列表当前最新订单。虽然公开列表会过滤部分 `FlowNumber=0` 订单，但 `tId` 详情接口可直接按连续 ID 查询，所以只要知道最新上界，就能通过区间扫描补齐公开列表没展示的订单。

### 全局单例

采集任务必须是全局单例，避免多个用户同时访问 `/RPC/Public_ACE` 后触发多份扫描。

建议实现：

- 进程内使用 `asyncio.Lock` 或后台 worker 单例避免同进程并发。
- 数据库层使用 `ak_scan_lock` 或 PostgreSQL advisory lock 防止多进程/重启后的并发。
- 如果任务正在运行，新触发只更新目标高水位 `target_trade_id`，不新建任务。

状态表建议：

```text
ak_scan_runtime
```

字段：

```text
scan_name VARCHAR(32) PRIMARY KEY
running BOOLEAN NOT NULL DEFAULT FALSE
current_trade_id INTEGER
target_trade_id INTEGER
last_saved_trade_id INTEGER
last_seen_create_time TIMESTAMP
last_trigger_trade_id INTEGER
last_trigger_at TIMESTAMP
status VARCHAR(24)
last_error VARCHAR(500)
updated_at TIMESTAMP
```

推荐 `scan_name` 固定为：

```text
public_ak_detail_backfill
```

### 扫描方向

增量补扫建议升序：

```text
db_max_trade_id + 1 -> latest_public_trade_id
```

原因：

- 新订单缺口通常较小。
- 升序便于明确任务进度。
- 每个 `tId` 独立 upsert，失败后可从失败点继续。

历史补扫建议降序：

```text
start_trade_id -> old_trade_id
```

原因：

- 从当前最新订单向旧日期补。
- 可用 `create_time < target_date_start` 作为停止条件。

自动触发只负责增量补扫；历史大范围补扫建议作为管理员手动任务。

### 字段类型与空间控制

为了避免表膨胀，字段不使用过大的类型。

订单概要表建议：

```sql
CREATE TABLE ak_trade_summary (
    trade_id INTEGER PRIMARY KEY,
    single_price NUMERIC(6, 4) NOT NULL,
    readonly_stock_count INTEGER NOT NULL CHECK (readonly_stock_count >= 0 AND readonly_stock_count <= 99999),
    mycancel NUMERIC(8, 2) NOT NULL CHECK (mycancel >= 0 AND mycancel <= 999999.99),
    success INTEGER NOT NULL CHECK (success >= 0 AND success <= 99999),
    success_value NUMERIC(12, 4) NOT NULL CHECK (success_value >= 0),
    create_time TIMESTAMP NOT NULL,
    date_key DATE NOT NULL,
    seller_flow_number VARCHAR(12) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

买家明细表建议：

```sql
CREATE TABLE ak_trade_buyers (
    trade_id INTEGER NOT NULL,
    buyer_flow_number VARCHAR(12) NOT NULL,
    ak_amount INTEGER NOT NULL CHECK (ak_amount >= 0 AND ak_amount <= 99999),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

买家明细不保存上游 `Id`、昵称、头像、价格、时间、原始 JSON。

为避免同一订单重扫导致重复，推荐策略是：

```text
保存某个 trade_id 的买家明细前，先 DELETE ak_trade_buyers WHERE trade_id = ?
然后重新插入该订单本次返回的明细
```

这样不依赖上游明细 `Id`，也不需要额外保存它。

### 保留期与自动清理

管理员面板需要提供：

```text
订单概要保留天数
买家明细保留天数
每日汇总保留策略
```

推荐默认：

```text
订单概要：永久或 365 天
买家明细：30 天
每日汇总：永久
```

当管理员调整保留时间时，后端立即执行一次清理：

```text
DELETE FROM ak_trade_buyers
WHERE trade_id IN (
    SELECT trade_id FROM ak_trade_summary
    WHERE create_time < NOW() - interval '<buyer_retention_days> days'
);
```

如果订单概要也设置了保留期：

```text
DELETE FROM ak_trade_summary
WHERE create_time < NOW() - interval '<summary_retention_days> days';
```

清理动作必须：

- 后台执行，不阻塞管理员保存配置。
- 有进度和结果记录。
- 每次批量删除限制行数，避免长事务。

建议批量：

```text
每批 5000 行
批间短暂停顿 50~200ms
```

### 表空间占用

管理员面板需要显示本模块表占用：

```text
ak_trade_summary
ak_trade_buyers
ak_daily_summary
ak_scan_runtime
```

后端可用 PostgreSQL：

```sql
SELECT
    relname,
    pg_total_relation_size(relid) AS total_bytes,
    pg_relation_size(relid) AS table_bytes,
    pg_total_relation_size(relid) - pg_relation_size(relid) AS index_bytes
FROM pg_catalog.pg_statio_user_tables
WHERE relname IN ('ak_trade_summary', 'ak_trade_buyers', 'ak_daily_summary', 'ak_scan_runtime')
ORDER BY pg_total_relation_size(relid) DESC;
```

前端显示：

- 总占用
- 表数据占用
- 索引占用
- 行数估算
- 当前保留策略
- 最近清理时间与清理行数

### 账号池与调用凭据

自动采集可以由任何账号访问 `/RPC/Public_ACE` 触发，但真正补扫时不直接复用触发用户的在线会话，而是从数据库中挑选一个可用账号调用上游 API。

账号选择顺序：

1. 选择不在线账号。
2. 必须有可用 `key/UserID`。
3. 如果 key 失效，切换下一个账号。
4. 切换次数达到管理员配置上限后，使用兜底账号。
5. 兜底账号也失败，则暂停任务并记录错误。

运行中也必须持续检查账号状态：

- 采集任务当前使用的账号如果被用户上线，任务应立即释放该账号。
- 释放后重新从离线账号池选择其他账号继续扫描。
- 这样避免同一账号同时被真实用户和采集任务并发使用，降低触发 403 或上游风控的概率。
- 账号切换不重启任务，只更换调用凭据并从当前 `tId` 继续。

管理员配置项：

```text
自动采集开关
请求间隔秒数
账号切换最大次数
兜底账号
遇到 403 暂停分钟数
连续失败暂停分钟数
买家明细保留天数
订单概要保留天数
是否保存买家明细
```

兜底账号配置建议只保存账号标识，不在普通配置里明文展示密码。

不在线账号判断：

```text
优先排除当前 IM/网页在线用户
优先排除 active_login_device_id 仍活跃的账号
优先选择最近未被使用的账号
```

账号选择需要记录：

```text
account_username
used_at
success/failure
failure_reason
```

日志中不输出完整 key。

### 账号租约与上线抢占

采集任务使用账号时，应视为拿到一个短期租约，而不是永久绑定。

建议运行时状态：

```text
current_account_username
current_account_user_id
current_account_key_tail
account_lease_started_at
account_last_checked_at
account_switch_count
```

每次调用上游 API 前，或每隔固定时间，检查当前账号是否仍然离线：

```text
account_online_check_interval_seconds = 10
```

如果检测到：

```text
当前采集账号已上线
```

则处理：

1. 当前账号立即停止用于采集。
2. 记录切换原因 `account_came_online`。
3. 从离线账号池选择下一个账号。
4. 如果没有离线账号，尝试兜底账号。
5. 如果兜底账号也在线或不可用，任务暂停，等待下一轮触发。

这里的“上线”判断应尽量复用现有在线用户/浏览器会话数据，例如：

```text
在线用户表
active_login_device_id
active_login_updated_at
最近页面心跳
```

为了避免误判，建议给在线状态一个短 TTL：

```text
online_ttl_seconds = 120
```

只要该账号在 TTL 内有活跃会话，就认为在线，不给采集任务使用。

兜底账号也应遵守同样规则。只有管理员明确开启“兜底账号允许在线使用”时，才允许兜底账号在线时仍被采集任务使用；默认不允许。

### key 失效处理

当接口返回：

```text
Error=true
Msg 包含重新登录、key 无效、用户未登录等
```

判定当前账号 key 失效。

处理：

1. 标记该账号本轮不可用。
2. 切换下一个离线账号。
3. 如果切换次数超过配置，尝试兜底账号。
4. 所有账号失败则任务进入 `paused`，等待下一次触发或管理员处理。

不建议在采集任务里自动用明文密码重新登录，除非后续确认密码保存与权限边界。

### 看板设计

管理员面板新增 AK 数据看板。

首页展示当天核心指标：

```text
订单数
挂卖总数
交易销毁
成交量
成交价值
平台差额
唯一卖家数
唯一买家数
FlowNumber=0 订单数
最近订单 ID
最近成交时间
采集任务状态
```

交互能力：

- 日期选择器：查看任意一天。
- 日期范围选择：查看周/月/自定义范围。
- 点击指标卡切换图表。
- 点击异常指标查看明细，例如 `FlowNumber=0` 订单。

ECharts 图表建议：

```text
成交量趋势折线图
成交价值趋势折线图
订单数柱状图
交易销毁/平台差额堆叠柱状图
买家数量与卖家数量趋势
价格分布饼图或柱状图
FlowNumber=0 订单占比
```

历史数据交互：

- 日粒度汇总从 `ak_daily_summary` 读取，避免每次扫明细表。
- 单日详情从 `ak_trade_summary` 和 `ak_trade_buyers` 查询。
- 默认只加载最近 30 天，按需加载更早数据。

### 每日汇总表

为了看板快速加载，扫描完成或定时任务应维护日汇总。

建议表：

```sql
CREATE TABLE ak_daily_summary (
    date_key DATE PRIMARY KEY,
    order_count INTEGER NOT NULL DEFAULT 0,
    total_stock INTEGER NOT NULL DEFAULT 0,
    total_mycancel NUMERIC(12, 2) NOT NULL DEFAULT 0,
    total_success INTEGER NOT NULL DEFAULT 0,
    total_success_value NUMERIC(14, 4) NOT NULL DEFAULT 0,
    platform_gap NUMERIC(12, 2) NOT NULL DEFAULT 0,
    unique_seller_count INTEGER NOT NULL DEFAULT 0,
    unique_buyer_count INTEGER NOT NULL DEFAULT 0,
    zero_seller_order_count INTEGER NOT NULL DEFAULT 0,
    min_trade_id INTEGER,
    max_trade_id INTEGER,
    first_trade_time TIMESTAMP,
    last_trade_time TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

看板默认读这个表，只有用户查看具体日期明细时再查明细表。

### 性能与风险点

可能的问题：

1. 触发频繁：很多用户访问 `/RPC/Public_ACE` 会频繁触发检查。
   - 解决：只做轻量高水位对比；后台任务运行中只更新目标高水位。

2. 扫描任务与用户请求互相影响。
   - 解决：采集任务独立限速、后台执行，不占用用户请求链路。

3. 买家明细膨胀。
   - 解决：买家明细保留期、每日汇总长期保存。

4. 账号在线状态被采集任务干扰。
   - 解决：优先使用离线账号；运行中发现当前账号上线就切换；兜底账号独立配置且默认也不抢在线账号。

5. 多进程重复扫描。
   - 解决：进程锁 + 数据库锁 + upsert。

6. Public_ACE 首个 ID 与详情扫描之间出现新订单。
   - 解决：下一次用户调用会再次提高目标高水位；任务运行中也允许更新 `target_trade_id`。

7. 详情接口短时失败导致缺单。
   - 解决：失败 `tId` 记录到重试队列，不因单个失败跳过永久丢失。

### 推荐落地顺序

1. 建表：订单概要、买家明细、每日汇总、扫描运行状态。
2. 实现 `tId` 单订单抓取与保存，含 Detail_List 分页。
3. 实现全局单例扫描器。
4. 在 `/RPC/Public_ACE` 成功响应后触发高水位检查。
5. 实现管理员配置：开关、间隔、账号切换次数、兜底账号、保留期。
6. 实现表占用和清理。
7. 实现当日看板和历史查询。
8. 最后再做手动历史补扫入口。
