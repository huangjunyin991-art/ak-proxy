(function() {
    if (window.AKGuidedSaleStatisticsPanel) return;

    var api = window.AKGuidedSaleStatisticsApi;
    var renderer = window.AKGuidedSaleStatisticsRenderer;
    var state = { data: null, loading: false, error: '', timer: null, bound: false };

    function mount() { return document.getElementById('guidedSaleStatisticsPanelMount'); }
    function active() { return !!document.querySelector('.tab.active[data-panel="guidedSaleStatistics"]'); }
    function render() { if (mount() && renderer) mount().innerHTML = renderer.render(state); }
    function toast(message, type) { if (typeof window.showToast === 'function') window.showToast(message, type || 'info'); }

    function stopTimer() {
        if (state.timer) window.clearTimeout(state.timer);
        state.timer = null;
    }

    function schedule() {
        stopTimer();
        if (!active()) return;
        state.timer = window.setTimeout(function() { refresh(false); }, 10000);
    }

    function refresh(showLoading) {
        if (!api) return Promise.resolve();
        if (showLoading) { state.loading = true; render(); }
        return api.dashboard().then(function(data) {
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
        if (!api) return;
        state.loading = true;
        render();
        api.startScan().then(function(data) {
            state.data = data || {};
            state.error = '';
            toast('子账号扫描任务已创建', 'success');
        }).catch(function(error) {
            state.error = error.message || '创建子账号扫描任务失败';
            toast(state.error, 'error');
        }).finally(function() {
            state.loading = false;
            render();
            schedule();
        });
    }

    function saveSource() {
        var input = mount() && mount().querySelector('[data-field="source_account"]');
        var account = String(input && input.value || '').trim().toLowerCase();
        if (!account) {
            state.error = '请输入全局绑定账号';
            render();
            return;
        }
        state.loading = true;
        render();
        api.saveSource(account).then(function() {
            toast('全局绑定账号已保存', 'success');
            return api.dashboard();
        }).then(function(data) {
            state.data = data || {};
            state.error = '';
        }).catch(function(error) {
            state.error = error.message || '保存来源账号失败';
            toast(state.error, 'error');
        }).finally(function() {
            state.loading = false;
            render();
            schedule();
        });
    }

    function savePolicy() {
        var input = mount() && mount().querySelector('[data-field="cache_days"]');
        var days = Math.max(1, Math.min(365, Number(input && input.value || 30) || 30));
        api.savePolicy(days).then(function() {
            toast('扫描结果保留周期已更新', 'success');
            refresh(false);
        }).catch(function(error) { toast(error.message || '保存失败', 'error'); });
    }

    function bind() {
        if (state.bound || !mount()) return;
        state.bound = true;
        mount().addEventListener('click', function(event) {
            var button = event.target.closest('[data-action]');
            if (!button) return;
            var action = button.getAttribute('data-action');
            if (action === 'start-scan') startScan();
            if (action === 'save-source') saveSource();
            if (action === 'save-policy') savePolicy();
        });
    }

    function start() { bind(); if (!state.loading) refresh(true); }
    window.AKGuidedSaleStatisticsPanel = { start: start, stop: stopTimer, refresh: function() { return refresh(true); } };
})();
