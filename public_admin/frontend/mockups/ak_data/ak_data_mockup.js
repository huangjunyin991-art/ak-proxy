(function() {
    var state = {
        latestId: 13339050,
        localMaxId: 13339018,
        backfillPercent: 64,
        rangeDays: 7,
        selectedFlowNumber: '594344',
        selectedFlowRole: 'seller',
        selectedTradeId: 0,
        visibleTrades: [],
        tableMode: 'orders',
        searchSeq: 0,
        status: 'running',
        charts: {}
    };

    var trades = [
        {
            trade_id: 13339050,
            create_time: '2026/6/17 12:11:26',
            seller_flow_number: '594349',
            single_price: 0.255,
            readonly_stock_count: 14880,
            mycancel: 1488,
            success: 12048,
            success_value: 3072.24,
            buyers: [
                { buyer_flow_number: '3735581', ak_amount: 1760 },
                { buyer_flow_number: '3735580', ak_amount: 1961 },
                { buyer_flow_number: '3735579', ak_amount: 1961 },
                { buyer_flow_number: '3735578', ak_amount: 1961 },
                { buyer_flow_number: '3735577', ak_amount: 4405 }
            ]
        },
        {
            trade_id: 13339049,
            create_time: '2026/6/17 12:07:42',
            seller_flow_number: '594348',
            single_price: 0.255,
            readonly_stock_count: 9182,
            mycancel: 918,
            success: 7436,
            success_value: 1896.18,
            buyers: [
                { buyer_flow_number: '3735576', ak_amount: 1112 },
                { buyer_flow_number: '3735575', ak_amount: 1490 },
                { buyer_flow_number: '3735574', ak_amount: 1961 },
                { buyer_flow_number: '3735573', ak_amount: 2873 }
            ]
        },
        {
            trade_id: 13339048,
            create_time: '2026/6/17 12:04:55',
            seller_flow_number: '594347',
            single_price: 0.255,
            readonly_stock_count: 10281,
            mycancel: 1028,
            success: 7393,
            success_value: 1885.22,
            buyers: [
                { buyer_flow_number: '3735571', ak_amount: 184 },
                { buyer_flow_number: '3735570', ak_amount: 1961 },
                { buyer_flow_number: '3735569', ak_amount: 1961 },
                { buyer_flow_number: '3735568', ak_amount: 1961 },
                { buyer_flow_number: '3735567', ak_amount: 1326 }
            ]
        },
        {
            trade_id: 13339000,
            create_time: '2026/6/17 12:01:06',
            seller_flow_number: '594344',
            single_price: 0.255,
            readonly_stock_count: 10281,
            mycancel: 1028,
            success: 7393,
            success_value: 1885.22,
            buyers: [
                { buyer_flow_number: '3735490', ak_amount: 184 },
                { buyer_flow_number: '3735489', ak_amount: 1961 },
                { buyer_flow_number: '3735488', ak_amount: 1961 },
                { buyer_flow_number: '3735487', ak_amount: 1961 },
                { buyer_flow_number: '3735486', ak_amount: 1326 }
            ]
        },
        {
            trade_id: 13338996,
            create_time: '2026/6/17 11:57:38',
            seller_flow_number: '0',
            single_price: 0.255,
            readonly_stock_count: 6400,
            mycancel: 0,
            success: 5760,
            success_value: 1468.80,
            buyers: [
                { buyer_flow_number: '3735485', ak_amount: 960 },
                { buyer_flow_number: '3735484', ak_amount: 1440 },
                { buyer_flow_number: '3735483', ak_amount: 3360 }
            ]
        },
        {
            trade_id: 13338982,
            create_time: '2026/6/17 11:49:20',
            seller_flow_number: '594338',
            single_price: 0.254,
            readonly_stock_count: 22860,
            mycancel: 2286,
            success: 18516,
            success_value: 4703.06,
            buyers: [
                { buyer_flow_number: '3735474', ak_amount: 3922 },
                { buyer_flow_number: '3735473', ak_amount: 3922 },
                { buyer_flow_number: '3735472', ak_amount: 3922 },
                { buyer_flow_number: '3735471', ak_amount: 6750 }
            ]
        }
    ];

    var daily = [
        { date: '06-11', orders: 284, success: 1628000, burn: 181000, fee: 181000, value: 413560, price: 0.254 },
        { date: '06-12', orders: 311, success: 1795000, burn: 199000, fee: 199000, value: 456940, price: 0.255 },
        { date: '06-13', orders: 276, success: 1519000, burn: 169000, fee: 169000, value: 386020, price: 0.254 },
        { date: '06-14', orders: 338, success: 1942000, burn: 215000, fee: 216000, value: 493640, price: 0.255 },
        { date: '06-15', orders: 354, success: 2049000, burn: 227000, fee: 228000, value: 520720, price: 0.254 },
        { date: '06-16', orders: 391, success: 2268000, burn: 251000, fee: 252000, value: 576110, price: 0.254 },
        { date: '06-17', orders: 263, success: 1486000, burn: 165000, fee: 165000, value: 377820, price: 0.253 },
        { date: '06-18', orders: 372, success: 2115000, burn: 235000, fee: 235000, value: 537210, price: 0.254 },
        { date: '06-19', orders: 345, success: 1983000, burn: 220000, fee: 220000, value: 503710, price: 0.253 },
        { date: '06-20', orders: 418, success: 2417000, burn: 268000, fee: 269000, value: 614160, price: 0.255 },
        { date: '06-21', orders: 386, success: 2241000, burn: 249000, fee: 249000, value: 569600, price: 0.254 },
        { date: '06-22', orders: 404, success: 2389000, burn: 265000, fee: 265000, value: 606700, price: 0.255 },
        { date: '06-23', orders: 352, success: 2056000, burn: 228000, fee: 229000, value: 522230, price: 0.253 },
        { date: '06-24', orders: 377, success: 2191000, burn: 243000, fee: 243000, value: 556510, price: 0.254 }
    ];

    function $(selector) {
        return document.querySelector(selector);
    }

    function all(selector) {
        return Array.prototype.slice.call(document.querySelectorAll(selector));
    }

    function numberText(value, digits) {
        var number = Number(value || 0);
        return number.toLocaleString('zh-CN', {
            minimumFractionDigits: digits || 0,
            maximumFractionDigits: digits || 0
        });
    }

    function moneyText(value) {
        return Number(value || 0).toLocaleString('zh-CN', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    function priceText(value) {
        return Number(value || 0).toFixed(3);
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function buyerSum(trade) {
        return (trade.buyers || []).reduce(function(sum, row) {
            return sum + Number(row.ak_amount || 0);
        }, 0);
    }

    function platformGap(trade) {
        return Number(trade.readonly_stock_count || 0) - Number(trade.mycancel || 0) - Number(trade.success || 0);
    }

    function dailyStock(row) {
        return Number(row.success || 0) + Number(row.burn || 0) + Number(row.fee || 0);
    }

    function findTradesByFlow(role, flowNumber) {
        var flow = String(flowNumber || '').trim();
        if (!flow) return [];
        return trades.filter(function(row) {
            if (role === 'buyer') {
                return (row.buyers || []).some(function(buyer) {
                    return String(buyer.buyer_flow_number || '') === flow;
                });
            }
            return String(row.seller_flow_number || '') === flow;
        });
    }

    function toast(message) {
        var node = $('#toast');
        if (!node) return;
        node.textContent = message;
        node.classList.add('is-visible');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(function() {
            node.classList.remove('is-visible');
        }, 1800);
    }

    function updateStatusCards() {
        var gap = Math.max(0, state.latestId - state.localMaxId);
        $('#mockLatestId').textContent = String(state.latestId);
        $('#mockLocalMax').textContent = String(state.localMaxId);
        $('#mockGapText').textContent = gap > 0 ? '待补 ' + numberText(gap) + ' 笔订单' : '本地已追平最新订单';
        if (state.status === 'error') {
            $('#mockStatusText').textContent = '等待人工处理';
            $('#mockStatusHint').textContent = '上游账号 key 失效，已切换兜底账号';
            $('#mockNextCheck').textContent = '暂停中';
            return;
        }
        $('#mockStatusText').textContent = gap > 0 ? '增量采集中' : '空闲';
        $('#mockStatusHint').textContent = gap > 0 ? '正在扫描 ' + (state.localMaxId + 1) + ' - ' + state.latestId : '最近任务已完成';
        $('#mockNextCheck').textContent = gap > 0 ? '任务结束后 60 分钟' : '58 分钟后';
    }

    function renderAccountResult(role, flowNumber, rows) {
        var node = $('#tradeResult');
        if (!node) return;
        var flow = String(flowNumber || '').trim();
        var isBuyer = role === 'buyer';
        if (!flow) {
            node.innerHTML = '<div class="ak-query-status is-empty">请输入卖家或买家 ID 后查询。</div>';
            return;
        }
        if (!rows || !rows.length) {
            node.innerHTML = [
                '<div class="ak-query-status is-missing">',
                '<div>',
                '<strong>' + (isBuyer ? '买家 ' : '卖家 ') + escapeHtml(flow) + '</strong>',
                '<p>暂无匹配数据。</p>',
                '</div>',
                '<span>无匹配订单</span>',
                '</div>'
            ].join('');
            return;
        }

        var latest = rows[0] || {};

        node.innerHTML = [
            '<div class="ak-query-status">',
            '<div>',
            '<strong>' + (isBuyer ? '买家 ' : '卖家 ') + escapeHtml(flow) + ' · 关联订单 ' + numberText(rows.length) + ' 笔</strong>',
            '<p>最近订单 ' + escapeHtml(latest.trade_id || '-') + ' · ' + escapeHtml(latest.create_time || '-') + '，下方表格已展示全部关联订单。</p>',
            '</div>',
            '<span>本地查询</span>',
            '</div>'
        ].join('');
    }

    function renderSearchPending(role, flowNumber) {
        var node = $('#tradeResult');
        if (!node) return;
        var isBuyer = role === 'buyer';
        var flow = String(flowNumber || '').trim();
        node.innerHTML = [
            '<div class="ak-query-status is-pending">',
            '<div class="ak-loading-dot"></div>',
            '<div>',
            '<strong>正在后台查询' + (isBuyer ? '买家 ' : '卖家 ') + escapeHtml(flow || '-') + '</strong>',
            '<p>查询任务已提交，您可以切换查看其他模块；数据返回后会自动更新汇总和关联订单表。</p>',
            '</div>',
            '</div>'
        ].join('');
        var hint = $('#tableHint');
        if (hint) {
            hint.textContent = '后台查询中，当前表格暂时保留上一次结果，返回后会显示所有符合条件的订单。';
        }
        var tag = $('#tableModeTag');
        if (tag) tag.textContent = '查询中';
    }

    function renderRecentOverview() {
        var node = $('#tradeResult');
        if (!node) return;
        var uniqueSellers = {};
        var uniqueBuyers = {};
        trades.forEach(function(row) {
            uniqueSellers[String(row.seller_flow_number || '')] = true;
            (row.buyers || []).forEach(function(buyer) {
                uniqueBuyers[String(buyer.buyer_flow_number || '')] = true;
            });
        });
        node.innerHTML = [
            '<div class="ak-query-status">',
            '<div>',
            '<strong>最近订单 · 当前显示 ' + numberText(trades.length) + ' 笔</strong>',
            '<p>卖家 ' + numberText(Object.keys(uniqueSellers).length) + ' 个 · 买家 ' + numberText(Object.keys(uniqueBuyers).length) + ' 个，点击订单行查看买家明细。</p>',
            '</div>',
            '<span>列表视图</span>',
            '</div>'
        ].join('');
    }

    function buyerAmountForFlow(trade, flowNumber) {
        return (trade.buyers || []).reduce(function(sum, buyer) {
            if (String(buyer.buyer_flow_number || '') !== String(flowNumber || '')) return sum;
            return sum + Number(buyer.ak_amount || 0);
        }, 0);
    }

    function summarizeFlow(role, flowNumber, rows) {
        var sellerSet = {};
        var summary = {
            stock: 0,
            burn: 0,
            success: 0,
            successValue: 0,
            gap: 0,
            buyAmount: 0,
            buyValue: 0,
            latestBuyAmount: 0,
            sellerCount: 0,
            latestTradeId: rows[0] ? rows[0].trade_id : '-',
            firstTime: rows[rows.length - 1] ? rows[rows.length - 1].create_time : '-',
            latestTime: rows[0] ? rows[0].create_time : '-',
            avgPrice: 0
        };

        rows.forEach(function(row, index) {
            if (role === 'buyer') {
                var amount = buyerAmountForFlow(row, flowNumber);
                summary.buyAmount += amount;
                summary.buyValue += amount * Number(row.single_price || 0);
                if (index === 0) summary.latestBuyAmount = amount;
                sellerSet[String(row.seller_flow_number || '')] = true;
                return;
            }
            summary.stock += Number(row.readonly_stock_count || 0);
            summary.burn += Number(row.mycancel || 0);
            summary.success += Number(row.success || 0);
            summary.successValue += Number(row.success_value || 0);
            summary.gap += platformGap(row);
        });

        summary.sellerCount = Object.keys(sellerSet).length;
        summary.avgPrice = summary.buyAmount > 0 ? summary.buyValue / summary.buyAmount : 0;
        return summary;
    }

    function renderTable(rows) {
        state.tableMode = 'orders';
        var table = $('#tradeTable');
        var head = $('#tradeTableHead');
        var body = $('#tradeTableBody');
        if (!body) return;
        var list = rows || state.visibleTrades || trades;
        if (table) {
            table.classList.remove('is-buyer-view');
            table.classList.add('is-switching');
            setTimeout(function() { table.classList.remove('is-switching'); }, 190);
        }
        if (head) {
            head.innerHTML = [
                '<tr>',
                '<th>订单 ID</th>',
                '<th>成交时间</th>',
                '<th>卖家 ID</th>',
                '<th data-align="right">成交价</th>',
                '<th data-align="right">挂卖总数</th>',
                '<th data-align="right">交易销毁</th>',
                '<th data-align="right">成交量</th>',
                '<th data-align="right">成交价值</th>',
                '<th data-align="right">买家数</th>',
                '</tr>'
            ].join('');
        }
        body.innerHTML = list.map(function(row) {
            var selected = Number(row.trade_id) === Number(state.selectedTradeId);
            return [
                '<tr class="' + (selected ? 'is-selected' : '') + '" data-trade-id="' + escapeHtml(row.trade_id) + '">',
                '<td>' + escapeHtml(row.trade_id) + '</td>',
                '<td>' + escapeHtml(row.create_time) + '</td>',
                '<td>' + escapeHtml(row.seller_flow_number) + '</td>',
                '<td data-align="right">' + priceText(row.single_price) + '</td>',
                '<td data-align="right">' + numberText(row.readonly_stock_count) + '</td>',
                '<td data-align="right">' + numberText(row.mycancel) + '</td>',
                '<td data-align="right">' + numberText(row.success) + '</td>',
                '<td data-align="right">' + moneyText(row.success_value) + '</td>',
                '<td data-align="right">' + numberText((row.buyers || []).length) + '</td>',
                '</tr>'
            ].join('');
        }).join('');

        var hint = $('#tableHint');
        if (hint) {
            hint.textContent = list === trades
                ? '展示模拟采集到的最近订单，点击任一订单可查看买家明细。'
                : '展示当前账户关联的 ' + numberText(list.length) + ' 笔订单，点击任一订单可查看买家明细。';
        }
        var tag = $('#tableModeTag');
        if (tag) tag.textContent = '订单列表';
    }

    function renderBuyerTable(trade) {
        var table = $('#tradeTable');
        var head = $('#tradeTableHead');
        var body = $('#tradeTableBody');
        if (!trade || !body) return;
        state.tableMode = 'buyers';
        state.selectedTradeId = trade.trade_id;
        if (table) {
            table.classList.add('is-buyer-view', 'is-switching');
            setTimeout(function() { table.classList.remove('is-switching'); }, 190);
        }
        if (head) {
            head.innerHTML = [
                '<tr>',
                '<th>订单 ID</th>',
                '<th>成交时间</th>',
                '<th>卖家 ID</th>',
                '<th data-align="right">购买数量</th>',
                '<th data-align="right">买家 ID</th>',
                '</tr>'
            ].join('');
        }
        body.innerHTML = (trade.buyers || []).map(function(buyer) {
            return [
                '<tr class="is-buyer-row" data-buyer-flow="' + escapeHtml(buyer.buyer_flow_number) + '">',
                '<td>' + escapeHtml(trade.trade_id) + '</td>',
                '<td>' + escapeHtml(trade.create_time) + '</td>',
                '<td>' + escapeHtml(trade.seller_flow_number) + '</td>',
                '<td data-align="right">' + numberText(buyer.ak_amount) + '</td>',
                '<td data-align="right">' + escapeHtml(buyer.buyer_flow_number) + '</td>',
                '</tr>'
            ].join('');
        }).join('');

        var hint = $('#tableHint');
        if (hint) {
            hint.textContent = '正在查看订单 ' + trade.trade_id + ' 的买家明细，共 ' + numberText((trade.buyers || []).length) + ' 条；重新查询或点击“显示最近订单”可返回订单列表。';
        }
        var tag = $('#tableModeTag');
        if (tag) tag.textContent = '买家明细';
    }

    function renderCharts() {
        var rows = daily.slice(Math.max(0, daily.length - state.rangeDays));
        var labels = rows.map(function(row) { return row.date; });

        if (window.Chart) {
            renderVolumeChart(labels, rows);
            renderValueChart(labels, rows);
            return;
        }
        renderFallbackVolumeChart(labels, rows);
        renderFallbackValueChart(labels, rows);
    }

    function chartBaseOptions() {
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                legend: {
                    labels: {
                        color: '#617174',
                        boxWidth: 10,
                        boxHeight: 10,
                        font: { size: 12, weight: '700' }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(19,35,38,0.92)',
                    padding: 10
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: '#8b9a9d', font: { size: 11 } }
                },
                y: {
                    grid: { color: 'rgba(200,214,217,0.56)' },
                    ticks: {
                        color: '#8b9a9d',
                        font: { size: 11 },
                        callback: function(value) {
                            return Number(value || 0).toLocaleString('zh-CN');
                        }
                    }
                }
            }
        };
    }

    function renderVolumeChart(labels, rows) {
        var ctx = $('#volumeChart');
        if (!ctx) return;
        if (state.charts.volume) state.charts.volume.destroy();
        state.charts.volume = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: '成交量',
                        data: rows.map(function(row) { return row.success; }),
                        backgroundColor: 'rgba(14,170,166,0.72)',
                        borderRadius: 6,
                        stack: 'ak-volume',
                        order: 1
                    },
                    {
                        label: '交易销毁',
                        data: rows.map(function(row) { return row.burn; }),
                        backgroundColor: 'rgba(183,121,31,0.62)',
                        borderRadius: 6,
                        stack: 'ak-volume',
                        order: 1
                    },
                    {
                        label: '手续费扣除',
                        data: rows.map(function(row) { return row.fee; }),
                        backgroundColor: 'rgba(196,91,91,0.58)',
                        borderRadius: 6,
                        stack: 'ak-volume',
                        order: 1
                    }
                ]
            },
            options: stackedBarOptions()
        });
    }

    function stackedBarOptions() {
        var options = chartBaseOptions();
        options.scales.x.stacked = true;
        options.scales.y.stacked = true;
        options.interaction = { mode: 'index', intersect: false };
        options.plugins.tooltip.callbacks = {
            title: function(items) {
                return items && items.length ? items[0].label : '';
            },
            beforeBody: function(items) {
                var index = items && items.length ? items[0].dataIndex : -1;
                var row = index >= 0 ? daily.slice(Math.max(0, daily.length - state.rangeDays))[index] : null;
                return row ? ['挂卖量：' + numberText(dailyStock(row))] : [];
            },
            label: function(item) {
                return item.dataset.label + '：' + numberText(item.parsed.y);
            }
        };
        return options;
    }

    function renderValueChart(labels, rows) {
        var ctx = $('#valueChart');
        if (!ctx) return;
        if (state.charts.value) state.charts.value.destroy();
        state.charts.value = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: '成交价值',
                        data: rows.map(function(row) { return row.value; }),
                        borderColor: '#087c82',
                        backgroundColor: 'rgba(14,170,166,0.14)',
                        fill: true,
                        pointRadius: 3,
                        pointHoverRadius: 5,
                        tension: 0.28,
                        yAxisID: 'y'
                    },
                    {
                        label: '成交价格',
                        data: rows.map(function(row) { return row.price; }),
                        borderColor: '#b7791f',
                        backgroundColor: 'rgba(183,121,31,0.1)',
                        fill: false,
                        pointRadius: 3,
                        tension: 0.28,
                        yAxisID: 'price'
                    }
                ]
            },
            options: dealChartOptions()
        });
    }

    function dealChartOptions() {
        var options = chartBaseOptions();
        options.scales.price = {
            position: 'right',
            grid: { drawOnChartArea: false },
            min: 0.250,
            max: 0.258,
            ticks: {
                color: '#b7791f',
                font: { size: 11 },
                callback: function(value) {
                    return Number(value || 0).toFixed(3);
                }
            }
        };
        return options;
    }

    function setupCanvas(canvas) {
        var rect = canvas.getBoundingClientRect();
        var ratio = window.devicePixelRatio || 1;
        var width = Math.max(320, Math.round(rect.width || canvas.clientWidth || 640));
        var height = Math.max(220, Math.round(rect.height || canvas.clientHeight || 230));
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        var ctx = canvas.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, width, height);
        return { ctx: ctx, width: width, height: height };
    }

    function drawLegend(ctx, items, x, y) {
        var cursor = x;
        items.forEach(function(item, index) {
            ctx.fillStyle = item.color;
            roundedRect(ctx, cursor, y + 1, 10, 10, 3);
            ctx.fill();
            ctx.fillStyle = '#617174';
            ctx.font = '700 12px "Microsoft YaHei UI", sans-serif';
            ctx.fillText(item.label, cursor + 16, y + 10);
            cursor += 28 + ctx.measureText(item.label).width;
        });
    }

    function drawAxes(ctx, box, labels, maxValue) {
        ctx.strokeStyle = 'rgba(200,214,217,0.72)';
        ctx.lineWidth = 1;
        ctx.fillStyle = '#8b9a9d';
        ctx.font = '11px "Microsoft YaHei UI", sans-serif';

        for (var i = 0; i <= 4; i++) {
            var y = box.top + (box.height / 4) * i;
            ctx.beginPath();
            ctx.moveTo(box.left, y);
            ctx.lineTo(box.left + box.width, y);
            ctx.stroke();
            var value = Math.round(maxValue * (1 - i / 4));
            ctx.fillText(shortNumber(value), 4, y + 4);
        }

        labels.forEach(function(label, index) {
            var x = box.left + (box.width / Math.max(labels.length - 1, 1)) * index;
            ctx.fillText(label, x - 13, box.top + box.height + 22);
        });
    }

    function shortNumber(value) {
        if (value >= 1000000) return Math.round(value / 10000) + '万';
        if (value >= 10000) return Math.round(value / 10000) + '万';
        return String(value || 0);
    }

    function roundedRect(ctx, x, y, width, height, radius) {
        var r = Math.min(radius, width / 2, height / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + width - r, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + r);
        ctx.lineTo(x + width, y + height - r);
        ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
        ctx.lineTo(x + r, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function chartTooltipNode() {
        var node = $('#akChartTooltip');
        if (node) return node;
        node = document.createElement('div');
        node.id = 'akChartTooltip';
        node.className = 'ak-chart-tooltip';
        document.body.appendChild(node);
        return node;
    }

    function hideChartTooltip() {
        var node = $('#akChartTooltip');
        if (node) node.classList.remove('is-visible');
    }

    function showChartTooltip(event, row) {
        var node = chartTooltipNode();
        node.innerHTML = [
            '<strong>' + escapeHtml(row.date) + '</strong>',
            '<span><i data-color="stock"></i>挂卖量：' + numberText(dailyStock(row)) + '</span>',
            '<span><i data-color="success"></i>成交量：' + numberText(row.success) + '</span>',
            '<span><i data-color="burn"></i>交易销毁：' + numberText(row.burn) + '</span>',
            '<span><i data-color="fee"></i>手续费扣除：' + numberText(row.fee) + '</span>'
        ].join('');
        node.style.left = Math.round(event.clientX + 14) + 'px';
        node.style.top = Math.round(event.clientY + 14) + 'px';
        node.classList.add('is-visible');
    }

    function bindVolumeTooltip(canvas, rows, box) {
        canvas.onmousemove = function(event) {
            var rect = canvas.getBoundingClientRect();
            var x = event.clientX - rect.left;
            var y = event.clientY - rect.top;
            if (x < box.left || x > box.left + box.width || y < box.top || y > box.top + box.height) {
                hideChartTooltip();
                return;
            }
            var groupWidth = box.width / rows.length;
            var index = Math.max(0, Math.min(rows.length - 1, Math.floor((x - box.left) / groupWidth)));
            showChartTooltip(event, rows[index]);
        };
        canvas.onmouseleave = hideChartTooltip;
    }

    function renderFallbackVolumeChart(labels, rows) {
        var canvas = $('#volumeChart');
        if (!canvas) return;
        var surface = setupCanvas(canvas);
        var ctx = surface.ctx;
        var box = { left: 54, top: 24, width: surface.width - 72, height: surface.height - 64 };
        var maxValue = Math.max.apply(null, rows.map(function(row) {
            return dailyStock(row);
        })) || 1;
        drawAxes(ctx, box, labels, maxValue);
        drawLegend(ctx, [
            { label: '成交量', color: '#0eaaa6' },
            { label: '交易销毁', color: '#b7791f' },
            { label: '手续费扣除', color: '#c45b5b' }
        ], box.left, 4);

        var groupWidth = box.width / rows.length;
        rows.forEach(function(row, index) {
            var x = box.left + index * groupWidth + groupWidth * 0.34;
            var barWidth = Math.max(14, groupWidth * 0.28);
            var successHeight = box.height * row.success / maxValue;
            var burnHeight = box.height * row.burn / maxValue;
            var feeHeight = box.height * row.fee / maxValue;
            var baseY = box.top + box.height;

            ctx.fillStyle = 'rgba(14,170,166,0.78)';
            roundedRect(ctx, x, baseY - successHeight, barWidth, successHeight, 5);
            ctx.fill();

            ctx.fillStyle = 'rgba(183,121,31,0.66)';
            roundedRect(ctx, x, baseY - successHeight - burnHeight, barWidth, burnHeight + 3, 5);
            ctx.fill();

            ctx.fillStyle = 'rgba(196,91,91,0.58)';
            roundedRect(ctx, x, baseY - successHeight - burnHeight - feeHeight, barWidth, feeHeight + 3, 5);
            ctx.fill();
        });
        bindVolumeTooltip(canvas, rows, box);
    }

    function renderFallbackValueChart(labels, rows) {
        var canvas = $('#valueChart');
        if (!canvas) return;
        var surface = setupCanvas(canvas);
        var ctx = surface.ctx;
        var box = { left: 54, top: 24, width: surface.width - 72, height: surface.height - 64 };
        var values = rows.map(function(row) { return row.value; });
        var prices = rows.map(function(row) { return row.price; });
        var maxValue = Math.max.apply(null, values) || 1;
        var minPrice = Math.min.apply(null, prices) || 0.250;
        var maxPrice = Math.max.apply(null, prices) || 0.258;
        var pricePad = Math.max(0.001, (maxPrice - minPrice) * 0.35);
        minPrice = Math.max(0, minPrice - pricePad);
        maxPrice = maxPrice + pricePad;
        drawAxes(ctx, box, labels, maxValue);
        drawLegend(ctx, [
            { label: '成交价值', color: '#087c82' },
            { label: '成交价格', color: '#b7791f' }
        ], box.left, 4);

        ctx.fillStyle = '#b7791f';
        ctx.font = '11px "Microsoft YaHei UI", sans-serif';
        for (var tick = 0; tick <= 4; tick++) {
            var py = box.top + (box.height / 4) * tick;
            var priceValue = maxPrice - (maxPrice - minPrice) * (tick / 4);
            ctx.fillText(priceValue.toFixed(3), box.left + box.width + 8, py + 4);
        }

        ctx.beginPath();
        values.forEach(function(value, index) {
            var x = box.left + (box.width / Math.max(values.length - 1, 1)) * index;
            var y = box.top + box.height - (box.height * value / maxValue);
            if (index === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = '#087c82';
        ctx.lineWidth = 3;
        ctx.stroke();

        values.forEach(function(value, index) {
            var x = box.left + (box.width / Math.max(values.length - 1, 1)) * index;
            var y = box.top + box.height - (box.height * value / maxValue);
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#087c82';
            ctx.lineWidth = 2;
            ctx.stroke();
        });

        ctx.beginPath();
        prices.forEach(function(price, index) {
            var x = box.left + (box.width / Math.max(prices.length - 1, 1)) * index;
            var y = box.top + box.height - (box.height * (price - minPrice) / Math.max(maxPrice - minPrice, 0.001));
            if (index === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = '#b7791f';
        ctx.lineWidth = 3;
        ctx.stroke();

        prices.forEach(function(price, index) {
            var x = box.left + (box.width / Math.max(prices.length - 1, 1)) * index;
            var y = box.top + box.height - (box.height * (price - minPrice) / Math.max(maxPrice - minPrice, 0.001));
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#b7791f';
            ctx.lineWidth = 2;
            ctx.stroke();
        });
    }

    function searchFlow() {
        var input = $('#flowSearchInput');
        var type = $('#flowSearchType');
        var flow = input ? input.value : '';
        var role = type ? type.value : 'seller';
        state.selectedFlowNumber = String(flow || '').trim();
        state.selectedFlowRole = role;
        state.searchSeq += 1;
        var seq = state.searchSeq;
        renderSearchPending(role, flow);
        toast('查询任务已提交，后台正在检索交易订单');
        window.setTimeout(function() {
            if (seq !== state.searchSeq) return;
            var rows = findTradesByFlow(role, flow);
            state.visibleTrades = rows;
            state.selectedTradeId = rows[0] ? rows[0].trade_id : 0;
            renderAccountResult(role, flow, rows);
            renderTable(rows);
            toast(rows.length ? '已返回 ' + rows.length + ' 笔符合条件的订单' : '暂无匹配数据');
        }, 720);
    }

    function resetFlowSearch() {
        state.visibleTrades = trades;
        state.selectedTradeId = 0;
        var input = $('#flowSearchInput');
        var type = $('#flowSearchType');
        if (input) input.value = state.selectedFlowNumber || '594344';
        if (type) type.value = state.selectedFlowRole || 'seller';
        renderRecentOverview();
        renderTable(trades);
        toast('已恢复最近订单列表');
    }

    function advanceProgress() {
        state.status = 'running';
        state.localMaxId = Math.min(state.latestId, state.localMaxId + 8);
        state.backfillPercent = Math.min(100, state.backfillPercent + 7);
        updateBackfill();
        updateStatusCards();
        toast(state.localMaxId >= state.latestId ? '模拟采集已追平最新订单' : '模拟采集进度已推进');
    }

    function simulateError() {
        state.status = state.status === 'error' ? 'running' : 'error';
        updateStatusCards();
        toast(state.status === 'error' ? '已模拟账号切换异常' : '已恢复模拟采集状态');
    }

    function updateBackfill() {
        var percent = state.backfillPercent;
        $('#backfillPercent').textContent = percent + '%';
        $('#backfillBar').style.width = percent + '%';
        $('#backfillText').textContent = percent >= 100
            ? '历史回填已完成，正式版可隐藏一次性入口。'
            : '已保存 ' + numberText(Math.round(percent * 20.06)) + ' 笔，当前扫描 ID ' + (13339050 - Math.round(percent * 20)) + '。';
    }

    function bindEvents() {
        document.addEventListener('click', function(event) {
            var actionNode = event.target.closest('[data-action]');
            if (actionNode) {
                var action = actionNode.getAttribute('data-action');
                if (action === 'search-flow') searchFlow();
                if (action === 'reset-flow') resetFlowSearch();
                if (action === 'advance-progress') advanceProgress();
                if (action === 'simulate-error') simulateError();
                if (action === 'save-config') toast('模拟配置已保存');
                if (action === 'start-backfill') {
                    state.backfillPercent = Math.max(state.backfillPercent, 68);
                    updateBackfill();
                    toast('已模拟启动历史回填');
                }
                if (action === 'pause-backfill') toast('已模拟暂停回填任务');
                if (action === 'cleanup') toast('已模拟按保留期清理过期数据');
                return;
            }

            var rangeNode = event.target.closest('[data-range]');
            if (rangeNode) {
                state.rangeDays = Number(rangeNode.getAttribute('data-range') || 7);
                all('[data-range]').forEach(function(node) {
                    node.classList.toggle('is-active', node === rangeNode);
                });
                renderCharts();
                toast('已切换到近 ' + state.rangeDays + ' 天');
                return;
            }

            var row = event.target.closest('tr[data-trade-id]');
            if (row) {
                var id = Number(row.getAttribute('data-trade-id'));
                var list = state.visibleTrades && state.visibleTrades.length ? state.visibleTrades : trades;
                var trade = list.find(function(item) {
                    return Number(item.trade_id) === id;
                });
                state.selectedTradeId = id;
                if (trade) {
                    renderBuyerTable(trade);
                    toast('已切换到订单 ' + id + ' 的买家明细');
                }
                return;
            }

            var buyerRow = event.target.closest('tr[data-buyer-flow]');
            if (buyerRow) {
                var buyerFlow = buyerRow.getAttribute('data-buyer-flow') || '';
                var input = $('#flowSearchInput');
                var type = $('#flowSearchType');
                if (input) input.value = buyerFlow;
                if (type) type.value = 'buyer';
                searchFlow();
            }
        });

        var input = $('#flowSearchInput');
        if (input) {
            input.addEventListener('keydown', function(event) {
                if (event.key === 'Enter') searchFlow();
            });
        }
    }

    function init() {
        bindEvents();
        updateStatusCards();
        updateBackfill();
        state.visibleTrades = findTradesByFlow(state.selectedFlowRole, state.selectedFlowNumber);
        state.selectedTradeId = state.visibleTrades[0] ? state.visibleTrades[0].trade_id : 0;
        renderAccountResult(state.selectedFlowRole, state.selectedFlowNumber, state.visibleTrades);
        renderTable(state.visibleTrades);
        renderCharts();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
