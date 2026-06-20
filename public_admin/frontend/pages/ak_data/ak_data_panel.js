(function() {
    if (window.AKDataPanel) return;

    var api = window.AKDataApi;
    var storeFactory = window.AKDataStore;
    var renderer = window.AKDataRenderer;
    var store = storeFactory ? storeFactory.createStore() : null;
    var mounted = false;
    var querySeq = 0;
    var backfillPollingRegistered = false;
    var echartsPromise = null;
    var tradeChart = null;
    var dealChart = null;
    var BACKFILL_POLL_OWNER = 'panel:akData';
    var BACKFILL_POLL_ID = 'akData:backfillStatus';

    function mountNode() {
        return document.getElementById('akDataPanelMount');
    }

    function isMobile() {
        return window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
    }

    function notify(message, type) {
        if (isMobile()) return;
        try {
            if (typeof window.showToast === 'function') window.showToast(message, type || 'info');
        } catch (e) {}
    }

    function render() {
        var mount = mountNode();
        if (!mount || !store || !renderer) return;
        disposeCharts();
        mount.innerHTML = renderer.render(store.state);
        renderCharts();
    }

    function refreshStatusBlocks() {
        if (!store || !renderer) return;
        var metrics = document.querySelector('.akd-metrics');
        var backfillStatus = document.querySelector('.akd-backfill-status');
        var backfillMessage = document.querySelector('.akd-backfill-head span');
        if (metrics && typeof renderer.renderMetrics === 'function') {
            metrics.innerHTML = renderer.renderMetrics(store.state);
        }
        if (backfillStatus && typeof renderer.renderBackfillStatus === 'function') {
            backfillStatus.innerHTML = renderer.renderBackfillStatus(store.state);
        }
        if (backfillMessage) {
            backfillMessage.textContent = (store.state.backfill && store.state.backfill.message) || '未启动';
        }
    }

    function disposeCharts() {
        try {
            if (tradeChart) tradeChart.dispose();
            if (dealChart) dealChart.dispose();
        } catch (e) {}
        tradeChart = null;
        dealChart = null;
    }

    function ensureEcharts() {
        if (window.echarts) return Promise.resolve(window.echarts);
        if (echartsPromise) return echartsPromise;
        echartsPromise = new Promise(function(resolve, reject) {
            var script = document.createElement('script');
            script.src = '/admin/api/shared/lib/echarts.min.js?v=20260618';
            script.async = true;
            script.onload = function() {
                if (window.echarts) resolve(window.echarts);
                else reject(new Error('ECharts 加载失败'));
            };
            script.onerror = function() {
                reject(new Error('ECharts 加载失败'));
            };
            document.head.appendChild(script);
        });
        return echartsPromise;
    }

    function formatNumber(value, digits) {
        var num = Number(value || 0);
        return num.toLocaleString('zh-CN', {
            minimumFractionDigits: digits || 0,
            maximumFractionDigits: digits || 0
        });
    }

    function formatPrice(value) {
        return Number(value || 0).toFixed(3);
    }

    function chartDayText(value) {
        var text = String(value || '');
        var match = text.match(/(\d{4})-(\d{2})-(\d{2})/);
        return match ? match[2] + '-' + match[3] : text.slice(0, 10);
    }

    function chartRows() {
        var rows = (store && store.state && Array.isArray(store.state.dashboard)) ? store.state.dashboard.slice() : [];
        return rows.sort(function(a, b) {
            return String(a.date_key || '').localeCompare(String(b.date_key || ''));
        });
    }

    function toggleChartEmpty(containerId, emptyId, hasData) {
        var container = document.getElementById(containerId);
        var empty = document.getElementById(emptyId);
        if (container) container.style.display = hasData ? 'block' : 'none';
        if (empty) empty.style.display = hasData ? 'none' : 'block';
    }

    function renderCharts() {
        var tradeEl = document.getElementById('akDataTradeChart');
        var dealEl = document.getElementById('akDataDealChart');
        if (!tradeEl || !dealEl || !store) return;
        var rows = chartRows();
        var hasData = rows.length > 0;
        toggleChartEmpty('akDataTradeChart', 'akDataTradeChartEmpty', hasData);
        toggleChartEmpty('akDataDealChart', 'akDataDealChartEmpty', hasData);
        if (!hasData) return;
        ensureEcharts().then(function(echarts) {
            if (!document.getElementById('akDataTradeChart') || !document.getElementById('akDataDealChart')) return;
            if (!tradeChart) tradeChart = echarts.init(document.getElementById('akDataTradeChart'), null, { renderer: 'canvas' });
            if (!dealChart) dealChart = echarts.init(document.getElementById('akDataDealChart'), null, { renderer: 'canvas' });
            setTradeChartOption(rows);
            setDealChartOption(rows);
            setTimeout(function() {
                if (tradeChart) tradeChart.resize();
                if (dealChart) dealChart.resize();
            }, 0);
        }).catch(function(error) {
            notify(error.message || '图表加载失败', 'error');
        });
    }

    function setTradeChartOption(rows) {
        if (!tradeChart) return;
        var labels = rows.map(function(row) { return chartDayText(row.date_key); });
        var stock = rows.map(function(row) { return Number(row.total_stock || 0); });
        var success = rows.map(function(row) { return Number(row.total_success || 0); });
        var burn = rows.map(function(row) { return Number(row.total_mycancel || 0); });
        var fee = rows.map(function(row) { return Number(row.platform_gap || 0); });
        tradeChart.setOption({
            color: ['#30c5bd', '#c8a05a', '#d8737b'],
            grid: { left: 70, right: 22, top: 58, bottom: 40, containLabel: false },
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'shadow' },
                backgroundColor: 'rgba(6,20,28,0.96)',
                borderColor: 'rgba(79,199,194,0.30)',
                borderWidth: 1,
                padding: [10, 12],
                extraCssText: 'box-shadow:0 14px 30px rgba(0,0,0,.34);border-radius:8px;',
                textStyle: { color: '#dff8f2', fontSize: 12, fontWeight: 700, lineHeight: 20 },
                formatter: function(items) {
                    var idx = items && items[0] ? items[0].dataIndex : 0;
                    return [
                        '<b>' + labels[idx] + '</b>',
                        '挂卖量：' + formatNumber(stock[idx]),
                        '成交量：' + formatNumber(success[idx]),
                        '交易销毁：' + formatNumber(burn[idx]),
                        '手续费扣除：' + formatNumber(fee[idx])
                    ].join('<br>');
                }
            },
            legend: {
                top: 8,
                left: 'center',
                itemWidth: 12,
                itemHeight: 12,
                itemGap: 20,
                icon: 'roundRect',
                textStyle: { color: 'rgba(211,236,235,0.82)', fontSize: 12, fontWeight: 800 },
                data: ['成交量', '交易销毁', '手续费扣除']
            },
            xAxis: {
                type: 'category',
                data: labels,
                axisTick: { show: false },
                axisLine: { lineStyle: { color: 'rgba(175,215,216,0.22)' } },
                axisLabel: { color: 'rgba(216,236,236,0.76)', fontSize: 12, margin: 12, fontWeight: 700 }
            },
            yAxis: {
                type: 'value',
                splitLine: { lineStyle: { color: 'rgba(175,215,216,0.10)' } },
                axisLabel: {
                    color: 'rgba(178,211,214,0.70)',
                    fontSize: 11,
                    formatter: function(value) { return formatNumber(value); }
                }
            },
            series: [
                { name: '成交量', type: 'bar', stack: 'trade', data: success, barWidth: '58%', barMaxWidth: 78, itemStyle: { opacity: 0.86 }, emphasis: { focus: 'series' } },
                { name: '交易销毁', type: 'bar', stack: 'trade', data: burn, barWidth: '58%', barMaxWidth: 78, itemStyle: { opacity: 0.82 }, emphasis: { focus: 'series' } },
                { name: '手续费扣除', type: 'bar', stack: 'trade', data: fee, barWidth: '58%', barMaxWidth: 78, itemStyle: { opacity: 0.84, borderRadius: [7, 7, 0, 0] }, emphasis: { focus: 'series' } }
            ]
        }, true);
    }

    function setDealChartOption(rows) {
        if (!dealChart) return;
        var labels = rows.map(function(row) { return chartDayText(row.date_key); });
        var values = rows.map(function(row) { return Number(row.total_success_value || 0); });
        var prices = rows.map(function(row) {
            var success = Number(row.total_success || 0);
            var value = Number(row.total_success_value || 0);
            return success > 0 ? Number((value / success).toFixed(3)) : 0;
        });
        dealChart.setOption({
            color: ['#0ea8a5', '#c0903f'],
            grid: { left: 70, right: 54, top: 58, bottom: 40, containLabel: false },
            tooltip: {
                trigger: 'axis',
                backgroundColor: 'rgba(6,20,28,0.96)',
                borderColor: 'rgba(79,199,194,0.30)',
                borderWidth: 1,
                padding: [10, 12],
                extraCssText: 'box-shadow:0 14px 30px rgba(0,0,0,.34);border-radius:8px;',
                textStyle: { color: '#dff8f2', fontSize: 12, fontWeight: 700, lineHeight: 20 },
                formatter: function(items) {
                    var idx = items && items[0] ? items[0].dataIndex : 0;
                    return [
                        '<b>' + labels[idx] + '</b>',
                        '成交价值：' + formatNumber(values[idx], 2),
                        '成交价格：' + formatPrice(prices[idx])
                    ].join('<br>');
                }
            },
            legend: {
                top: 8,
                left: 'center',
                itemWidth: 13,
                itemHeight: 10,
                itemGap: 22,
                textStyle: { color: 'rgba(211,236,235,0.82)', fontSize: 12, fontWeight: 800 },
                data: ['成交价值', '成交价格']
            },
            xAxis: {
                type: 'category',
                data: labels,
                axisTick: { show: false },
                boundaryGap: false,
                axisLine: { lineStyle: { color: 'rgba(175,215,216,0.22)' } },
                axisLabel: { color: 'rgba(216,236,236,0.76)', fontSize: 12, margin: 12, fontWeight: 700 }
            },
            yAxis: [
                {
                    type: 'value',
                    splitLine: { lineStyle: { color: 'rgba(175,215,216,0.10)' } },
                    axisLabel: {
                        color: 'rgba(178,211,214,0.70)',
                        fontSize: 11,
                        formatter: function(value) { return formatNumber(value); }
                    }
                },
                {
                    type: 'value',
                    position: 'right',
                    min: function(value) { return Math.max(0, Number(value.min || 0) - 0.002); },
                    max: function(value) { return Number(value.max || 0) + 0.002; },
                    splitLine: { show: false },
                    axisLabel: { color: 'rgba(218,177,100,0.88)', fontSize: 11, formatter: function(value) { return formatPrice(value); } }
                }
            ],
            series: [
                {
                    name: '成交价值',
                    type: 'line',
                    data: values,
                    yAxisIndex: 0,
                    smooth: true,
                    symbol: 'circle',
                    symbolSize: 6,
                    lineStyle: { width: 3.4, color: '#0ea8a5' },
                    itemStyle: { color: '#0ea8a5', borderColor: '#b8f1ed', borderWidth: 1 },
                    areaStyle: {
                        color: {
                            type: 'linear',
                            x: 0,
                            y: 0,
                            x2: 0,
                            y2: 1,
                            colorStops: [
                                { offset: 0, color: 'rgba(48,197,189,0.26)' },
                                { offset: 1, color: 'rgba(48,197,189,0.03)' }
                            ]
                        }
                    }
                },
                {
                    name: '成交价格',
                    type: 'line',
                    data: prices,
                    yAxisIndex: 1,
                    smooth: true,
                    symbol: 'circle',
                    symbolSize: 6,
                    lineStyle: { width: 3.2, color: '#c0903f' },
                    itemStyle: { color: '#c0903f', borderColor: '#f2d394', borderWidth: 1 }
                }
            ]
        }, true);
    }

    function bootstrap() {
        if (!api || !store) return Promise.resolve();
        store.state.loading = true;
        store.state.lastMessage = '正在读取 AK 数据...';
        render();
        return Promise.all([
            api.status(),
            api.config(),
            api.storage(),
            api.dashboard(store.state.dashboardDays),
            api.recentTrades(50)
        ]).then(function(results) {
            store.setBootstrap({
                status: results[0],
                backfill: results[0] && results[0].backfill,
                config: results[1] && results[1].item,
                storage: results[2] && results[2].rows,
                dashboard: results[3] && results[3].rows,
                recentTrades: results[4] && results[4].rows
            });
            ensureBackfillPolling();
        }).catch(function(error) {
            store.setError(error.message || 'AK 数据加载失败');
            notify(store.state.error, 'error');
        }).finally(function() {
            store.state.loading = false;
            render();
        });
    }

    function panelActive() {
        return !!document.querySelector('.tab.active[data-panel="akData"]');
    }

    function ensureBackfillPolling() {
        var registry = window.AKPollingRegistry;
        if (!registry || backfillPollingRegistered) return;
        registry.register({
            id: BACKFILL_POLL_ID,
            owner: BACKFILL_POLL_OWNER,
            intervalMs: 2000,
            jitterMs: 300,
            immediate: false,
            dedupeKey: BACKFILL_POLL_ID,
            runWhen: function() {
                return panelActive() && store && store.state.backfill && ['running', 'cooldown'].indexOf(store.state.backfill.status) !== -1;
            },
            task: refreshBackfillStatus
        });
        backfillPollingRegistered = true;
        registry.startOwner(BACKFILL_POLL_OWNER);
    }

    function readNumber(id, fallback) {
        var node = document.getElementById(id);
        var value = node ? Number(node.value || fallback || 0) : Number(fallback || 0);
        return isFinite(value) ? value : Number(fallback || 0);
    }

    function readText(id, fallback) {
        var node = document.getElementById(id);
        return String(node ? node.value : (fallback || '')).trim();
    }

    function readConfigPayload() {
        var cfg = store.state.config || {};
        return {
            enabled: !!cfg.enabled,
            request_interval_ms: readNumber('akDataConfigRequestInterval', cfg.request_interval_ms || 1000),
            fallback_username: readText('akDataConfigFallback', cfg.fallback_username || ''),
            summary_retention_days: readNumber('akDataConfigSummaryRetention', cfg.summary_retention_days || 365),
            buyer_retention_days: readNumber('akDataConfigBuyerRetention', cfg.buyer_retention_days || 30),
            post_task_check_interval_minutes: readNumber('akDataConfigCheckInterval', cfg.post_task_check_interval_minutes || 60),
            forbidden_cooldown_seconds: readNumber('akDataConfigForbiddenCooldown', cfg.forbidden_cooldown_seconds || 300),
            retry_rounds: readNumber('akDataConfigRetryRounds', cfg.retry_rounds || 10),
            pipeline_concurrency: readNumber('akDataConfigPipelineConcurrency', cfg.pipeline_concurrency || 2),
            save_buyers: cfg.save_buyers !== false,
            buyer_page_size: readNumber('akDataConfigBuyerPageSize', cfg.buyer_page_size || 15),
            buyer_max_pages: readNumber('akDataConfigBuyerMaxPages', cfg.buyer_max_pages || 20),
            default_target_date: readText('akDataConfigTargetDate', cfg.default_target_date || '2026-05-29'),
            base_stat_date: readText('akDataConfigBaseDate', cfg.base_stat_date || '2026-06-01'),
            upstream_base_url: readText('akDataConfigUpstreamBase', cfg.upstream_base_url || 'http://127.0.0.1:8080'),
            upstream_public_origin: cfg.upstream_public_origin || 'https://ak2025.vip',
            upstream_host_header: readText('akDataConfigUpstreamHost', cfg.upstream_host_header || 'ak2025.vip'),
            upstream_timeout_seconds: readNumber('akDataConfigTimeout', cfg.upstream_timeout_seconds || 12),
            upstream_retry_attempts: 1,
            upstream_retry_backoff_ms: readNumber('akDataConfigRetryBackoff', cfg.upstream_retry_backoff_ms || 1200)
        };
    }

    function saveConfig() {
        if (!api || !store) return;
        api.saveConfig(readConfigPayload()).then(function(payload) {
            store.setConfig(payload);
            notify(payload.message || 'AK 数据配置已保存', 'success');
            render();
        }).catch(function(error) {
            notify(error.message || '保存配置失败', 'error');
        });
    }

    function toggleConfig(key) {
        store.state.config = store.state.config || {};
        store.state.config[key] = !store.state.config[key];
        render();
    }

    function readBackfillPayload() {
        return {
            start_trade_id: readNumber('akDataBackfillStartId', 0),
            target_date: readText('akDataBackfillTargetDate', (store.state.config && store.state.config.default_target_date) || '2026-05-29'),
            request_interval_ms: readNumber('akDataBackfillInterval', (store.state.config && store.state.config.request_interval_ms) || 1000)
        };
    }

    function startBackfill() {
        if (!api || !store) return;
        api.startBackfill(readBackfillPayload()).then(function(payload) {
            store.setBackfill(payload);
            ensureBackfillPolling();
            notify(payload.message || '历史回填已启动', payload.success === false ? 'error' : 'success');
            render();
        }).catch(function(error) {
            notify(error.message || '历史回填启动失败', 'error');
        });
    }

    function startProbe() {
        if (!api || !store) return;
        var payload = readBackfillPayload();
        payload.limit = readNumber('akDataProbeLimit', 300);
        api.startProbe(payload).then(function(result) {
            store.setBackfill(result);
            ensureBackfillPolling();
            notify(result.message || '限流探测已启动', result.success === false ? 'error' : 'success');
            render();
        }).catch(function(error) {
            notify(error.message || '限流探测启动失败', 'error');
        });
    }

    function pauseBackfill() {
        if (!api || !store) return;
        api.pauseBackfill().then(function(payload) {
            store.setBackfill(payload);
            notify(payload.message || '任务正在停止', 'info');
            render();
        }).catch(function(error) {
            notify(error.message || '暂停失败', 'error');
        });
    }

    function refreshBackfillStatus() {
        if (!api || !store) return Promise.resolve();
        return api.backfillStatus().then(function(payload) {
            store.setBackfill(payload);
            refreshStatusBlocks();
            return payload;
        }).catch(function(error) {
            store.setError(error.message || '回填状态读取失败');
            refreshStatusBlocks();
        });
    }

    function cleanupData() {
        if (!api || !store) return;
        api.cleanup().then(function(payload) {
            notify('清理完成：订单 ' + (payload.removed_summary || 0) + '，买家 ' + (payload.removed_buyers || 0), 'success');
            bootstrap();
        }).catch(function(error) {
            notify(error.message || '清理失败', 'error');
        });
    }

    function runQuery() {
        if (!api || !store) return;
        var type = document.getElementById('akDataQueryType');
        var input = document.getElementById('akDataAccountId');
        store.state.queryType = type ? type.value : 'seller';
        store.state.accountId = input ? String(input.value || '').trim() : '';
        store.state.queryLoading = true;
        store.state.tableMode = 'orders';
        var seq = ++querySeq;
        render();
        notify('查询任务已提交，后台正在检索交易订单', 'info');
        api.accountQuery({
            queryType: store.state.queryType,
            accountId: store.state.accountId,
            limit: 500
        }).then(function(payload) {
            if (seq !== querySeq) return;
            store.setQueryResult(payload || {});
            notify(store.state.lastMessage, store.state.visibleTrades.length ? 'success' : 'warning');
        }).catch(function(error) {
            if (seq !== querySeq) return;
            store.state.queryLoading = false;
            store.setError(error.message || '查询失败');
            notify(store.state.error, 'error');
        }).finally(function() {
            if (seq === querySeq) render();
        });
    }

    function loadRange(days) {
        if (!api || !store) return;
        var targetDays = Number(days || 7);
        store.state.dashboardDays = targetDays;
        render();
        api.dashboard(targetDays).then(function(payload) {
            store.setDashboard(targetDays, payload && payload.rows);
        }).catch(function(error) {
            store.setError(error.message || '日统计加载失败');
            notify(store.state.error, 'error');
        }).finally(render);
    }

    function loadBuyers(tradeId) {
        if (!api || !store || !tradeId) return;
        store.state.buyerLoading = true;
        store.state.buyerError = '';
        store.state.selectedTradeId = Number(tradeId || 0);
        store.state.tableMode = 'buyers';
        render();
        api.tradeBuyers(tradeId).then(function(payload) {
            store.setBuyerRows(tradeId, payload && payload.rows);
        }).catch(function(error) {
            store.state.buyerLoading = false;
            store.state.buyerError = error.message || '买家明细加载失败';
            notify(store.state.buyerError, 'error');
        }).finally(render);
    }

    function handleAction(target) {
        var node = target.closest('[data-action]');
        if (!node || !store) return;
        var action = node.getAttribute('data-action');
        if (action === 'refresh') {
            bootstrap();
        } else if (action === 'search') {
            runQuery();
        } else if (action === 'reset') {
            store.resetToRecent();
            render();
        } else if (action === 'range') {
            loadRange(node.getAttribute('data-days') || 7);
        } else if (action === 'trade-buyers') {
            loadBuyers(node.getAttribute('data-trade-id'));
        } else if (action === 'back-orders') {
            store.state.tableMode = 'orders';
            store.state.buyerRows = [];
            render();
        } else if (action === 'save-config') {
            saveConfig();
        } else if (action === 'toggle-config') {
            toggleConfig(node.getAttribute('data-key') || '');
        } else if (action === 'start-backfill') {
            startBackfill();
        } else if (action === 'pause-backfill') {
            pauseBackfill();
        } else if (action === 'start-probe') {
            startProbe();
        } else if (action === 'cleanup') {
            cleanupData();
        }
    }

    function bindEvents() {
        var mount = mountNode();
        if (!mount || mounted) return;
        mounted = true;
        mount.addEventListener('click', function(event) {
            handleAction(event.target);
        });
        mount.addEventListener('keydown', function(event) {
            if (event.target && event.target.id === 'akDataAccountId' && event.key === 'Enter') {
                event.preventDefault();
                runQuery();
            }
        });
        window.addEventListener('resize', function() {
            if (tradeChart) tradeChart.resize();
            if (dealChart) dealChart.resize();
        });
    }

    function start() {
        if (!api || !storeFactory || !renderer || !store) {
            var mount = mountNode();
            if (mount) mount.innerHTML = '<div class="akd-module-error">AK 数据模块依赖加载失败，请强制刷新后重试</div>';
            return;
        }
        bindEvents();
        render();
        if (!store.state.status && !store.state.loading) bootstrap();
        ensureBackfillPolling();
    }

    window.AKDataPanel = {
        start: start,
        refresh: bootstrap
    };
})();
