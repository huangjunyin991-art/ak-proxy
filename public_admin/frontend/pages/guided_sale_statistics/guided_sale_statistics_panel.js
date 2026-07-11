(function() {
    if (window.AKGuidedSaleStatisticsPanel) return;

    var api = window.AKGuidedSaleStatisticsApi;
    var renderer = window.AKGuidedSaleStatisticsRenderer;
    var state = { sourceAccount: '', data: null, loading: false, error: '', timer: null, bound: false };

    function mount() { return document.getElementById('guidedSaleStatisticsPanelMount'); }
    function active() { return !!document.querySelector('.tab.active[data-panel="guidedSaleStatistics"]'); }
    function render() { if (mount() && renderer) mount().innerHTML = renderer.render(state); }
    function toast(message, type) { if (typeof window.showToast === 'function') window.showToast(message, type || 'info'); }

    function schedule() {
        stopTimer();
        if (!active()) return;
        state.timer = window.setTimeout(function() { refresh(false); }, 10000);
    }

    function stopTimer() {
        if (state.timer) window.clearTimeout(state.timer);
        state.timer = null;
    }

    function refresh(showLoading) {
        if (!api) return Promise.resolve();
        if (showLoading) { state.loading = true; render(); }
        return api.dashboard(state.sourceAccount).then(function(data) {
            if (!state.sourceAccount && data.accounts && data.accounts.length) {
                state.sourceAccount = String(data.accounts[0].username || '');
                return api.dashboard(state.sourceAccount);
            }
            return data;
        }).then(function(data) {
            state.data = data || {};
            state.error = '';
        }).catch(function(error) {
            state.error = error.message || '指导销售统计加载失败';
        }).finally(function() {
            state.loading = false;
            render();
            schedule();
        });
    }

    function startScan() {
        if (!state.sourceAccount || !api) return;
        state.loading = true; render();
        api.start(state.sourceAccount).then(function(data) {
            state.data = data || {};
            state.error = '';
            toast('已加入自动获取队列', 'success');
        }).catch(function(error) {
            state.error = error.message || '任务创建失败';
            toast(state.error, 'error');
        }).finally(function() {
            state.loading = false; render(); schedule();
        });
    }

    function savePolicy() {
        var input = mount() && mount().querySelector('[data-field="cache_days"]');
        var days = Math.max(1, Math.min(365, Number(input && input.value || 30) || 30));
        api.savePolicy(days).then(function() {
            toast('缓存周期已更新', 'success');
            refresh(false);
        }).catch(function(error) { toast(error.message || '保存失败', 'error'); });
    }

    function bind() {
        if (state.bound || !mount()) return;
        state.bound = true;
        mount().addEventListener('change', function(event) {
            if (event.target && event.target.getAttribute('data-field') === 'source_account') {
                state.sourceAccount = String(event.target.value || '');
                refresh(true);
            }
        });
        mount().addEventListener('click', function(event) {
            var button = event.target.closest('[data-action]');
            if (!button) return;
            if (button.getAttribute('data-action') === 'start') startScan();
            if (button.getAttribute('data-action') === 'refresh') refresh(true);
            if (button.getAttribute('data-action') === 'save-policy') savePolicy();
        });
    }

    function start() { bind(); render(); if (!state.data && !state.loading) refresh(true); else schedule(); }
    window.AKGuidedSaleStatisticsPanel = { start: start, stop: stopTimer, refresh: function() { return refresh(true); } };
})();
