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
            metric('本地订单', number(s.order_count), s.first_trade_time ? '起始 ' + time(s.first_trade_time) : '等待数据', '')
        ].join('');
    }

    function renderStorage(state) {
        var rows = state.storage || [];
        if (!rows.length) return '<div class="akd-empty">暂无表占用数据</div>';
        return rows.map(function(row) {
            return '<div class="akd-storage-row"><span>' + html(row.table_name) + '</span><b>' + bytes(row.total_bytes) + '</b><em>' + number(row.rows) + ' 行</em></div>';
        }).join('');
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
            '<section class="akd-hero"><div><span>AK 数据看板</span><h2>市场订单采集与交易查询</h2><p>查看本地采集状态、表占用、日统计和卖家/买家关联订单。</p></div><button class="akd-btn primary" data-action="refresh">刷新数据</button></section>',
            '<section class="akd-metrics">' + renderMetrics(state) + '</section>',
            '<section class="akd-layout">',
            '<aside class="akd-side">',
            '<section class="akd-panel"><div class="akd-panel-head"><h3>表占用</h3><span>' + bytes((state.storage || []).reduce(function(total, row) { return total + Number(row.total_bytes || 0); }, 0)) + '</span></div><div class="akd-storage">' + renderStorage(state) + '</div></section>',
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
