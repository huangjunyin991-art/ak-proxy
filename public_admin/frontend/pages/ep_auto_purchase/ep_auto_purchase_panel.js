(function() {
    if (window.AKEPAutoPurchasePanel) return;
    var api = window.AKEPAutoPurchaseApi;
    var renderer = window.AKEPAutoPurchaseRenderer;
    var state = { data: {}, draftAccounts: null, error: '', loading: false, dirty: false, bound: false, timer: null, autosaveTimer: null, confirmingSid: '', cancellingSid: '', confirmationOpen: false };

    function mount() { return document.getElementById('epAutoPurchasePanelMount'); }
    function active() { return !!document.querySelector('.tab.active[data-panel="epAutoPurchase"]'); }
    function toast(message, type) { if (window.showToast) window.showToast(message, type || 'info'); }
    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function confirmOrderAction(kind, sid) {
        if (state.confirmationOpen) return Promise.resolve(false);
        state.confirmationOpen = true;
        var isCancel = kind === 'cancel';
        var title = isCancel ? '\u53d6\u6d88\u8d2d\u4e70' : '\u786e\u8ba4\u4ed8\u6b3e';
        var description = isCancel
            ? '\u786e\u8ba4\u53d6\u6d88\u8ba2\u5355 #' + escapeHtml(sid) + ' \u7684\u8d2d\u4e70\uff1f'
            : '\u8bf7\u786e\u8ba4\u8ba2\u5355 #' + escapeHtml(sid) + ' \u5df2\u5b8c\u6210\u5b9e\u9645\u4ed8\u6b3e\u3002';
        var note = isCancel
            ? '\u53d6\u6d88\u8d2d\u4e70\u4f1a\u964d\u4f4e\u8d26\u53f7\u4fe1\u7528\u503c\uff0c\u8bf7\u4ec5\u5728\u786e\u5b9a\u65e0\u6cd5\u4ed8\u6b3e\u65f6\u64cd\u4f5c\u3002'
            : '\u786e\u8ba4\u4ed8\u6b3e\u540e\u5c06\u65e0\u6cd5\u53d6\u6d88\u8d2d\u4e70\uff0c\u8bf7\u4ec5\u5728\u5b9e\u9645\u5b8c\u6210\u4ed8\u6b3e\u540e\u64cd\u4f5c\u3002';
        var confirmText = isCancel ? '\u786e\u8ba4\u53d6\u6d88' : '\u786e\u8ba4\u4ed8\u6b3e';
        var icon = isCancel
            ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/><path d="M5 12a7 7 0 1 0 2.05-4.95"/><path d="M5 5v4h4"/></svg>'
            : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.2 17 19 7"/><path d="M12 3.5a8.5 8.5 0 1 1-8.5 8.5"/></svg>';

        return new Promise(function(resolve) {
            var modal = document.createElement('div');
            var previouslyFocused = document.activeElement;
            var closed = false;
            modal.className = 'ak-ep-confirm-modal' + (isCancel ? ' is-danger' : ' is-primary');
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.setAttribute('aria-labelledby', 'akEpConfirmTitle');
            modal.innerHTML = '<div class="ak-ep-confirm-card">' +
                '<header class="ak-ep-confirm-head"><span class="ak-ep-confirm-icon">' + icon + '</span>' +
                    '<div><span class="ak-ep-confirm-eyebrow">\u8ba2\u5355 #' + escapeHtml(sid) + '</span>' +
                    '<h3 id="akEpConfirmTitle">' + title + '</h3></div></header>' +
                '<div class="ak-ep-confirm-body"><p>' + description + '</p>' +
                    '<div class="ak-ep-confirm-note">' + note + '</div></div>' +
                '<footer class="ak-ep-confirm-actions">' +
                    '<button type="button" class="ak-ep-confirm-btn is-secondary" data-ep-confirm-cancel>\u6682\u4e0d\u64cd\u4f5c</button>' +
                    '<button type="button" class="ak-ep-confirm-btn is-confirm" data-ep-confirm-ok>' + confirmText + '</button>' +
                '</footer></div>';

            function finish(value) {
                if (closed) return;
                closed = true;
                state.confirmationOpen = false;
                document.removeEventListener('keydown', onKeydown, true);
                modal.classList.remove('is-visible');
                window.setTimeout(function() { modal.remove(); }, 160);
                if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
                resolve(value);
            }

            function onKeydown(event) {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    finish(false);
                }
                if (event.key === 'Enter') {
                    event.preventDefault();
                    finish(true);
                }
            }

            modal.addEventListener('click', function(event) {
                if (event.target === modal) finish(false);
            });
            modal.querySelector('[data-ep-confirm-cancel]').addEventListener('click', function() { finish(false); });
            modal.querySelector('[data-ep-confirm-ok]').addEventListener('click', function() { finish(true); });
            document.addEventListener('keydown', onKeydown, true);
            document.body.appendChild(modal);
            window.requestAnimationFrame(function() {
                modal.classList.add('is-visible');
                modal.querySelector('[data-ep-confirm-ok]').focus();
            });
        });
    }

    function render() { var node = mount(); if (node) node.innerHTML = renderer.render(state); }

    function rowsFromData(data) {
        var config = data && data.config || {};
        var rows = Array.isArray(config.account_rows) ? config.account_rows : [];
        return rows.map(function(item) {
            return {
                account: String(item.account || ''),
                password: '',
                trading_password: '',
                enabled: item.enabled !== false,
                has_password: !!item.has_password,
                password_required: !!item.password_required,
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
            var enabled = row.querySelector('[data-field="account-enabled"]');
            var normalizedAccount = String(account && account.value || '').trim();
            var sameAccount = String(previous.account || '').trim().toLowerCase() === normalizedAccount.toLowerCase();
            return {
                account: normalizedAccount,
                password: String(password ? password.value : (previous.password || '')),
                trading_password: String(tradingPassword ? tradingPassword.value : (previous.trading_password || '')),
                enabled: enabled ? !!enabled.checked : previous.enabled !== false,
                has_password: sameAccount && !!previous.has_password,
                password_required: sameAccount && !!previous.password_required,
                has_trading_password: sameAccount && !!previous.has_trading_password,
                edit_password: !!previous.edit_password || !sameAccount,
                edit_trading_password: !!previous.edit_trading_password || !sameAccount
            };
        });
    }

    function clearRefreshTimer() {
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
    }

    function stop() {
        clearRefreshTimer();
        if (state.autosaveTimer) clearTimeout(state.autosaveTimer);
        state.autosaveTimer = null;
    }

    function schedule() {
        clearRefreshTimer();
        var config = state.data && state.data.config || {};
        if (!active() || !config.enabled) return;
        state.timer = setTimeout(function() { refresh(false); }, 2000);
    }

    function markDirty(delay) {
        state.dirty = true;
        if (state.autosaveTimer) clearTimeout(state.autosaveTimer);
        if (!active()) return;
        state.autosaveTimer = setTimeout(function() {
            state.autosaveTimer = null;
            save();
        }, typeof delay === 'number' ? delay : 550);
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

    function save(options) {
        options = options || {};
        var node = mount();
        if (!node || state.loading) return Promise.resolve(false);
        if (state.autosaveTimer) clearTimeout(state.autosaveTimer);
        state.autosaveTimer = null;
        var intervalInput = node.querySelector('[data-field="interval"]');
        var enabledInput = node.querySelector('[data-field="enabled"]');
        var intervalSeconds = Number(intervalInput && intervalInput.value);
        var intervalMilliseconds = intervalSeconds * 1000;
        if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
            state.error = '抢分间隔必须大于 0 秒';
            toast(state.error, 'error');
            render();
            return Promise.resolve(false);
        }
        if (intervalSeconds < 0.001 || Math.abs(intervalMilliseconds - Math.round(intervalMilliseconds)) > 1e-9) {
            state.error = '抢分间隔最多支持三位小数，最小为 0.001 秒';
            toast(state.error, 'error');
            render();
            return Promise.resolve(false);
        }
        var draftAccounts = collectAccountRows();
        var accounts = draftAccounts.filter(function(item) { return !!item.account; }).map(function(item) {
            return { account: item.account, password: item.password, trading_password: item.trading_password, enabled: item.enabled !== false };
        });
        var taskEnabled = !!(enabledInput && enabledInput.checked);
        state.draftAccounts = draftAccounts;
        var incompleteAccounts = draftAccounts.filter(function(item) {
            return item.account && item.enabled !== false && !item.has_password && !String(item.password || '').trim();
        });
        if (incompleteAccounts.length) {
            if (options.announce) {
                toast('请输入正确的登录密码', 'warning');
            }
            return Promise.resolve(false);
        }
        if (taskEnabled && !accounts.some(function(item) { return item.enabled; })) {
            state.error = '请至少启用一个抢分账号后再开启自动抢购';
            toast(state.error, 'warning');
            render();
            return Promise.resolve(false);
        }
        state.loading = true;
        render();
        return api.saveConfig({
            accounts: accounts,
            interval_seconds: intervalSeconds,
            enabled: taskEnabled
        }).then(function() {
            state.dirty = false;
            if (options.announce) toast(taskEnabled ? '自动抢购已启动' : '自动抢购已停止', 'success');
            return api.dashboard();
        }).then(function(data) {
            acceptData(data);
            state.error = '';
            return true;
        }).catch(function(error) {
            state.error = error.message || '保存失败';
            toast(state.error, 'error');
            return false;
        }).finally(function() {
            state.loading = false;
            render();
            schedule();
        });
    }

    function confirmPayment(sid) {
        var normalizedSid = String(sid || '').trim();
        if (!normalizedSid || state.loading || state.confirmingSid || state.cancellingSid || state.confirmationOpen) return;
        var config = state.data && state.data.config || {};
        var orders = state.data && state.data.orders || [];
        var order = orders.find(function(item) { return String(item.sid || '') === normalizedSid; }) || {};
        var paymentState = String(order.payment_state || 'pending');
        var cancelState = String(order.cancel_state || 'pending');
        if (order.state !== 'success') return;
        if (paymentState !== 'pending' && paymentState !== 'failed') {
            toast(paymentState === 'confirmed' ? '\u8be5\u8ba2\u5355\u5df2\u786e\u8ba4\u4ed8\u6b3e' : '\u8be5\u8ba2\u5355\u5f53\u524d\u65e0\u6cd5\u786e\u8ba4\u4ed8\u6b3e', 'warning');
            return;
        }
        if (cancelState !== 'pending' && cancelState !== 'failed') {
            toast(cancelState === 'cancelled' ? '\u8be5\u8ba2\u5355\u5df2\u53d6\u6d88\u8d2d\u4e70' : '\u8be5\u8ba2\u5355\u6b63\u5728\u53d6\u6d88\u8d2d\u4e70', 'warning');
            return;
        }
        var accountRows = Array.isArray(config.account_rows) ? config.account_rows : [];
        var buyerAccount = String(order.buyer_account || '').trim().toLowerCase();
        var accountRow = accountRows.find(function(item) {
            return String(item.account || '').trim().toLowerCase() === buyerAccount;
        });
        if (!accountRow || !accountRow.has_trading_password) {
            toast('请先为抢分账号 ' + (buyerAccount || '--') + ' 设置交易密码', 'warning');
            return;
        }
        confirmOrderAction('payment', normalizedSid).then(function(accepted) {
            if (!accepted) return;
            var latest = (state.data && state.data.orders || []).find(function(item) { return String(item.sid || '') === normalizedSid; }) || {};
            if (String(latest.payment_state || 'pending') === 'confirmed') {
                toast('\u8be5\u8ba2\u5355\u5df2\u786e\u8ba4\u4ed8\u6b3e', 'warning');
                return;
            }
            if (String(latest.cancel_state || 'pending') !== 'pending' && String(latest.cancel_state || 'pending') !== 'failed') {
                toast('\u8be5\u8ba2\u5355\u72b6\u6001\u5df2\u53d8\u66f4\uff0c\u8bf7\u5237\u65b0\u540e\u91cd\u8bd5', 'warning');
                return;
            }
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
        });
    }

    function cancelPurchase(sid) {
        var normalizedSid = String(sid || '').trim();
        if (!normalizedSid || state.loading || state.confirmingSid || state.cancellingSid || state.confirmationOpen) return;
        var orders = state.data && state.data.orders || [];
        var order = orders.find(function(item) { return String(item.sid || '') === normalizedSid; }) || {};
        if (order.state !== 'success') return;
        var paymentState = String(order.payment_state || 'pending');
        var cancelState = String(order.cancel_state || 'pending');
        if (paymentState === 'confirmed') {
            toast('\u8be5\u8ba2\u5355\u5df2\u786e\u8ba4\u4ed8\u6b3e\uff0c\u65e0\u6cd5\u53d6\u6d88\u8d2d\u4e70', 'warning');
            return;
        }
        if (paymentState !== 'pending' && paymentState !== 'failed') {
            toast('\u8be5\u8ba2\u5355\u4ed8\u6b3e\u7ed3\u679c\u672a\u660e\uff0c\u6682\u4e0d\u5141\u8bb8\u53d6\u6d88', 'warning');
            return;
        }
        if (cancelState !== 'pending' && cancelState !== 'failed') return;
        confirmOrderAction('cancel', normalizedSid).then(function(accepted) {
            if (!accepted) return;
            var latest = (state.data && state.data.orders || []).find(function(item) { return String(item.sid || '') === normalizedSid; }) || {};
            if (String(latest.payment_state || 'pending') === 'confirmed') {
                toast('\u8be5\u8ba2\u5355\u5df2\u786e\u8ba4\u4ed8\u6b3e\uff0c\u65e0\u6cd5\u53d6\u6d88\u8d2d\u4e70', 'warning');
                return;
            }
            if (String(latest.payment_state || 'pending') !== 'pending' && String(latest.payment_state || 'pending') !== 'failed') {
                toast('\u8be5\u8ba2\u5355\u4ed8\u6b3e\u7ed3\u679c\u672a\u660e\uff0c\u6682\u4e0d\u5141\u8bb8\u53d6\u6d88', 'warning');
                return;
            }
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
        });
    }

    function bind() {
        if (state.bound || !mount()) return;
        state.bound = true;
        mount().addEventListener('click', function(event) {
            var button = event.target.closest('[data-action]');
            if (!button) return;
            var action = button.getAttribute('data-action');
            if (action === 'confirm-payment') confirmPayment(button.getAttribute('data-sid'));
            if (action === 'cancel-purchase') cancelPurchase(button.getAttribute('data-sid'));
            if (action === 'add-account') {
                if (state.data.config && state.data.config.enabled) {
                    toast('自动抢购运行中，请先停止后再添加账号', 'warning');
                    return;
                }
                state.draftAccounts = collectAccountRows();
                state.draftAccounts.push({
                    account: '', password: '', trading_password: '', enabled: true,
                    has_password: false, has_trading_password: false,
                    edit_password: true, edit_trading_password: true
                });
                // Keep an unfinished row from being overwritten by the next dashboard refresh.
                state.dirty = true;
                render();
                var inputs = mount().querySelectorAll('[data-field="account"]');
                if (inputs.length) inputs[inputs.length - 1].focus();
            }
            if (action === 'remove-account') {
                state.draftAccounts = collectAccountRows();
                state.draftAccounts.splice(Number(button.getAttribute('data-index')), 1);
                var enabledAccounts = state.draftAccounts.filter(function(item) { return item.account && item.enabled !== false; });
                if (state.data.config && state.data.config.enabled && !enabledAccounts.length) {
                    state.data.config.enabled = false;
                    toast('已无启用账号，自动抢购已停止', 'warning');
                }
                markDirty(0);
                render();
            }
            if (action === 'edit-login-password' || action === 'edit-trading-password') {
                state.draftAccounts = collectAccountRows();
                var index = Number(button.getAttribute('data-index'));
                var field = action === 'edit-login-password' ? 'edit_password' : 'edit_trading_password';
                var selector = action === 'edit-login-password' ? '[data-field="password"]' : '[data-field="trading-password"]';
                if (state.draftAccounts[index]) state.draftAccounts[index][field] = true;
                render();
                var input = mount().querySelector('[data-account-row][data-index="' + index + '"] ' + selector);
                if (input) input.focus();
            }
        });
        mount().addEventListener('input', function(event) {
            if (!event.target.closest('[data-field]')) return;
            if (event.target.matches('[data-field="password"], [data-field="trading-password"]')) {
                state.dirty = true;
                if (state.autosaveTimer) clearTimeout(state.autosaveTimer);
                state.autosaveTimer = null;
                return;
            }
            markDirty(650);
        });
        mount().addEventListener('change', function(event) {
            if (!event.target.closest('[data-field]')) return;
            state.draftAccounts = collectAccountRows();
            if (event.target.matches('[data-field="enabled"]')) {
                var hasEnabledAccount = state.draftAccounts.some(function(item) {
                    return item.account && item.enabled !== false;
                });
                if (event.target.checked && !hasEnabledAccount) {
                    event.target.checked = false;
                    toast('请至少启用一个抢分账号后再开启自动抢购', 'warning');
                    return;
                }
                markDirty(0);
                save({ announce: true });
                return;
            }
            if (event.target.matches('[data-field="account-enabled"]')) {
                if (state.data.config && state.data.config.enabled && !state.draftAccounts.some(function(item) {
                    return item.account && item.enabled !== false;
                })) {
                    state.data.config.enabled = false;
                    toast('已无启用账号，自动抢购已停止', 'warning');
                }
                markDirty(0);
                render();
                return;
            }
            if (event.target.matches('[data-field="account"]')) {
                render();
            }
            markDirty(500);
        });
        mount().addEventListener('focusout', function(event) {
            if (event.target.closest('[data-field]') && state.dirty) markDirty(250);
        });
    }

    function start() { bind(); refresh(true); }
    window.AKEPAutoPurchasePanel = { start: start, stop: stop, refresh: function() { return refresh(true); } };
})();
