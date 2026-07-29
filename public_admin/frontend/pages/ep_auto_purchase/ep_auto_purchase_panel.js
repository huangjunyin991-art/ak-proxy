(function() {
    if (window.AKEPAutoPurchasePanel) return;
    var api = window.AKEPAutoPurchaseApi;
    var renderer = window.AKEPAutoPurchaseRenderer;
    var state = { data: {}, error: '', loading: false, dirty: false, bound: false, timer: null };

    function mount() { return document.getElementById('epAutoPurchasePanelMount'); }
    function active() { return !!document.querySelector('.tab.active[data-panel="epAutoPurchase"]'); }
    function toast(message, type) { if (window.showToast) window.showToast(message, type || 'info'); }
    function render() { var node = mount(); if (node) node.innerHTML = renderer.render(state); }

    function stop() {
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
    }

    function schedule() {
        stop();
        if (!active()) return;
        state.timer = setTimeout(function() { refresh(false); }, 2000);
    }

    function refresh(force) {
        if (!active()) return Promise.resolve();
        if (state.dirty && !force) { schedule(); return Promise.resolve(); }
        if (state.loading) return Promise.resolve();
        state.loading = force === true;
        if (state.loading) render();
        return api.dashboard().then(function(data) {
            state.data = data || {};
            state.error = '';
        }).catch(function(error) {
            state.error = error.message || 'EP 自动抢购加载失败';
        }).finally(function() {
            state.loading = false;
            render();
            schedule();
        });
    }

    function save() {
        var node = mount();
        if (!node || state.loading) return;
        var accountsInput = node.querySelector('[data-field="accounts"]');
        var intervalInput = node.querySelector('[data-field="interval"]');
        var enabledInput = node.querySelector('[data-field="enabled"]');
        var accounts = String(accountsInput && accountsInput.value || '').replace(/,/g, '\n').split(/\r?\n/).map(function(item) {
            return item.trim();
        }).filter(Boolean);
        state.loading = true;
        render();
        api.saveConfig({
            accounts: accounts,
            interval_seconds: Number(intervalInput && intervalInput.value || 1),
            enabled: !!(enabledInput && enabledInput.checked)
        }).then(function() {
            state.dirty = false;
            toast('EP 自动抢购配置已保存', 'success');
            return api.dashboard();
        }).then(function(data) {
            state.data = data || {};
            state.error = '';
        }).catch(function(error) {
            state.error = error.message || '保存失败';
            toast(state.error, 'error');
        }).finally(function() {
            state.loading = false;
            render();
            schedule();
        });
    }

    function bind() {
        if (state.bound || !mount()) return;
        state.bound = true;
        mount().addEventListener('click', function(event) {
            var button = event.target.closest('[data-action="save"]');
            if (button) save();
        });
        mount().addEventListener('input', function(event) {
            if (event.target.closest('[data-field]')) state.dirty = true;
        });
        mount().addEventListener('change', function(event) {
            if (event.target.closest('[data-field]')) state.dirty = true;
        });
    }

    function start() { bind(); refresh(true); }
    window.AKEPAutoPurchasePanel = { start: start, stop: stop, refresh: function() { return refresh(true); } };
})();
