(function() {
    if (window.AKSellLedgerPanel) return;
    var api = window.AKSellLedgerApi, renderer = window.AKSellLedgerRenderer;
    var state = { data: {}, filters: { account: '', source: '', page: 1, page_size: 50 }, error: '', loading: false, bound: false };
    function mount() { return document.getElementById('akSellLedgerPanelMount'); }
    function active() { return !!document.querySelector('.tab.active[data-panel="akSellLedger"]'); }
    function toast(message, type) { if (window.showToast) window.showToast(message, type || 'info'); }
    function render() { var node = mount(); if (node) node.innerHTML = renderer.render(state); }
    function refresh() {
        if (!active() || state.loading) return;
        state.loading = true; render();
        api.dashboard(state.filters).then(function(data) { state.data = data || {}; if (data.pagination && data.pagination.page) state.filters.page = Number(data.pagination.page); state.error = ''; }).catch(function(error) { state.error = error.message || '加载失败'; }).finally(function() { state.loading = false; render(); });
    }
    function bind() {
        if (state.bound || !mount()) return;
        state.bound = true;
        mount().addEventListener('click', function(event) {
            var button = event.target.closest('[data-action]'); if (!button) return;
            var action = button.getAttribute('data-action');
            if (action === 'refresh' || action === 'query') {
                var node = mount(); state.filters.account = (node.querySelector('[data-field="account"]') || {}).value || ''; state.filters.source = (node.querySelector('[data-field="source"]') || {}).value || ''; if (action === 'query') state.filters.page = 1; refresh();
            }
            if (action === 'prev') { state.filters.page = Math.max(1, Number(state.filters.page || 1) - 1); refresh(); }
            if (action === 'next') { state.filters.page = Number(state.filters.page || 1) + 1; refresh(); }
            if (action === 'save-config') {
                var input = mount().querySelector('[data-field="retention"]'), days = Number(input && input.value);
                if (!Number.isInteger(days) || days < 1 || days > 3650) { toast('保留天数必须在 1 到 3650 之间', 'error'); return; }
                api.saveConfig(days).then(function() { toast('保留天数已保存', 'success'); refresh(); }).catch(function(error) { toast(error.message || '保存失败', 'error'); });
            }
            if (action === 'cleanup') {
                if (!window.confirm('将按当前保留天数永久删除过期卖出流水，是否继续？')) return;
                api.cleanup().then(function(result) {
                    var deleted = Number(result.deleted || 0);
                    var deletedAttempts = Number(result.deleted_attempts || 0);
                    toast('已清理 ' + deleted.toLocaleString('zh-CN') + ' 条流水、' + deletedAttempts.toLocaleString('zh-CN') + ' 条追踪', 'success');
                    refresh();
                }).catch(function(error) { toast(error.message || '清理失败', 'error'); });
            }
        });
    }
    function start() { bind(); refresh(); }
    window.AKSellLedgerPanel = { start: start, refresh: refresh };
})();
