# ACE 数据采集与看板设计

日期：2026-06-17

## 目标

建设一个独立的 ACE 数据模块，用于持续采集 `/RPC/Public_ACE_Detail` 与 `/RPC/Public_ACE_Detail_List` 的订单详情和买家明细，并在管理员面板中展示当日和历史统计。

模块目标：

- 绕开 `/RPC/Public_ACE` 只能稳定翻到约 100 页、1500 条左右的限制。
- 以连续 `tId` 详情扫描为主，`/RPC/Public_ACE` 只用于发现最新订单 ID。
- 只保存业务统计需要的字段，控制数据库膨胀。
- 采集任务全局单例，避免多用户访问时重复扫。
- 使用离线账号或兜底账号调用上游，尽量不干扰真实在线用户。
- 管理员面板可看采集进度、数据占用、保留期配置、当日和历史看板。
- 一次性历史回填作为临时功能，完成后可以剥离。

## 模块边界

建议新增独立目录：

```text
public_admin/server/ace_data/
public_admin/frontend/pages/ace_data/
```

后端职责：

- 数据表迁移和初始化。
- 单订单抓取与保存。
- 全局扫描任务。
- 账号租约和切换。
- 保留期清理。
- 看板查询 API。

前端职责：

- 采集状态展示。
- 配置项编辑。
- 手动触发回填。
- 表占用查看。
- ECharts 数据看板。

不建议放进现有 `point_stats`，因为 ACE 是市场订单数据，不是账号点数流水；两者查询、采集、保留策略都不同。

## 数据来源

### 发现最新订单

接口：

```text
/RPC/Public_ACE?p=1&pageSize=15&key=...&UserID=...&v=...&lang=cn
```

只读取：

```text
Data[0].Id 或 Data.List[0].Id
```

当最新订单 ID 大于数据库最大 `trade_id` 时，唤醒后台增量任务。

### 订单详情

接口：

```text
/RPC/Public_ACE_Detail?tId=<trade_id>&key=...&UserID=...&v=...&lang=cn
```

只保存用户标注过的业务字段：

| 字段 | 来源 | 类型建议 | 说明 |
| --- | --- | --- | --- |
| trade_id | 请求参数 `tId` | INTEGER | 内部主键，必须保存 |
| single_price | `Data.SinglePrice` | NUMERIC(4,3) | 成交价，三位小数，最高 0.400 |
| readonly_stock_count | `Data.ReadonlyStockCount` | INTEGER | 挂卖总数，最大约五位整数 |
| mycancel | `Data.mycancel` | INTEGER | 交易销毁，不应超过挂卖总数 |
| success | `Data.success` | INTEGER | 成交量 |
| success_value | `Data.successvalue` | NUMERIC(7,2) | 成交价值，两位小数，按 99999 * 0.400 预留 |
| create_time | `Data.CreateTime` | TIMESTAMP | 成交时间 |
| seller_flow_number | `Data.User.FlowNumber` | VARCHAR(12) | 卖家 ID |

不保存原始 JSON，不保存头像、昵称、上游明细 ID、展示字段。

### 买家明细

接口：

```text
/RPC/Public_ACE_Detail_List?p=<page>&pageSize=15&tId=<trade_id>&uId=<seller_user_id>&key=...&UserID=...&v=...&lang=cn
```

`uId` 只从订单详情的 `Data.User.Id` 临时取得，用于请求，不入业务表。

只保存：

| 字段 | 来源 | 类型建议 | 说明 |
| --- | --- | --- | --- |
| trade_id | 请求参数 `tId` | INTEGER | 关联订单 |
| buyer_flow_number | `User.FlowNumber` | VARCHAR(12) | 买家 ID |
| ace_amount | `AceAmount` | INTEGER | 买入数量 |

买家明细保存策略：

```text
同一个 trade_id 重抓时，先删除旧明细，再插入本次完整明细。
```

这样不依赖上游明细 `Id`，也避免重复插入。

## 数据表设计

### ace_trade_summary

