(function() {
    if (window.AKDataRenderer) return;

    function html(value) {
        if (typeof window.escapeHtml === 'function') return window.escapeHtml(value == null ? '' : String(value));
        return String(value == null ? '' : value).replace(/[&<>'"]/g, function(ch) {
            return {'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[ch];
        });
    }

    function number(value, digits) {
        var num = Number(value || 0);
        return num.toLocaleString('zh-CN', {
            minimumFractionDigits: digits || 0,
            maximumFractionDigits: digits || 0
        });
    }

    function money(value) {
        return number(value, 2);
    }

    function price(value) {
        return Number(value || 0).toFixed(3);
    }

    function time(value) {
        if (!value) return '-';
        return String(value).replace('T', ' ').slice(0, 19);
    }

    function pad(value) {
        var text = String(value);
        return text.length >= 2 ? text : '0' + text;
    }

    function localTimeFromSeconds(seconds) {
        var ts = Number(seconds || 0);
        if (!ts) return '-';
        var date = new Date(ts * 1000);
        if (isNaN(date.getTime())) return '-';
        return [
            date.getFullYear(),
            '-',
            pad(date.getMonth() + 1),
            '-',
            pad(date.getDate()),
            ' ',
            pad(date.getHours()),
            ':',
            pad(date.getMinutes()),
            ':',
            pad(date.getSeconds())
        ].join('');
    }

    function cooldownText(seconds, remainingSeconds) {
        var ts = Number(seconds || 0);
        if (!ts) return '';
        var remaining = remainingSeconds == null ? Math.max(0, Math.ceil(ts - Date.now() / 1000)) : Math.max(0, Number(remainingSeconds || 0));
        return '冷却剩余：' + number(remaining) + ' 秒，至 ' + localTimeFromSeconds(ts);
    }

    function bytes(value) {
        var size = Number(value || 0);
        if (size >= 1024 * 1024 * 1024) return (size / 1024 / 1024 / 1024).toFixed(2) + ' GB';
        if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(2) + ' MB';
        if (size >= 1024) return (size / 1024).toFixed(1) + ' KB';
        return size + ' B';
    }

    function dayText(value) {
        return String(value || '').slice(5) || '-';
    }

    function sum(rows, key) {
        return (rows || []).reduce(function(total, row) {
            return total + Number(row && row[key] || 0);
        }, 0);
    }

    function latestStatus(state) {
        var s = state.status || {};
        var runtime = s.runtime || {};
        var running = runtime.running || runtime.status === 'running';
        return running ? '采集中' : (s.ready ? '空闲' : '待初始化');
    }

    function metric(label, value, note, tone) {
        return '<div class="akd-metric ' + (tone || '') + '"><span>' + html(label) + '</span><b>' + html(value) + '</b><em>' + html(note || '') + '</em></div>';
    }

    function renderMetrics(state) {
        var s = state.status || {};
        return [
            metric('当前状态', latestStatus(state), s.last_trade_time ? '最近 ' + time(s.last_trade_time) : '暂无采集数据', s.ready ? 'ok' : ''),
            metric('最新订单 ID', number(s.latest_trade_id), '由采集状态或本地最大 ID 推断', 'cyan'),
            metric('本地最大 ID', number(s.local_max_trade_id), Number(s.pending_count || 0) > 0 ? '待补 ' + number(s.pending_count) + ' 笔' : '已追平', 'green'),
            metric('数据库最早 ID', number(s.local_min_trade_id), s.first_trade_time ? '起始 ' + time(s.first_trade_time) : '等待数据', '')
        ].join('');
    }

    function renderStorage(state) {
        var rows = state.storage || [];
        if (!rows.length) return '<div class="akd-empty">暂无表占用数据</div>';
        return rows.map(function(row) {
            return '<div class="akd-storage-row"><span>' + html(row.table_name) + '</span><b>' + bytes(row.total_bytes) + '</b><em>' + number(row.rows) + ' 行</em></div>';
        }).join('');
    }

    function renderConfig(state) {
        var cfg = state.config || {};
        return [
            '<div class="akd-config-grid">',
            '<label><span>启用采集</span><button class="akd-switch ' + (cfg.enabled ? 'is-on' : '') + '" data-action="toggle-config" data-key="enabled" type="button"><i></i><em>' + (cfg.enabled ? '启用' : '关闭') + '</em></button></label>',
            '<label><span>请求间隔（毫秒）</span><input id="akDataConfigRequestInterval" type="number" min="300" max="10000" value="' + html(cfg.request_interval_ms || 1000) + '"></label>',
            '<label><span>最大切号次数</span><input id="akDataConfigMaxSwitch" type="number" min="0" max="50" value="' + html(cfg.max_account_switches || 5) + '"></label>',
            '<label><span>兜底账号</span><input id="akDataConfigFallback" type="text" value="' + html(cfg.fallback_username || '') + '" placeholder="留空表示自动选择"></label>',
            '<label><span>挂卖数据保留天数</span><input id="akDataConfigSummaryRetention" type="number" min="1" max="3650" value="' + html(cfg.summary_retention_days || 365) + '"></label>',
            '<label><span>买家数据保留天数</span><input id="akDataConfigBuyerRetention" type="number" min="1" max="3650" value="' + html(cfg.buyer_retention_days || 30) + '"></label>',
            '<label><span>任务后检查间隔（分钟）</span><input id="akDataConfigCheckInterval" type="number" min="1" max="1440" value="' + html(cfg.post_task_check_interval_minutes || 60) + '"></label>',
            '<label><span>403 冷却（秒）</span><input id="akDataConfigForbiddenCooldown" type="number" min="0" max="86400" value="' + html(cfg.forbidden_cooldown_seconds || 300) + '"></label>',
            '<label><span>最大重试轮次</span><input id="akDataConfigRetryRounds" type="number" min="1" max="50" value="' + html(cfg.retry_rounds || 10) + '"></label>',
            '<label><span>流水线并发</span><input id="akDataConfigPipelineConcurrency" type="number" min="1" max="5" value="' + html(cfg.pipeline_concurrency || 2) + '"></label>',
            '<label><span>买家明细开关</span><button class="akd-switch ' + (cfg.save_buyers ? 'is-on' : '') + '" data-action="toggle-config" data-key="save_buyers" type="button"><i></i><em>' + (cfg.save_buyers ? '保存' : '不保存') + '</em></button></label>',
            '<label><span>买家分页大小</span><input id="akDataConfigBuyerPageSize" type="number" min="1" max="100" value="' + html(cfg.buyer_page_size || 15) + '"></label>',
            '<label><span>买家最大页数</span><input id="akDataConfigBuyerMaxPages" type="number" min="1" max="200" value="' + html(cfg.buyer_max_pages || 20) + '"></label>',
            '<label><span>默认目标日期</span><input id="akDataConfigTargetDate" type="date" value="' + html(cfg.default_target_date || '2026-05-29') + '"></label>',
            '<label><span>基础统计起始日</span><input id="akDataConfigBaseDate" type="date" value="' + html(cfg.base_stat_date || '2026-06-01') + '"></label>',
            '<label><span>上游超时（秒）</span><input id="akDataConfigTimeout" type="number" min="3" max="60" value="' + html(cfg.upstream_timeout_seconds || 12) + '"></label>',
            '</div>',
            '<div class="akd-config-actions"><button class="akd-btn primary" data-action="save-config">保存配置</button><button class="akd-btn ghost" data-action="cleanup">清理过期数据</button></div>'
        ].join('');
    }

    function renderBackfill(state) {
        var bf = state.backfill || {};
        var runtime = state.status && state.status.runtime || {};
        var running = bf.status === 'running';
        return [
            '<div class="akd-backfill">',
            '<div class="akd-backfill-head"><h3>历史回填</h3><span>' + html(bf.message || '未启动') + '</span></div>',
            '<div class="akd-backfill-grid">',
            '<label><span>起始订单 ID</span><input id="akDataBackfillStartId" type="number" min="1" value="' + html(bf.current_trade_id || runtime.current_trade_id || bf.start_trade_id || state.status && state.status.local_max_trade_id || 0) + '"></label>',
            '<label><span>目标日期</span><input id="akDataBackfillTargetDate" type="date" value="' + html(bf.target_date || (state.config && state.config.default_target_date) || '2026-05-29') + '"></label>',
            '<label><span>请求间隔（毫秒）</span><input id="akDataBackfillInterval" type="number" min="300" max="10000" value="' + html(bf.request_interval_ms || (state.config && state.config.request_interval_ms) || 1000) + '"></label>',
            '<label><span>探测 300 笔</span><input id="akDataProbeLimit" type="number" min="1" max="1000" value="300"></label>',
            '</div>',
            '<div class="akd-backfill-actions">' +
                '<button class="akd-btn primary" data-action="start-backfill"' + (running ? ' disabled' : '') + '>开始回填</button>' +
                '<button class="akd-btn ghost" data-action="pause-backfill"' + (!running ? ' disabled' : '') + '>暂停</button>' +
                '<button class="akd-btn ghost" data-action="start-probe"' + (running ? ' disabled' : '') + '>限流探测</button>' +
            '</div>',
            '<div class="akd-backfill-status">' +
                '<span>状态：' + html(bf.status || 'idle') + '</span>' +
                '<span>当前 ID：' + number(bf.current_trade_id || 0) + '</span>' +
                '<span>数据库最早 ID：' + number(bf.local_min_trade_id || (state.status && state.status.local_min_trade_id) || 0) + '</span>' +
                '<span>已保存：' + number(bf.saved || 0) + '</span>' +
                '<span>买家明细：' + number(bf.buyer_rows || 0) + '</span>' +
                '<span>403 次数：' + number(bf.forbidden || 0) + '</span>' +
                '<span>重试轮次：' + number(bf.retry_round || 0) + '/' + number(bf.retry_rounds || 0) + '</span>' +
                '<span>待补订单：' + number(bf.pending_count || 0) + '</span>' +
                '<span>当前采集日：' + html(bf.current_day || '-') + '</span>' +
                '<span>当日缓存：' + number(bf.day_buffer_count || 0) + '</span>' +
                '<span>已提交天数：' + number(bf.committed_days || 0) + '</span>' +
                (bf.current_account ? '<span>当前账号：' + html(bf.current_account) + '</span>' : '') +
                '<span>切号次数：' + number(bf.account_switch_count || 0) + '</span>' +
                (bf.last_error ? '<span title="' + html(bf.last_error) + '">最近错误：' + html(String(bf.last_error).slice(0, 36)) + '</span>' : '') +
                (bf.cooldown_until ? '<span>' + html(cooldownText(bf.cooldown_until, bf.cooldown_remaining_seconds)) + '</span>' : '') +
            '</div>',
            '</div>'
        ].join('');
    }

    function renderDashboardBars(state) {
        var rows = state.dashboard || [];
        if (!rows.length) return '<div class="akd-chart-empty">暂无统计数据</div>';
        var maxVolume = Math.max(1, Math.max.apply(null, rows.map(function(row) {
            return Number(row.total_success || 0) + Number(row.total_mycancel || 0) + Number(row.platform_gap || 0);
        })));
        return '<div class="akd-bars">' + rows.map(function(row) {
            var success = Number(row.total_success || 0);
            var burn = Number(row.total_mycancel || 0);
            var fee = Number(row.platform_gap || 0);
            var total = Math.max(1, success + burn + fee);
            var height = Math.max(10, Math.round(total / maxVolume * 138));
            return '<button class="akd-bar" type="button" title="挂卖量 ' + number(row.total_stock) + '，成交量 ' + number(success) + '，交易销毁 ' + number(burn) + '，手续费扣除 ' + number(fee) + '">' +
                '<span class="akd-bar-stack" style="height:' + height + 'px">' +
                '<i class="success" style="height:' + Math.max(3, success / total * 100) + '%"></i>' +
                '<i class="burn" style="height:' + Math.max(3, burn / total * 100) + '%"></i>' +
                '<i class="fee" style="height:' + Math.max(3, fee / total * 100) + '%"></i>' +
                '</span><em>' + html(dayText(row.date_key)) + '</em></button>';
        }).join('') + '</div>';
    }

    function renderDealStats(state) {
        var rows = state.dashboard || [];
        var value = sum(rows, 'total_success_value');
        var success = sum(rows, 'total_success');
        var avg = success > 0 ? value / success : 0;
        return [
            '<div class="akd-deal-stat"><span>成交价值</span><b>' + money(value) + '</b></div>',
            '<div class="akd-deal-stat"><span>成交价格</span><b>' + price(avg) + '</b></div>',
            '<div class="akd-deal-stat"><span>成交量</span><b>' + number(success) + '</b></div>'
        ].join('');
    }

    function queryStatus(state) {
        if (state.queryLoading) {
            return '<div class="akd-query-status is-loading"><i></i><div><b>正在后台查询' + (state.queryType === 'buyer' ? '买家 ' : '卖家 ') + html(state.accountId || '-') + '</b><p>查询任务已提交，您可以切换查看其他模块；数据返回后会自动更新汇总和关联订单表。</p></div></div>';
        }
        if (!state.accountId && !state.visibleTrades.length) {
            return '<div class="akd-query-status is-empty">输入卖家或者买家 ID 可以查询对应的交易订单。</div>';
        }
        if (state.accountId && !state.visibleTrades.length) {
            return '<div class="akd-query-status is-missing"><div><b>' + (state.queryType === 'buyer' ? '买家 ' : '卖家 ') + html(state.accountId) + '</b><p>暂无匹配数据。</p></div><span>无匹配订单</span></div>';
        }
        if (state.accountId && state.queryTotal > 0) {
            var latest = state.visibleTrades[0] || {};
            return '<div class="akd-query-status"><div><b>' + (state.queryType === 'buyer' ? '买家 ' : '卖家 ') + html(state.accountId) + ' · 关联订单 ' + number(state.queryTotal) + ' 笔</b><p>最近订单 ' + html(latest.trade_id || '-') + ' · ' + time(latest.create_time) + '，下方表格已展示全部关联订单。</p></div><span>本地查询</span></div>';
        }
        return '<div class="akd-query-status"><div><b>最近订单 · 当前显示 ' + number(state.visibleTrades.length) + ' 笔</b><p>点击订单行可查看买家明细。</p></div><span>列表视图</span></div>';
    }

    function renderOrderRows(state) {
        var rows = state.visibleTrades || [];
        if (!rows.length) return '<tr><td colspan="9" class="akd-empty-cell">暂无匹配数据</td></tr>';
        return rows.map(function(row) {
            var selected = Number(row.trade_id) === Number(state.selectedTradeId);
            return '<tr class="' + (selected ? 'is-selected' : '') + '" data-action="trade-buyers" data-trade-id="' + html(row.trade_id) + '">' +
                '<td>' + html(row.trade_id) + '</td>' +
                '<td>' + time(row.create_time) + '</td>' +
                '<td>' + html(row.seller_flow_number || '-') + '</td>' +
                '<td data-align="right">' + price(row.single_price) + '</td>' +
                '<td data-align="right">' + number(row.readonly_stock_count) + '</td>' +
                '<td data-align="right">' + number(row.mycancel) + '</td>' +
                '<td data-align="right">' + number(row.success) + '</td>' +
                '<td data-align="right">' + money(row.success_value) + '</td>' +
                '<td data-align="right">' + number(row.buyer_count) + '</td>' +
            '</tr>';
        }).join('');
    }

    function renderBuyerRows(state) {
        if (state.buyerLoading) return '<tr><td colspan="3" class="akd-empty-cell">正在读取买家明细...</td></tr>';
        if (state.buyerError) return '<tr><td colspan="3" class="akd-empty-cell">' + html(state.buyerError) + '</td></tr>';
        var rows = state.buyerRows || [];
        if (!rows.length) return '<tr><td colspan="3" class="akd-empty-cell">暂无买家明细</td></tr>';
        return rows.map(function(row) {
            return '<tr><td>' + html(row.trade_id) + '</td><td data-align="right">' + number(row.ak_amount) + '</td><td data-align="right">' + html(row.buyer_flow_number || '-') + '</td></tr>';
        }).join('');
    }

    function renderTable(state) {
        if (state.tableMode === 'buyers') {
            return '<div class="akd-table-head"><div><h3>买家明细</h3><p>订单 ' + html(state.selectedTradeId || '-') + ' 的买入记录。</p></div><button class="akd-btn ghost" data-action="back-orders">返回订单</button></div>' +
                '<div class="akd-table-wrap"><table class="akd-table akd-table--buyers"><thead><tr><th>订单 ID</th><th data-align="right">购买数量</th><th data-align="right">买家 ID</th></tr></thead><tbody>' + renderBuyerRows(state) + '</tbody></table></div>';
        }
        return '<div class="akd-table-head"><div><h3>关联订单</h3><p>' + (state.queryTotal ? '显示当前查询关联订单。' : '显示最近采集订单。') + '</p></div><span>' + number((state.visibleTrades || []).length) + ' 笔</span></div>' +
            '<div class="akd-table-wrap"><table class="akd-table"><thead><tr><th>订单 ID</th><th>成交时间</th><th>卖家 ID</th><th data-align="right">成交价</th><th data-align="right">挂卖量</th><th data-align="right">交易销毁</th><th data-align="right">成交量</th><th data-align="right">成交价值</th><th data-align="right">买家数</th></tr></thead><tbody>' + renderOrderRows(state) + '</tbody></table></div>';
    }

    function render(state) {
        return [
            '<div class="akd-root">',
            '<section class="akd-hero"><div><h2>AK交易订单统计与交易查询</h2></div><button class="akd-btn primary" data-action="refresh">刷新数据</button></section>',
            '<section class="akd-metrics">' + renderMetrics(state) + '</section>',
            '<section class="akd-layout">',
            '<aside class="akd-side">',
            '<section class="akd-panel"><div class="akd-panel-head"><h3>表占用</h3><span>' + bytes((state.storage || []).reduce(function(total, row) { return total + Number(row.total_bytes || 0); }, 0)) + '</span></div><div class="akd-storage">' + renderStorage(state) + '</div></section>',
            '<section class="akd-panel"><div class="akd-panel-head"><div><h3>采集配置</h3><p>请求间隔、切号上限、兜底账号、保留期都在这里调整。</p></div></div>' + renderConfig(state) + '</section>',
            '<section class="akd-panel"><div class="akd-panel-head"><div><h3>一次性回填</h3><p>可向前补到指定日期并保存到数据库。</p></div></div>' + renderBackfill(state) + '</section>',
            '<section class="akd-panel"><div class="akd-panel-head"><h3>日统计范围</h3></div><div class="akd-segment"><button class="' + (state.dashboardDays === 7 ? 'active' : '') + '" data-action="range" data-days="7">近 7 天</button><button class="' + (state.dashboardDays === 14 ? 'active' : '') + '" data-action="range" data-days="14">近 14 天</button><button class="' + (state.dashboardDays === 30 ? 'active' : '') + '" data-action="range" data-days="30">近 30 天</button></div></section>',
            '</aside>',
            '<main class="akd-main">',
            '<section class="akd-panel akd-query-panel"><div class="akd-panel-head"><div><h3>AK交易数据</h3><p>输入卖家或者买家 ID 可以查询对应的交易订单。</p></div></div><div class="akd-search"><select id="akDataQueryType"><option value="seller"' + (state.queryType === 'seller' ? ' selected' : '') + '>卖家 ID</option><option value="buyer"' + (state.queryType === 'buyer' ? ' selected' : '') + '>买家 ID</option></select><input id="akDataAccountId" type="number" value="' + html(state.accountId) + '" placeholder="输入卖家或买家 ID"><button class="akd-btn primary" data-action="search">查询交易</button><button class="akd-btn ghost" data-action="reset">最近订单</button></div>' + queryStatus(state) + renderTable(state) + '</section>',
            '<section class="akd-panel"><div class="akd-panel-head"><div><h3>日统计看板</h3><p>交易量使用分层柱显示，完整四项统计放在悬浮提示中。</p></div></div><div class="akd-chart-grid"><div class="akd-chart-card"><strong>AK交易统计</strong>' + renderDashboardBars(state) + '<div class="akd-legend"><span class="success">成交量</span><span class="burn">交易销毁</span><span class="fee">手续费扣除</span></div></div><div class="akd-chart-card"><strong>AK成交统计</strong><div class="akd-deal-grid">' + renderDealStats(state) + '</div></div></div></section>',
            '</main>',
            '</section>',
            '</div>'
        ].join('');
    }

    window.AKDataRenderer = {
        render: render
    };
})();
