(function() {
    if (window.AKPointStatsPanel) return;

    var api = window.AKPointStatsApi;
    var storeFactory = window.AKPointStatsStore;
    var renderer = window.AKPointStatsRenderer;
    var store = storeFactory ? storeFactory.createStore() : null;
    var mounted = false;
    var searchTimer = null;
    var accountSearchSeq = 0;
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

    function findCategory(name) {
        var rows = (store.state.payload && Array.isArray(store.state.payload.categories)) ? store.state.payload.categories : [];
        for (var i = 0; i < rows.length; i++) {
            if ((rows[i].name || '未分类') === name) return rows[i];
        }
        return null;
    }

    function loadDetail(name, page) {
        if (!api || !api.getDetail || !store || !name) return;
        var username = String(store.state.username || '').trim();
        if (!username) return;
        var currentPage = page || (store.state.detailPageMap && store.state.detailPageMap[name]) || 1;
        store.setDetailLoading(name, true);
        render();
        api.getDetail({
            username: username,
            pointType: store.state.pointType,
            category: name,
            page: currentPage,
            pageSize: store.state.detailPageSize || 50
        }).then(function(data) {
            store.setDetailData(name, data);
            render();
        }).catch(function(error) {
            store.setDetailError(name, error.message || '加载明细失败');
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

    function refreshQuota() {
        if (!api || !store || !api.getQuota) return Promise.resolve();
        return api.getQuota().then(function(payload) {
            store.setQuota(payload);
            render();
        }).catch(function(error) {
            // 配额接口失败不阻塞主流程，仅打日志
            try { console.warn('[PointStats] 配额查询失败', error && error.message); } catch (e) {}
        });
    }

    function syncRecords(options) {
        if (!api || !store) return;
        var silent = !!(options && options.silent);
        var username = String(store.state.username || '').trim();
        if (!username) {
            if (!silent) {
                store.setStatus('请先选择或输入要拉取的账号。', true);
                render();
            }
            return;
        }
        var pointType = store.state.pointType;
        // 前端预判冷却：5 分钟内已拉过则不再请求外部 API，仅刷新本地缓存
        if (store.getCooldownRemaining(username, pointType) > 0) {
            store.state.syncing = false;
            if (!silent) {
                store.setStatus(pointType + ' 5 分钟内已拉取过，使用本地缓存', false);
            }
            loadStats();
            return;
        }
        // 前端预判额度：非超管已用满 3 个账号且当前账号不在已操作列表中，直接拒绝
        if (!store.state.quota.isSuperAdmin && store.isQuotaExhausted() && !store.isAccountInQuota(username)) {
            store.state.syncing = false;
            var msg = '今日点数统计 ' + store.state.quota.limit + ' 个账号额度已用完，明天再来';
            store.setStatus(msg, true);
            notify(msg, 'error');
            render();
            return;
        }
        store.state.syncing = true;
        store.setStatus(pointType + ' 后台拉取任务提交中，可继续其他操作...', false);
        render();
        api.syncRecords({ username: username, pointType: pointType, pageSize: 50, maxPages: 0 }).then(function(resp) {
            var s = resp && resp.state;
            if (s && s.message) {
                store.setStatus(s.message, false);
            }
            // 后端命中冷却（理论上前端已预判，这里兜底）：不启动 poll，直接读 DB 缓存
            if (resp && resp.cooldown_active) {
                store.state.syncing = false;
                loadStats();
                refreshQuota();
                render();
                return;
            }
            // 乐观标记冷却 + 当日额度，避免短时间重复触发
            store.markCooldown(username, pointType);
            startSyncPoll(username, pointType);
            refreshQuota();
        }).catch(function(error) {
            store.state.syncing = false;
            var code = error && error.code;
            if (code === 'DAILY_QUOTA_EXHAUSTED') {
                var body = (error && error.body) || {};
                var limit = body.limit || store.state.quota.limit || 3;
                var used = body.used_count || store.state.quota.usedCount || 0;
                var msg = '今日点数统计 ' + used + '/' + limit + ' 个账号额度已用完';
                store.setStatus(msg, true);
                notify(msg, 'error');
                refreshQuota();
            } else {
                store.setStatus(error.message || '启动后台拉取失败', true);
                if (!silent) notify(error.message || '启动后台拉取失败', 'error');
            }
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
        var query = String(store.state.accountQuery || '').trim();
        var seq = ++accountSearchSeq;
        if (!query) {
            store.state.accountOptions = [];
            store.state.accountSearching = false;
            store.state.selectedAccountIndex = -1;
            render({ keepAccountFocus: true });
            return;
        }
        store.state.accountSearching = true;
        render({ keepAccountFocus: true });
        searchTimer = setTimeout(function() {
            if (seq !== accountSearchSeq || query !== String(store.state.accountQuery || '').trim()) return;
            api.searchUsers(query, 12).then(function(data) {
                if (seq !== accountSearchSeq || query !== String(store.state.accountQuery || '').trim()) return;
                store.setAccountOptions(data.rows || []);
                render({ keepAccountFocus: true });
            }).catch(function(error) {
                if (seq !== accountSearchSeq || query !== String(store.state.accountQuery || '').trim()) return;
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
            // 切换 EP/SP/TP/RP 时自动尝试增量更新：syncRecords 内部会预判冷却/额度静默处理
            var u = String(store.state.username || '').trim();
            if (u) syncRecords({ silent: true });
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
            var categoryName = actionNode.getAttribute('data-name') || '';
            store.toggleCategory(categoryName);
            render();
            if (store.state.expandedCategory === categoryName) {
                loadDetail(categoryName, store.state.detailPageMap[categoryName] || 1);
            }
        } else if (action === 'detail-page') {
            if (actionNode.disabled) return;
            var name = actionNode.getAttribute('data-name') || '';
            if (!name) return;
            var target = actionNode.getAttribute('data-target') || 'next';
            var match = findCategory(name);
            var detail = store.state.detailMap && store.state.detailMap[name] ? store.state.detailMap[name] : null;
            var total = detail && detail.total != null ? Number(detail.total || 0) : (match && match.count != null ? Number(match.count || 0) : (match && Array.isArray(match.records) ? match.records.length : 0));
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
            loadDetail(name, next);
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
        refreshQuota();
    }

    window.AKPointStatsPanel = {
        start: start,
        refresh: loadStats,
        refreshQuota: refreshQuota
    };
})();
