(function() {
    if (window.AKGuidedSaleStatisticsPanel) return;

    var api = window.AKGuidedSaleStatisticsApi;
    var renderer = window.AKGuidedSaleStatisticsRenderer;
    var state = {
        sourceAccount: '', accountInput: '', data: null, loading: false, error: '', timer: null,
        pickerOpen: false, bound: false, documentBound: false
    };

    function mount() { return document.getElementById('guidedSaleStatisticsPanelMount'); }
    function active() { return !!document.querySelector('.tab.active[data-panel="guidedSaleStatistics"]'); }
    function render() { if (mount() && renderer) mount().innerHTML = renderer.render(state); }
    function toast(message, type) { if (typeof window.showToast === 'function') window.showToast(message, type || 'info'); }
    function normalizeAccount(value) { return String(value || '').trim().toLowerCase(); }

    function schedule() {
        stopTimer();
        if (!active()) return;
        state.timer = window.setTimeout(function() { refresh(false); }, 10000);
    }

    function stopTimer() {
        if (state.timer) window.clearTimeout(state.timer);
        state.timer = null;
    }

    function clearDashboard() {
        var current = state.data || {};
        var accounts = Array.isArray(current.accounts) ? current.accounts : [];
        state.data = {
            accounts: accounts,
            policy: current.policy || {},
            is_super_admin: !!current.is_super_admin,
            run: null,
            jobs: [],
            rows: [],
            summary: {
                whitelist_accounts: accounts.length,
                completed_accounts: 0,
                pending_accounts: 0,
                matched_subaccounts: 0
            }
        };
    }

    function currentInput() {
        var input = mount() && mount().querySelector('[data-field="source_account"]');
        return normalizeAccount(input ? input.value : state.accountInput);
    }

    function applySource(source) {
        var account = normalizeAccount(source);
        var changed = account !== state.sourceAccount;
        state.sourceAccount = account;
        state.accountInput = account;
        state.pickerOpen = false;
        if (changed) clearDashboard();
        return account;
    }

    function filterAccountOptions(query) {
        var root = mount();
        if (!root) return;
        var needle = normalizeAccount(query);
        var options = root.querySelectorAll('[data-account]');
        var visible = 0;
        options.forEach(function(option) {
            var matched = !needle || String(option.textContent || '').toLowerCase().indexOf(needle) !== -1;
            option.hidden = !matched;
            if (matched) visible += 1;
        });
        var empty = root.querySelector('.ak-gss-account-no-match');
        if (empty) empty.hidden = visible > 0;
    }

    function focusAccountInput() {
        window.requestAnimationFrame(function() {
            var input = mount() && mount().querySelector('[data-field="source_account"]');
            if (!input || input.disabled) return;
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        });
    }

    function openPicker() {
        if (state.loading || state.pickerOpen) return;
        state.pickerOpen = true;
        state.accountInput = currentInput();
        render();
        filterAccountOptions(state.accountInput);
        focusAccountInput();
    }

    function closePicker() {
        if (!state.pickerOpen) return;
        state.pickerOpen = false;
        state.accountInput = currentInput();
        render();
    }

    function refresh(showLoading) {
        if (!api) return Promise.resolve();
        if (showLoading) { state.loading = true; render(); }
        return api.dashboard(state.sourceAccount).then(function(data) {
            state.data = data || {};
            state.error = '';
        }).catch(function(error) {
            state.error = error.message || '指导销售统计加载失败';
        }).finally(function() {
            state.loading = false;
            if (state.pickerOpen && !showLoading) {
                schedule();
                return;
            }
            render();
            schedule();
        });
    }

    function refreshFromInput() {
        var source = applySource(currentInput());
        if (!source) {
            state.error = '请输入公告来源账号';
            render();
            return;
        }
        refresh(true);
    }

    function selectAccount(account) {
        applySource(account);
        refresh(true);
    }

    function startScan() {
        if (!api) return;
        var source = applySource(currentInput());
        if (!source) {
            state.error = '请输入公告来源账号';
            render();
            return;
        }
        state.loading = true;
        render();
        api.start(source).then(function(data) {
            state.data = data || {};
            state.error = '';
            toast('公告获取任务已加入队列', 'success');
        }).catch(function(error) {
            state.error = error.message || '任务创建失败';
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
            toast('缓存周期已更新', 'success');
            refresh(false);
        }).catch(function(error) { toast(error.message || '保存失败', 'error'); });
    }

    function bindDocumentEvents() {
        if (state.documentBound) return;
        state.documentBound = true;
        document.addEventListener('click', function(event) {
            if (!state.pickerOpen) return;
            var picker = mount() && mount().querySelector('.ak-gss-account-picker');
            if (picker && picker.contains(event.target)) return;
            closePicker();
        });
        document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape' && state.pickerOpen) closePicker();
        });
    }

    function bind() {
        if (state.bound || !mount()) return;
        state.bound = true;
        bindDocumentEvents();
        mount().addEventListener('input', function(event) {
            if (!event.target || event.target.getAttribute('data-field') !== 'source_account') return;
            state.accountInput = String(event.target.value || '');
            if (!state.pickerOpen) state.pickerOpen = true;
            var picker = mount().querySelector('.ak-gss-account-picker');
            if (picker) picker.classList.add('is-open');
            filterAccountOptions(state.accountInput);
        });
        mount().addEventListener('keydown', function(event) {
            if (!event.target || event.target.getAttribute('data-field') !== 'source_account') return;
            if (event.key === 'Enter') {
                event.preventDefault();
                refreshFromInput();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                closePicker();
            }
        });
        mount().addEventListener('click', function(event) {
            var button = event.target.closest('[data-action]');
            if (!button) {
                if (event.target && event.target.getAttribute('data-field') === 'source_account') openPicker();
                return;
            }
            var action = button.getAttribute('data-action');
            if (action === 'toggle-account-menu') {
                if (state.pickerOpen) closePicker(); else openPicker();
            }
            if (action === 'choose-account') selectAccount(button.getAttribute('data-account'));
            if (action === 'start') startScan();
            if (action === 'refresh') refreshFromInput();
            if (action === 'save-policy') savePolicy();
        });
    }

    function start() { bind(); render(); if (!state.data && !state.loading) refresh(true); else schedule(); }
    window.AKGuidedSaleStatisticsPanel = { start: start, stop: stopTimer, refresh: function() { return refreshFromInput(); } };
})();
