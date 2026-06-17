(function() {
    if (window.AKDataPanel) return;

    var api = window.AKDataApi;
    var storeFactory = window.AKDataStore;
    var renderer = window.AKDataRenderer;
    var store = storeFactory ? storeFactory.createStore() : null;
    var mounted = false;
    var querySeq = 0;

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
            api.storage(),
            api.dashboard(store.state.dashboardDays),
            api.recentTrades(50)
        ]).then(function(results) {
            store.setBootstrap({
                status: results[0],
                storage: results[1] && results[1].rows,
                dashboard: results[2] && results[2].rows,
                recentTrades: results[3] && results[3].rows
            });
        }).catch(function(error) {
            store.setError(error.message || 'AK 数据加载失败');
            notify(store.state.error, 'error');
        }).finally(function() {
            store.state.loading = false;
            render();
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
    }

    window.AKDataPanel = {
        start: start,
        refresh: bootstrap
    };
})();
