(function() {
    if (window.AKPointStatsPanel) return;

    var api = window.AKPointStatsApi;
    var storeFactory = window.AKPointStatsStore;
    var renderer = window.AKPointStatsRenderer;
    var store = storeFactory ? storeFactory.createStore() : null;
    var mounted = false;
    var searchTimer = null;
    var restoringFocus = false;

    function mountNode() {
        return document.getElementById('pointStatsPanelMount');
    }

    function notify(message, type) {
        try {
            if (typeof window.showToast === 'function') window.showToast(message, type || 'info');
        } catch (e) {}
    }

    function render(options) {
        var mount = mountNode();
        if (!mount || !store || !renderer) return;
        var active = document.activeElement;
        var keepAccountFocus = options && options.keepAccountFocus;
        var cursor = null;
        if (keepAccountFocus && active && active.getAttribute('data-role') === 'account-input') {
            cursor = active.selectionStart;
        }
        mount.innerHTML = renderer.render(store.state);
        if (keepAccountFocus) {
            var input = mount.querySelector('[data-role="account-input"]');
            if (input) {
                restoringFocus = true;
                input.focus();
                if (cursor != null) input.setSelectionRange(cursor, cursor);
                restoringFocus = false;
            }
        }
    }

    function setReadyError(message) {
        var mount = mountNode();
        if (mount) mount.innerHTML = '<div class="ps-module-error">' + String(message || '点数统计模块加载失败') + '</div>';
    }

    function loadStats() {
        if (!api || !store) return;
        store.state.loading = true;
        store.setStatus('正在读取点数统计数据...', false);
        render();
        api.getStats({ username: store.state.username, pointType: store.state.pointType, limit: 80 }).then(function(data) {
            store.setPayload(data);
            var active = data && data.active_stats ? data.active_stats : null;
            var total = active && active.total_records != null ? active.total_records : 0;
            store.setStatus(store.state.pointType + ' 缓存统计完成：' + numberText(total) + ' 条', false);
        }).catch(function(error) {
            store.setStatus(error.message || '加载失败', true);
            notify(error.message || '加载失败', 'error');
        }).finally(function() {
            store.state.loading = false;
            render();
        });
    }

    function syncRecords() {
        if (!api || !store) return;
        var username = String(store.state.username || '').trim();
        if (!username) {
            store.setStatus('请先选择或输入要同步的账号。', true);
            render();
            return;
        }
        store.state.syncing = true;
        store.setStatus('正在同步 ' + username + ' 的 ' + store.state.pointType + ' 流水：无缓存全量拉取，有缓存增量更新...', false);
        render();
        api.syncRecords({ username: username, pointType: store.state.pointType, pageSize: 50 }).then(function(data) {
            var modeText = data.mode === 'full' ? '全量' : '增量';
            store.setStatus(modeText + '同步完成：拉取 ' + numberText(data.fetched_count) + ' 条，新增 ' + numberText(data.new_count) + ' 条，保存 ' + numberText(data.saved_count) + ' 条。', false);
            store.state.expandedCategory = null;
            loadStats();
        }).catch(function(error) {
            store.setStatus(error.message || '同步失败', true);
            notify(error.message || '同步失败', 'error');
        }).finally(function() {
            store.state.syncing = false;
            render();
        });
    }

    function numberText(value) {
        if (typeof window.formatNumber === 'function') return window.formatNumber(value);
        return Number(value || 0).toLocaleString('zh-CN');
    }

    function searchAccounts() {
        if (!api || !store) return;
        clearTimeout(searchTimer);
        store.state.accountSearching = true;
        render({ keepAccountFocus: true });
        searchTimer = setTimeout(function() {
            api.searchUsers(store.state.accountQuery, 12).then(function(data) {
                store.setAccountOptions(data.rows || []);
                render({ keepAccountFocus: true });
            }).catch(function(error) {
                store.state.accountSearching = false;
                store.setStatus(error.message || '账号搜索失败', true);
                render({ keepAccountFocus: true });
            });
        }, 250);
    }

    function selectOption(index) {
        if (!store) return;
        var row = store.state.accountOptions[index];
        if (!row) return;
        store.selectAccount(row);
        render();
        loadStats();
    }

    function handleAction(target) {
        var actionNode = target.closest('[data-action]');
        if (!actionNode || !store) return;
        var action = actionNode.getAttribute('data-action');
        if (action === 'point-type') {
            store.setPointType(actionNode.getAttribute('data-point-type'));
            render();
            loadStats();
        } else if (action === 'load') {
            loadStats();
        } else if (action === 'sync') {
            syncRecords();
        } else if (action === 'clear-account') {
            store.clearAccount();
            render();
            loadStats();
        } else if (action === 'select-account') {
            selectOption(Number(actionNode.getAttribute('data-index') || 0));
        } else if (action === 'rank-account') {
            store.selectAccount({ username: actionNode.getAttribute('data-username') || '' });
            render();
            loadStats();
        } else if (action === 'toggle-category') {
            store.toggleCategory(actionNode.getAttribute('data-name') || '');
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
        mount.addEventListener('input', function(event) {
            if (event.target && event.target.getAttribute('data-role') === 'account-input') {
                store.setAccountQuery(event.target.value || '');
                searchAccounts();
            }
        });
        mount.addEventListener('focusin', function(event) {
            if (event.target && event.target.getAttribute('data-role') === 'account-input') {
                if (restoringFocus) return;
                store.state.accountDropdownOpen = true;
                searchAccounts();
            }
        });
        mount.addEventListener('keydown', function(event) {
            if (!event.target || event.target.getAttribute('data-role') !== 'account-input') return;
            if (event.key === 'Escape') {
                store.state.accountDropdownOpen = false;
                store.state.selectedAccountIndex = -1;
                render({ keepAccountFocus: true });
            } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                store.moveAccountSelection(1);
                render({ keepAccountFocus: true });
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                store.moveAccountSelection(-1);
                render({ keepAccountFocus: true });
            } else if (event.key === 'Enter') {
                event.preventDefault();
                if (store.state.selectedAccountIndex >= 0) {
                    selectOption(store.state.selectedAccountIndex);
                } else {
                    store.state.accountDropdownOpen = false;
                    store.state.username = store.state.accountQuery;
                    render();
                    loadStats();
                }
            }
        });
    }

    function start() {
        if (!api || !storeFactory || !renderer || !store) {
            setReadyError('点数统计模块依赖加载失败，请强制刷新后重试');
            return;
        }
        bindEvents();
        render();
        if (!store.state.payload && !store.state.loading) loadStats();
    }

    window.AKPointStatsPanel = {
        start: start,
        refresh: loadStats
    };
})();