```sql
CREATE TABLE ace_trade_summary (
    trade_id INTEGER PRIMARY KEY,
    single_price NUMERIC(4, 3) NOT NULL CHECK (single_price >= 0 AND single_price <= 0.400),
    readonly_stock_count INTEGER NOT NULL CHECK (readonly_stock_count >= 0 AND readonly_stock_count <= 99999),
    mycancel INTEGER NOT NULL CHECK (mycancel >= 0 AND mycancel <= readonly_stock_count),
    success INTEGER NOT NULL CHECK (success >= 0 AND success <= readonly_stock_count),
    success_value NUMERIC(7, 2) NOT NULL CHECK (success_value >= 0),
    create_time TIMESTAMP NOT NULL,
    date_key DATE NOT NULL,
    seller_flow_number VARCHAR(12) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

索引：

```sql
CREATE INDEX idx_ace_trade_summary_date ON ace_trade_summary(date_key);
CREATE INDEX idx_ace_trade_summary_time ON ace_trade_summary(create_time);
CREATE INDEX idx_ace_trade_summary_seller ON ace_trade_summary(seller_flow_number);
```

### ace_trade_buyers

```sql
CREATE TABLE ace_trade_buyers (
    trade_id INTEGER NOT NULL REFERENCES ace_trade_summary(trade_id) ON DELETE CASCADE,
    buyer_flow_number VARCHAR(12) NOT NULL,
    ace_amount INTEGER NOT NULL CHECK (ace_amount >= 0 AND ace_amount <= 99999),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

索引：

```sql
CREATE INDEX idx_ace_trade_buyers_trade ON ace_trade_buyers(trade_id);
CREATE INDEX idx_ace_trade_buyers_flow ON ace_trade_buyers(buyer_flow_number);
```

### 字段容量校准

单笔订单以 `readonly_stock_count` 为上限。既然挂卖总数按最大五位整数设计，则同一笔订单内：

```text
mycancel <= readonly_stock_count
success <= readonly_stock_count
单个买家 ace_amount <= readonly_stock_count
```

因此单笔数量类字段不需要超过五位整数。

所有数值字段都不允许为负数，建表时统一加 `CHECK (字段 >= 0)` 或更严格的上限约束。

| 字段 | 类型 | 容量 |
| --- | --- | ---: |
| readonly_stock_count | INTEGER + CHECK <= 99999 | 5 位整数 |
| mycancel | INTEGER + CHECK <= readonly_stock_count | 5 位整数 |
| success | INTEGER + CHECK <= readonly_stock_count | 5 位整数 |
| ace_amount | INTEGER + CHECK <= 99999 | 5 位整数 |
| single_price | NUMERIC(4,3) + CHECK <= 0.400 | 1 位整数 + 3 位小数 |
| success_value | NUMERIC(7,2) | 5 位整数 + 2 位小数 |

`success_value` 单独按价格乘数量估算，成交价三位小数且最高为 `0.400`：

```text
99999 * 0.400 = 39,999.60
```

所以 `NUMERIC(7,2)` 足够覆盖当前设计的最大单笔成交价值。

日汇总字段是多笔订单累加，不受单笔五位限制，因此可以比单笔字段大。日汇总表只有每天一行，适当放大不会造成明显存储压力。

### ace_daily_summary

看板默认读日汇总表，避免每次扫明细大表。

```sql
CREATE TABLE ace_daily_summary (
    date_key DATE PRIMARY KEY,
    order_count INTEGER NOT NULL DEFAULT 0 CHECK (order_count >= 0),
    total_stock BIGINT NOT NULL DEFAULT 0 CHECK (total_stock >= 0),
    total_mycancel BIGINT NOT NULL DEFAULT 0 CHECK (total_mycancel >= 0),
    total_success BIGINT NOT NULL DEFAULT 0 CHECK (total_success >= 0),
    total_success_value NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (total_success_value >= 0),
    platform_gap BIGINT NOT NULL DEFAULT 0 CHECK (platform_gap >= 0),
    unique_seller_count INTEGER NOT NULL DEFAULT 0 CHECK (unique_seller_count >= 0),
    unique_buyer_count INTEGER NOT NULL DEFAULT 0 CHECK (unique_buyer_count >= 0),
    zero_seller_order_count INTEGER NOT NULL DEFAULT 0 CHECK (zero_seller_order_count >= 0),
    min_trade_id INTEGER,
    max_trade_id INTEGER,
    first_trade_time TIMESTAMP,
    last_trade_time TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### ace_scan_runtime

```sql
CREATE TABLE ace_scan_runtime (
    scan_name VARCHAR(64) PRIMARY KEY,
    running BOOLEAN NOT NULL DEFAULT FALSE,
    direction VARCHAR(16) NOT NULL DEFAULT 'forward',
    current_trade_id INTEGER,
    target_trade_id INTEGER,
    last_saved_trade_id INTEGER,
    last_seen_create_time TIMESTAMP,
    last_trigger_trade_id INTEGER,
    current_account_username VARCHAR(64),
    account_switch_count INTEGER NOT NULL DEFAULT 0,
    next_check_at TIMESTAMP,
    last_check_skipped_at TIMESTAMP,
    last_check_skip_reason VARCHAR(100),
    status VARCHAR(24) NOT NULL DEFAULT 'idle',
    last_error VARCHAR(500),
    started_at TIMESTAMP,
    finished_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### ace_data_config

```sql
CREATE TABLE ace_data_config (
    config_key VARCHAR(64) PRIMARY KEY,
    config_value TEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

推荐配置项：

| 配置项 | 默认值 | 说明 |
| --- | ---: | --- |
| enabled | true | 是否自动采集 |
| request_interval_ms | 1500 | 单请求间隔 |
| max_account_switches | 5 | 单轮最大账号切换次数 |
| fallback_username | 空 | 兜底账号 |
| pause_minutes_on_403 | 30 | 遇到 403 暂停时间 |
| online_ttl_seconds | 120 | 判断账号在线的 TTL |
| summary_retention_days | 365 | 订单概要保留天数 |
| buyer_retention_days | 30 | 买家明细保留天数 |
| keep_buyer_details | true | 是否保存买家明细 |
| max_detail_pages_per_trade | 200 | 单订单买家明细最大页数 |
| post_task_check_interval_minutes | 60 | 任务结束后再次判断高水位的最小间隔 |

## 采集流程

### 自动增量

1. 用户正常访问 `/RPC/Public_ACE`。
2. 代理层从成功响应中读取最新订单 ID。
3. 对比 `SELECT MAX(trade_id) FROM ace_trade_summary`。
4. 如果最新 ID 更大，只记录高水位并异步唤醒采集任务。
5. 用户请求不等待采集任务，照常返回。
6. 采集任务全局单例，从 `db_max_trade_id + 1` 扫到 `latest_trade_id`。

任务运行中如果又发现更高 ID，只更新 `target_trade_id`，不新开任务。

### 触发节流

为了避免用户频繁访问 `/RPC/Public_ACE` 时反复做无意义判断，自动增量触发需要增加任务结束后的检查间隔。

规则：

```text
scan task finished_at + post_task_check_interval_minutes > now
```

如果仍在间隔内：

- 不读取数据库最大 `trade_id`。
- 不解析或对比最新高水位。
- 不唤醒采集任务。
- 用户原始 `/RPC/Public_ACE` 响应照常返回。

如果间隔已到：

- 才读取 `/RPC/Public_ACE` 首个订单 ID。
- 才对比数据库最大 `trade_id`。
- 有缺口时再唤醒后台任务。

默认间隔建议为：

```text
60 分钟
```

管理员面板提供配置项：

```text
任务结束后检查间隔（分钟）
```

允许范围建议：

```text
5 ~ 1440 分钟
```

运行状态表中建议增加：

```text
next_check_at TIMESTAMP
last_check_skipped_at TIMESTAMP
last_check_skip_reason VARCHAR(100)
```

任务结束时写入：

```text
next_check_at = finished_at + post_task_check_interval_minutes
```

这样即使很多用户持续打开 AK 交易页，也不会每次都触发数据库高水位判断。

### 单订单处理

1. 调用 `Public_ACE_Detail`。
2. 解析并 upsert `ace_trade_summary`。
3. 如果开启买家明细，取详情里的临时 `Data.User.Id` 调 `Public_ACE_Detail_List`。
4. 分页抓取买家明细，直到空页、少于 pageSize、重复页签名或超过上限。
5. 删除该 `trade_id` 旧明细，插入本次明细。
6. 校验 `SUM(ace_amount)` 与 `success`，不一致只记录警告，不阻断任务。
7. 更新 `ace_daily_summary`。

### 历史回填

一次性回填用于从当前最新订单向历史扫描到 2026-05-29，前端按钮触发。

建议做成临时任务：

- 管理员面板显示进度。
- 输入起始订单 ID、目标日期、请求间隔。
- 扫描完成后按钮可隐藏或代码后续剥离。
- 回填默认从 2026-06-01 起作为看板基础数据，5 月 29 日只是扫描下界缓冲，防止跨日边界遗漏。

## 账号租约设计

采集任务不直接复用触发用户的在线 key，而是从数据库挑选账号。

选择顺序：

1. 排除在线账号。
2. 排除最近 TTL 内活跃的账号。
3. 选择有可用 `key/UserID` 的账号。
4. 优先选择最近未被采集使用的账号。
5. key 失效则切换下一个。
6. 超过切换次数后尝试兜底账号。
7. 兜底账号默认也不允许抢占在线态，除非后续单独加开关。

每次请求前或每隔 10 秒检查当前账号是否上线。如果上线，立即释放租约并切换账号，避免和真实用户并发导致 403。

账号日志只记录：

```text
username
key_tail
used_at
success/failure
failure_reason
```

不记录完整 key。

## 管理员面板设计

新增模块名建议：

```text
ACE 数据看板
```

### 顶部状态区

显示：

- 自动采集开关。
- 当前最新订单 ID。
- 数据库最大订单 ID。
- 待补订单数。
- 任务状态：空闲、运行、暂停、错误。
- 当前账号：只显示账号名和 key 尾号。
- 最近错误。
- 最近同步时间。

### 配置区

字段：

- 请求间隔。
- 最大账号切换次数。
- 403 暂停分钟数。
- 兜底账号。
- 订单概要保留天数。
- 买家明细保留天数。
- 是否保存买家明细。
- 单订单买家明细最大页数。

保存配置后：

- 后端校验范围。
- 对超过保留期的数据启动后台清理。
- 清理进度显示在状态区。

### 数据占用区

显示表：

- `ace_trade_summary`
- `ace_trade_buyers`
- `ace_daily_summary`
- `ace_scan_runtime`

指标：

- 总占用。
- 表数据占用。
- 索引占用。
- 估算行数。
- 最近清理时间。
- 最近清理行数。

### 回填区

按钮：

- 检查缺口。
- 启动一次性历史回填。
- 暂停。
- 继续。

显示：

- 当前 tId。
- 目标 tId 或目标日期。
- 已保存订单数。
- 已保存买家明细数。
- 失败数。
- 当前账号。
- 预计剩余。

### 看板区

默认展示当天：

- 订单数。
- 挂卖总数。
- 交易销毁。
- 成交量。
- 成交价值。
- 平台差额：`readonly_stock_count - mycancel - success`。
- 唯一卖家数。
- 唯一买家数。
- `FlowNumber=0` 订单数。
- 最近订单 ID。
- 最近成交时间。

图表：

- 成交量趋势。
- 成交价值趋势。
- 订单数趋势。
- 交易销毁与平台差额堆叠柱状图。
- 买家数/卖家数趋势。
- `FlowNumber=0` 订单占比。

默认读 `ace_daily_summary`，点击某天再查明细表。

### 订单查询区

管理员面板需要提供通过订单 ID 精确查询订单的功能。

输入：

```text
trade_id
```

交互：

- 输入订单 ID 后点击查询。
- 先查本地数据库。
- 如果本地不存在，提示“本地未采集”，并提供“立即从上游抓取该订单”按钮。
- 如果本地存在，展示订单概要和买家明细。
- 如果买家明细因保留期已清理，展示“买家明细已过保留期清理”，并可按权限重新从上游拉取。

展示字段：

```text
订单 ID
成交时间
卖家 ID
成交价
挂卖总数
交易销毁
成交量
成交价值
平台差额
买家明细条数
买家买入数量合计
买家明细校验状态
```

买家明细表：

```text
买家 ID
买入数量
```

诊断信息：

- 本地是否存在。
- 最近采集时间。
- 最近更新/重抓时间。
- 买家明细是否完整。
- `SUM(ace_amount)` 是否等于 `success`。
- 如果不一致，显示差额。
- 如果上游查询失败，显示脱敏后的错误原因。

权限：

- 总管理员可以触发“立即从上游抓取该订单”。
- 子管理员默认只允许查询本地数据，不允许主动打上游。

这个功能用于单订单核验，不参与自动扫描队列，避免管理员查询时影响全局采集进度。立即抓取成功后仍走同一套保存逻辑，保证数据格式一致。

## API 设计

```text
GET  /admin/api/ace-data/status
GET  /admin/api/ace-data/config
POST /admin/api/ace-data/config
GET  /admin/api/ace-data/storage
POST /admin/api/ace-data/cleanup
POST /admin/api/ace-data/backfill/start
POST /admin/api/ace-data/backfill/pause
POST /admin/api/ace-data/backfill/resume
GET  /admin/api/ace-data/backfill/status
GET  /admin/api/ace-data/dashboard?start_date=&end_date=
GET  /admin/api/ace-data/trades?date=&page=&page_size=
GET  /admin/api/ace-data/trades/{trade_id}/buyers
GET  /admin/api/ace-data/trades/{trade_id}
POST /admin/api/ace-data/trades/{trade_id}/fetch
```

权限：

- 总管理员可修改配置、启动历史回填、清理数据。
- 子管理员默认只读，除非后续单独授权。
- 所有写接口都走现有管理员鉴权。

## 空间估算

粗略估算：

- `ace_trade_summary` 每行约 120 到 180 字节，加索引按 250 到 350 字节估。
- `ace_trade_buyers` 每行约 50 到 90 字节，加索引按 120 到 180 字节估。

如果每天订单 1000 条、每单平均 5 条买家明细：

```text
summary: 1000 * 350B ≈ 0.35MB/天
buyers: 5000 * 180B ≈ 0.9MB/天
合计约 1.25MB/天
```

1GB 大约可保存：

```text
约 800 天以上的上述规模数据
```

如果买家明细平均 15 条，则可能接近：

```text
约 3MB/天，1GB 约 300 天
```

所以建议：

- 日汇总永久保存。
- 订单概要保留 365 天。
- 买家明细默认 30 天，可配置。

## 风险与处理

| 风险 | 处理 |
| --- | --- |
| 上游 403 | 限速、账号切换、暂停任务 |
| key 失效 | 标记账号本轮不可用，切换账号 |
| 多进程重复扫 | 进程锁 + PostgreSQL advisory lock |
| 明细分页不完整 | 页签名去重、页数上限、校验记录警告 |
| 订单 ID 不连续 | 无效 tId 不立即终止，连续无效达到阈值再暂停 |
| 表膨胀 | 保留期清理 + 日汇总表 |
| 用户在线被采集干扰 | 账号租约前后检查在线态 |

## 推荐落地顺序

第一阶段：后端基础

1. 建表与配置。
2. 单订单抓取保存。
3. Detail_List 分页保存。
4. 日汇总维护。

第二阶段：任务系统

1. 全局单例扫描器。
2. 账号租约。
3. `/RPC/Public_ACE` 高水位触发。
4. 任务状态 API。

第三阶段：管理员面板

1. 状态区和配置区。
2. 表占用区。
3. 当日看板。
4. 历史日期查询。

第四阶段：一次性回填

1. 回填按钮。
2. 进度显示。
3. 暂停/继续。
4. 完成后隐藏或剥离临时入口。

## 需要确认

1. 订单概要默认保留 365 天是否合适。
2. 买家明细默认保留 30 天是否合适。
3. 兜底账号是否允许在线时被采集任务使用，建议默认不允许。
4. 一次性回填目标是否确定为扫到 2026-05-29，统计基础从 2026-06-01 开始。
5. 子管理员是否只读 ACE 看板，建议第一版只允许总管理员配置和回填。
