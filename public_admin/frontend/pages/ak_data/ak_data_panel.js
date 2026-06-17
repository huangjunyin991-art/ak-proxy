(function() {
    if (window.AKDataPanel) return;

    var api = window.AKDataApi;
    var storeFactory = window.AKDataStore;
    var renderer = window.AKDataRenderer;
    var store = storeFactory ? storeFactory.createStore() : null;
    var mounted = false;
    var querySeq = 0;
    var backfillPollingRegistered = false;
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
        mount.innerHTML = renderer.render(store.state);
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
                return panelActive() && store && store.state.backfill && store.state.backfill.status === 'running';
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
            max_account_switches: readNumber('akDataConfigMaxSwitch', cfg.max_account_switches || 5),
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
            render();
            return payload;
        }).catch(function(error) {
            store.setError(error.message || '回填状态读取失败');
            render();
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
