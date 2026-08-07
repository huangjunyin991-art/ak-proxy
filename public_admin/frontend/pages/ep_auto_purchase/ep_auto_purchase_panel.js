(function() {
    if (window.AKEPAutoPurchasePanel) return;
    var api = window.AKEPAutoPurchaseApi;
    var renderer = window.AKEPAutoPurchaseRenderer;
    var state = { data: {}, draftAccounts: null, error: '', loading: false, dirty: false, bound: false, timer: null, confirmingSid: '', cancellingSid: '' };

    function mount() { return document.getElementById('epAutoPurchasePanelMount'); }
    function active() { return !!document.querySelector('.tab.active[data-panel="epAutoPurchase"]'); }
    function toast(message, type) { if (window.showToast) window.showToast(message, type || 'info'); }
    function render() { var node = mount(); if (node) node.innerHTML = renderer.render(state); }

    function rowsFromData(data) {
        var config = data && data.config || {};
        var rows = Array.isArray(config.account_rows) ? config.account_rows : [];
        if (!rows.length && Array.isArray(config.accounts)) {
            rows = config.accounts.map(function(account) { return { account: account, has_password: false, has_trading_password: false }; });
        }
        return rows.map(function(item) {
            return {
                account: String(item.account || ''),
                password: '',
                trading_password: '',
                has_password: !!item.has_password,
                has_trading_password: !!item.has_trading_password,
                edit_password: false,
                edit_trading_password: false
            };
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
            var tradingPassword = row.querySelector('[data-field="trading-password"]');
            var normalizedAccount = String(account && account.value || '').trim();
            var sameAccount = String(previous.account || '').trim().toLowerCase() === normalizedAccount.toLowerCase();
            return {
                account: normalizedAccount,
                password: String(password ? password.value : (previous.password || '')),
                trading_password: String(tradingPassword ? tradingPassword.value : (previous.trading_password || '')),
                has_password: sameAccount && !!previous.has_password,
                has_trading_password: sameAccount && !!previous.has_trading_password,
                edit_password: !!previous.edit_password || !sameAccount,
                edit_trading_password: !!previous.edit_trading_password || !sameAccount
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
            return { account: item.account, password: item.password, trading_password: item.trading_password };
        });
        state.draftAccounts = collectAccountRows();
        state.loading = true;
        render();
        api.saveConfig({
            accounts: accounts,
            interval_seconds: intervalSeconds,
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
        var orders = state.data && state.data.orders || [];
        var order = orders.find(function(item) { return String(item.sid || '') === normalizedSid; }) || {};
        var accountRows = Array.isArray(config.account_rows) ? config.account_rows : [];
        var buyerAccount = String(order.buyer_account || '').trim().toLowerCase();
        var accountRow = accountRows.find(function(item) {
            return String(item.account || '').trim().toLowerCase() === buyerAccount;
        });
        if (!accountRow || !accountRow.has_trading_password) {
            toast('请先为抢分账号 ' + (buyerAccount || '--') + ' 设置交易密码', 'warning');
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

    function cancelPurchase(sid) {
        var normalizedSid = String(sid || '').trim();
        if (!normalizedSid || state.loading || state.confirmingSid || state.cancellingSid) return;
        var orders = state.data && state.data.orders || [];
        var order = orders.find(function(item) { return String(item.sid || '') === normalizedSid; }) || {};
        if (order.state !== 'success') return;
        if (!window.confirm('\u53d6\u6d88\u8d2d\u4e70\u540e\u53ef\u80fd\u5f71\u54cd\u5e10\u53f7\u4fe1\u7528\u503c\u3002\n\n\u786e\u8ba4\u53d6\u6d88\u8ba2\u5355 #' + normalizedSid + ' \u7684\u8d2d\u4e70\u5417\uff1f')) return;
        state.cancellingSid = normalizedSid;
        state.error = '';
        render();
        api.cancelPurchase(normalizedSid).then(function(result) {
            toast(result.message || '\u53d6\u6d88\u8d2d\u4e70\u6210\u529f', result.success ? 'success' : 'warning');
            return refresh(true);
        }).catch(function(error) {
            state.error = error.message || '\u53d6\u6d88\u8d2d\u4e70\u5931\u8d25';
            toast(state.error, 'error');
        }).finally(function() {
            state.cancellingSid = '';
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
            if (action === 'cancel-purchase') cancelPurchase(button.getAttribute('data-sid'));
            if (action === 'add-account') {
                state.draftAccounts = collectAccountRows();
                state.draftAccounts.push({
                    account: '', password: '', trading_password: '',
                    has_password: false, has_trading_password: false,
                    edit_password: true, edit_trading_password: true
                });
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
            if (action === 'edit-login-password' || action === 'edit-trading-password') {
                state.draftAccounts = collectAccountRows();
                var index = Number(button.getAttribute('data-index'));
                var field = action === 'edit-login-password' ? 'edit_password' : 'edit_trading_password';
                var selector = action === 'edit-login-password' ? '[data-field="password"]' : '[data-field="trading-password"]';
                if (state.draftAccounts[index]) state.draftAccounts[index][field] = true;
                state.dirty = true;
                render();
                var input = mount().querySelector('[data-account-row][data-index="' + index + '"] ' + selector);
                if (input) input.focus();
            }
        });
        mount().addEventListener('input', function(event) {
            if (!event.target.closest('[data-field]')) return;
            state.dirty = true;
        });
        mount().addEventListener('change', function(event) {
            if (!event.target.closest('[data-field]')) return;
            state.dirty = true;
            if (event.target.matches('[data-field="account"]')) {
                state.draftAccounts = collectAccountRows();
                render();
            }
        });
    }

    function start() { bind(); refresh(true); }
    window.AKEPAutoPurchasePanel = { start: start, stop: stop, refresh: function() { return refresh(true); } };
})();
