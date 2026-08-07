(function() {
    if (window.AKEPAutoPurchasePanel) return;
    var api = window.AKEPAutoPurchaseApi;
    var renderer = window.AKEPAutoPurchaseRenderer;
    var state = { data: {}, draftAccounts: null, error: '', loading: false, dirty: false, bound: false, timer: null, confirmingSid: '' };

    function mount() { return document.getElementById('epAutoPurchasePanelMount'); }
    function active() { return !!document.querySelector('.tab.active[data-panel="epAutoPurchase"]'); }
    function toast(message, type) { if (window.showToast) window.showToast(message, type || 'info'); }
    function render() { var node = mount(); if (node) node.innerHTML = renderer.render(state); }

    function rowsFromData(data) {
        var config = data && data.config || {};
        var rows = Array.isArray(config.account_rows) ? config.account_rows : [];
        if (!rows.length && Array.isArray(config.accounts)) {
            rows = config.accounts.map(function(account) { return { account: account, has_password: false }; });
        }
        return rows.map(function(item) {
            return { account: String(item.account || ''), password: '', has_password: !!item.has_password };
        });
    }

    function acceptData(data) {
        state.data = data || {};
        state.draftAccounts = rowsFromData(state.data);
    }

    function collectAccountRows() {
        var node = mount();
        if (!node) return Array.isArray(state.draftAccounts) ? state.draftAccounts : [];
        return Array.prototype.map.call(node.querySelectorAll('[data-account-row]'), function(row, index) {
            var previous = state.draftAccounts && state.draftAccounts[index] || {};
            var account = row.querySelector('[data-field="account"]');
            var password = row.querySelector('[data-field="password"]');
            return {
                account: String(account && account.value || '').trim(),
                password: String(password && password.value || ''),
                has_password: String(previous.account || '').trim().toLowerCase() === String(account && account.value || '').trim().toLowerCase() && !!previous.has_password
            };
        });
    }

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
            acceptData(data);
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
        var intervalInput = node.querySelector('[data-field="interval"]');
        var enabledInput = node.querySelector('[data-field="enabled"]');
        var intervalSeconds = Number(intervalInput && intervalInput.value);
        var tradingPasswordInput = node.querySelector('[data-field="trading-password"]');
        var tradingPassword = String(tradingPasswordInput && tradingPasswordInput.value || '');
        var intervalMilliseconds = intervalSeconds * 1000;
        if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
            state.error = '抢分间隔必须大于 0 秒';
            toast(state.error, 'error');
            render();
            return;
        }
        if (intervalSeconds < 0.001 || Math.abs(intervalMilliseconds - Math.round(intervalMilliseconds)) > 1e-9) {
            state.error = '抢分间隔最多支持三位小数，最小为 0.001 秒';
            toast(state.error, 'error');
            render();
            return;
        }
        var accounts = collectAccountRows().filter(function(item) { return !!item.account; }).map(function(item) {
            return { account: item.account, password: item.password };
        });
        state.draftAccounts = collectAccountRows();
        state.loading = true;
        render();
        api.saveConfig({
            accounts: accounts,
            interval_seconds: intervalSeconds,
            trading_password: tradingPassword,
            enabled: !!(enabledInput && enabledInput.checked)
        }).then(function() {
            state.dirty = false;
            toast('EP 自动抢购配置已保存', 'success');
            return api.dashboard();
        }).then(function(data) {
            acceptData(data);
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

    function confirmPayment(sid) {
        var normalizedSid = String(sid || '').trim();
        if (!normalizedSid || state.loading || state.confirmingSid) return;
        var config = state.data && state.data.config || {};
        if (!config.has_trading_password) {
            toast('请先在执行配置中设置交易密码', 'warning');
            return;
        }
        if (!window.confirm('确认订单 #' + normalizedSid + ' 已完成实际付款？')) return;
        state.confirmingSid = normalizedSid;
        state.error = '';
        render();
        api.confirmPayment(normalizedSid).then(function(result) {
            toast(result.message || '确认付款成功', result.success ? 'success' : 'warning');
            return refresh(true);
        }).catch(function(error) {
            state.error = error.message || '确认付款失败';
            toast(state.error, 'error');
        }).finally(function() {
            state.confirmingSid = '';
            render();
        });
    }

    function bind() {
        if (state.bound || !mount()) return;
        state.bound = true;
        mount().addEventListener('click', function(event) {
            var button = event.target.closest('[data-action]');
            if (!button) return;
            var action = button.getAttribute('data-action');
            if (action === 'save') save();
            if (action === 'confirm-payment') confirmPayment(button.getAttribute('data-sid'));
            if (action === 'add-account') {
                state.draftAccounts = collectAccountRows();
                state.draftAccounts.push({ account: '', password: '', has_password: false });
                state.dirty = true;
                render();
                var inputs = mount().querySelectorAll('[data-field="account"]');
                if (inputs.length) inputs[inputs.length - 1].focus();
            }
            if (action === 'remove-account') {
                state.draftAccounts = collectAccountRows();
                state.draftAccounts.splice(Number(button.getAttribute('data-index')), 1);
                state.dirty = true;
                render();
            }
        });
        mount().addEventListener('input', function(event) {
            if (!event.target.closest('[data-field]')) return;
            state.dirty = true;
            if (event.target.matches('[data-field="password"]')) {
                var row = event.target.closest('[data-account-row]');
                var badge = row && row.querySelector('[data-password-state]');
                if (badge && event.target.value) {
                    badge.className = 'ak-ep-credential-state is-pending';
                    badge.innerHTML = '<i></i>待更新';
                }
            }
            if (event.target.matches('[data-field="account"]')) {
                var accountRow = event.target.closest('[data-account-row]');
                var accountIndex = Number(accountRow && accountRow.getAttribute('data-index'));
                var previous = state.draftAccounts && state.draftAccounts[accountIndex] || {};
                if (String(previous.account || '').trim().toLowerCase() !== String(event.target.value || '').trim().toLowerCase()) {
                    var passwordInput = accountRow && accountRow.querySelector('[data-field="password"]');
                    var status = accountRow && accountRow.querySelector('[data-password-state]');
                    if (passwordInput && !passwordInput.value) passwordInput.placeholder = '请输入登录密码';
                    if (status && !(passwordInput && passwordInput.value)) {
                        status.className = 'ak-ep-credential-state is-missing';
                        status.innerHTML = '<i></i>需要密码';
                    }
                }
            }
        });
        mount().addEventListener('change', function(event) {
            if (event.target.closest('[data-field]')) state.dirty = true;
        });
    }

    function start() { bind(); refresh(true); }
    window.AKEPAutoPurchasePanel = { start: start, stop: stop, refresh: function() { return refresh(true); } };
})();
