(function() {
    if (window.AKPointStatsPanel) return;

    var api = window.AKPointStatsApi;
    var storeFactory = window.AKPointStatsStore;
    var renderer = window.AKPointStatsRenderer;
    var store = storeFactory ? storeFactory.createStore() : null;
    var mounted = false;
    var searchTimer = null;
    var restoringFocus = false;
    var syncPollTimer = null;
    var syncPollKey = '';
    var SYNC_POLL_INTERVAL_MS = 1500;

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
            store.setStatus(store.state.pointType + ' 数据统计完成：' + numberText(total) + ' 条', false);
        }).catch(function(error) {
            store.setStatus(error.message || '加载失败', true);
            notify(error.message || '加载失败', 'error');
        }).finally(function() {
            store.state.loading = false;
            render();
        });
    }

    function stopSyncPoll() {
        if (syncPollTimer) {
            clearInterval(syncPollTimer);
            syncPollTimer = null;
        }
        syncPollKey = '';
    }

    function pollSyncOnce(username, pointType) {
        return api.syncStatus({ username: username, pointType: pointType }).then(function(resp) {
            var s = resp && resp.state;
            var status = (resp && resp.status) || (s && s.status) || 'idle';
            if (s && s.message) {
                store.setStatus(s.message, status === 'error');
            }
            if (status !== 'running') {
                store.state.syncing = false;
                stopSyncPoll();
                if (status === 'finished') {
                    store.state.expandedCategory = null;
                    loadStats();
                } else {
                    render();
                }
            } else {
                render();
            }
        }).catch(function(error) {
            store.setStatus(error.message || '获取后台任务状态失败', true);
            stopSyncPoll();
            store.state.syncing = false;
            render();
        });
    }

    function startSyncPoll(username, pointType) {
        stopSyncPoll();
        syncPollKey = (username || '').toLowerCase() + ':' + (pointType || '').toUpperCase();
        syncPollTimer = setInterval(function() {
            pollSyncOnce(username, pointType);
        }, SYNC_POLL_INTERVAL_MS);
        pollSyncOnce(username, pointType);
    }

    function syncRecords() {
        if (!api || !store) return;
        var username = String(store.state.username || '').trim();
        if (!username) {
            store.setStatus('请先选择或输入要拉取的账号。', true);
            render();
            return;
        }
        var pointType = store.state.pointType;
        store.state.syncing = true;
        store.setStatus(pointType + ' 后台拉取任务提交中，可继续其他操作...', false);
        render();
        api.syncRecords({ username: username, pointType: pointType, pageSize: 50, maxPages: 0 }).then(function(resp) {
            var s = resp && resp.state;
            if (s && s.message) {
                store.setStatus(s.message, false);
            }
            startSyncPoll(username, pointType);
        }).catch(function(error) {
            store.state.syncing = false;
            store.setStatus(error.message || '启动后台拉取失败', true);
            notify(error.message || '启动后台拉取失败', 'error');
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
        } else if (action === 'toggle-category') {
            store.toggleCategory(actionNode.getAttribute('data-name') || '');
            render();
        } else if (action === 'detail-page') {
            if (actionNode.disabled) return;
            var name = actionNode.getAttribute('data-name') || '';
            if (!name) return;
            var target = actionNode.getAttribute('data-target') || 'next';
            var rows = (store.state.payload && Array.isArray(store.state.payload.categories)) ? store.state.payload.categories : [];
            var match = null;
            for (var i = 0; i < rows.length; i++) { if ((rows[i].name || '未分类') === name) { match = rows[i]; break; } }
            var total = match && Array.isArray(match.records) ? match.records.length : 0;
            var pageSize = store.state.detailPageSize || 50;
            var totalPages = Math.max(1, Math.ceil(total / pageSize));
            var current = (store.state.detailPageMap && store.state.detailPageMap[name]) || 1;
            var next = current;
            if (target === 'first') next = 1;
            else if (target === 'prev') next = Math.max(1, current - 1);
            else if (target === 'next') next = Math.min(totalPages, current + 1);
            else if (target === 'last') next = totalPages;
            store.setDetailPage(name, next);
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
                }
            }
        });
        mount.addEventListener('focusout', function(event) {
            if (!event.target || event.target.getAttribute('data-role') !== 'account-input') return;
            setTimeout(function() {
                var active = document.activeElement;
                if (active && active.getAttribute && active.getAttribute('data-role') === 'account-input') return;
                if (!store.state.accountDropdownOpen) return;
                store.state.accountDropdownOpen = false;
                store.state.selectedAccountIndex = -1;
                render();
            }, 180);
        });
    }

    function start() {
        if (!api || !storeFactory || !renderer || !store) {
            setReadyError('点数统计模块依赖加载失败，请强制刷新后重试');
            return;
        }
        bindEvents();
        render();
        if (store.state.username && !store.state.payload && !store.state.loading) loadStats();
    }

    window.AKPointStatsPanel = {
        start: start,
        refresh: loadStats
    };
})();
