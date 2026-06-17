(function() {
    var state = {
        latestId: 13339050,
        localMaxId: 13339018,
        backfillPercent: 64,
        rangeDays: 7,
        selectedTradeId: 13339000,
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
        { date: '06-11', orders: 284, success: 1628000, burn: 181000, value: 413560 },
        { date: '06-12', orders: 311, success: 1795000, burn: 199000, value: 456940 },
        { date: '06-13', orders: 276, success: 1519000, burn: 169000, value: 386020 },
        { date: '06-14', orders: 338, success: 1942000, burn: 215000, value: 493640 },
        { date: '06-15', orders: 354, success: 2049000, burn: 227000, value: 520720 },
        { date: '06-16', orders: 391, success: 2268000, burn: 251000, value: 576110 },
        { date: '06-17', orders: 263, success: 1486000, burn: 165000, value: 377820 },
        { date: '06-18', orders: 372, success: 2115000, burn: 235000, value: 537210 },
        { date: '06-19', orders: 345, success: 1983000, burn: 220000, value: 503710 },
        { date: '06-20', orders: 418, success: 2417000, burn: 268000, value: 614160 },
        { date: '06-21', orders: 386, success: 2241000, burn: 249000, value: 569600 },
        { date: '06-22', orders: 404, success: 2389000, burn: 265000, value: 606700 },
        { date: '06-23', orders: 352, success: 2056000, burn: 228000, value: 522230 },
        { date: '06-24', orders: 377, success: 2191000, burn: 243000, value: 556510 }
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

    function findTrade(id) {
        var tradeId = Number(id || 0);
        return trades.find(function(row) {
            return Number(row.trade_id) === tradeId;
        }) || null;
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

    function renderTradeResult(trade, missingId) {
        var node = $('#tradeResult');
        if (!node) return;
        if (!trade) {
            node.innerHTML = [
                '<div class="ak-trade-empty">',
                '<div class="ak-trade-card__top">',
                '<div><h3>订单 ' + escapeHtml(missingId || '-') + '</h3><p>本地数据库暂未采集到这笔订单。</p></div>',
                '<span class="ak-trade-card__status is-missing">本地未采集</span>',
                '</div>',
                '<p>总管理员可以点击“上游抓取”模拟单笔拉取；正式版会走同一套保存逻辑，但不加入全局扫描队列。</p>',
                '</div>'
            ].join('');
            return;
        }

        var sum = buyerSum(trade);
        var ok = sum === Number(trade.success || 0);
        var buyers = (trade.buyers || []).slice(0, 5).map(function(row) {
            return '<div><span>' + escapeHtml(row.buyer_flow_number) + '</span><strong>' + numberText(row.ak_amount) + '</strong></div>';
        }).join('');

        node.innerHTML = [
            '<div class="ak-trade-card">',
            '<div class="ak-trade-card__top">',
            '<div><h3>订单 ' + escapeHtml(trade.trade_id) + '</h3><p>' + escapeHtml(trade.create_time) + ' · 卖家 ' + escapeHtml(trade.seller_flow_number) + '</p></div>',
            '<span class="ak-trade-card__status' + (ok ? '' : ' is-missing') + '">' + (ok ? '明细校验通过' : '明细不一致') + '</span>',
            '</div>',
            '<div class="ak-trade-stats">',
            statHtml('成交价', priceText(trade.single_price)),
            statHtml('挂卖总数', numberText(trade.readonly_stock_count)),
            statHtml('交易销毁', numberText(trade.mycancel)),
            statHtml('成交量', numberText(trade.success)),
            statHtml('成交价值', moneyText(trade.success_value)),
            statHtml('平台差额', numberText(platformGap(trade))),
            statHtml('买家合计', numberText(sum)),
            statHtml('买家数', numberText((trade.buyers || []).length)),
            '</div>',
            '<div class="ak-mini-buyers">' + buyers + '</div>',
            '</div>'
        ].join('');
    }

    function statHtml(label, value) {
        return '<div><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
    }

    function renderTable() {
        var body = $('#tradeTableBody');
        if (!body) return;
        body.innerHTML = trades.map(function(row) {
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
                        stack: 'ak-volume'
                    },
                    {
                        label: '交易销毁',
                        data: rows.map(function(row) { return row.burn; }),
                        backgroundColor: 'rgba(183,121,31,0.62)',
                        borderRadius: 6,
                        stack: 'ak-volume'
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
                        tension: 0.28
                    },
                    {
                        label: '订单数',
                        data: rows.map(function(row) { return row.orders * 1000; }),
                        borderColor: '#b7791f',
                        backgroundColor: 'rgba(183,121,31,0.1)',
                        fill: false,
                        pointRadius: 3,
                        tension: 0.28
                    }
                ]
            },
            options: chartBaseOptions()
        });
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
        items.forEach(function(item, index) {
            var offset = index * 86;
            ctx.fillStyle = item.color;
            roundedRect(ctx, x + offset, y + 1, 10, 10, 3);
            ctx.fill();
            ctx.fillStyle = '#617174';
            ctx.font = '700 12px "Microsoft YaHei UI", sans-serif';
            ctx.fillText(item.label, x + offset + 16, y + 10);
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

    function renderFallbackVolumeChart(labels, rows) {
        var canvas = $('#volumeChart');
        if (!canvas) return;
        var surface = setupCanvas(canvas);
        var ctx = surface.ctx;
        var box = { left: 54, top: 24, width: surface.width - 72, height: surface.height - 64 };
        var maxValue = Math.max.apply(null, rows.map(function(row) {
            return Number(row.success || 0) + Number(row.burn || 0);
        })) || 1;
        drawAxes(ctx, box, labels, maxValue);
        drawLegend(ctx, [
            { label: '成交量', color: '#0eaaa6' },
            { label: '交易销毁', color: '#b7791f' }
        ], box.left, 4);

        var groupWidth = box.width / rows.length;
        rows.forEach(function(row, index) {
            var x = box.left + index * groupWidth + groupWidth * 0.34;
            var barWidth = Math.max(14, groupWidth * 0.28);
            var successHeight = box.height * row.success / maxValue;
            var burnHeight = box.height * row.burn / maxValue;
            var baseY = box.top + box.height;

            ctx.fillStyle = 'rgba(14,170,166,0.78)';
            roundedRect(ctx, x, baseY - successHeight, barWidth, successHeight, 5);
            ctx.fill();

            ctx.fillStyle = 'rgba(183,121,31,0.66)';
            roundedRect(ctx, x, baseY - successHeight - burnHeight, barWidth, burnHeight + 3, 5);
            ctx.fill();
        });
    }

    function renderFallbackValueChart(labels, rows) {
        var canvas = $('#valueChart');
        if (!canvas) return;
        var surface = setupCanvas(canvas);
        var ctx = surface.ctx;
        var box = { left: 54, top: 24, width: surface.width - 72, height: surface.height - 64 };
        var values = rows.map(function(row) { return row.value; });
        var maxValue = Math.max.apply(null, values) || 1;
        drawAxes(ctx, box, labels, maxValue);
        drawLegend(ctx, [{ label: '成交价值', color: '#087c82' }], box.left, 4);

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
    }

    function searchTrade() {
        var input = $('#tradeSearchInput');
        var id = input ? input.value : '';
        var trade = findTrade(id);
        state.selectedTradeId = Number(id || 0);
        renderTradeResult(trade, id);
        renderTable();
        toast(trade ? '已读取本地订单 ' + id : '本地未采集订单 ' + id);
    }

    function fetchTrade() {
        var input = $('#tradeSearchInput');
        var id = Number(input && input.value || 0);
        if (!id) {
            toast('请输入订单 ID');
            return;
        }
        var trade = findTrade(id);
        if (!trade) {
            trade = {
                trade_id: id,
                create_time: '2026/6/17 12:16:02',
                seller_flow_number: '594351',
                single_price: 0.255,
                readonly_stock_count: 7800,
                mycancel: 780,
                success: 6318,
                success_value: 1611.09,
                buyers: [
                    { buyer_flow_number: '3735594', ak_amount: 2106 },
                    { buyer_flow_number: '3735593', ak_amount: 2106 },
                    { buyer_flow_number: '3735592', ak_amount: 2106 }
                ]
            };
            trades.unshift(trade);
        }
        state.selectedTradeId = id;
        renderTradeResult(trade, id);
        renderTable();
        toast('已模拟从上游抓取订单 ' + id);
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
                if (action === 'search-trade') searchTrade();
                if (action === 'fetch-trade') fetchTrade();
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
                var input = $('#tradeSearchInput');
                if (input) input.value = id;
                state.selectedTradeId = id;
                renderTradeResult(findTrade(id), id);
                renderTable();
            }
        });

        var input = $('#tradeSearchInput');
        if (input) {
            input.addEventListener('keydown', function(event) {
                if (event.key === 'Enter') searchTrade();
            });
        }
    }

    function init() {
        bindEvents();
        updateStatusCards();
        updateBackfill();
        renderTradeResult(findTrade(state.selectedTradeId), state.selectedTradeId);
        renderTable();
        renderCharts();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
