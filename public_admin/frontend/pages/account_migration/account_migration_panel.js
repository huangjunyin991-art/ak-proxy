(function() {
    if (window.AKAccountMigrationPanel) return;

    var api = window.AKAccountMigrationApi;
    var renderer = window.AKAccountMigrationRenderer;
    var storeFactory = window.AKAccountMigrationStore;
    var store = storeFactory ? storeFactory.createStore() : null;
    var bound = false;
    var refreshTimer = null;

    function mountNode() {
        return document.getElementById('accountMigrationPanelMount');
    }

    function isActive() {
        return !!document.querySelector('.tab.active[data-panel="accountMigration"]');
    }

    function notify(message, type) {
        try {
            if (typeof window.showToast === 'function') window.showToast(message, type || 'info');
        } catch (e) {}
    }

    function render() {
        var mount = mountNode();
        if (!mount) return;
        if (!api || !renderer || !store) {
            mount.innerHTML = '<div class="akd-module-error">账号迁移模块依赖加载失败，请强制刷新后重试</div>';
            return;
        }
        mount.innerHTML = renderer.render(store.state);
    }

    function searchInputNode() {
        return document.getElementById('accountMigrationSearchInput');
    }

    function refreshDelay() {
        var dashboard = store && store.state && store.state.dashboard ? store.state.dashboard : {};
        var currentRun = dashboard.current_run || (dashboard.scheduler && dashboard.scheduler.current_run) || null;
        if (currentRun && String(currentRun.status || '').toLowerCase() === 'running') {
            return 5000;
        }
        return 20000;
    }

    function shouldDeferRefresh() {
        if (!isActive()) return true;
        if (store && store.state && store.state.policyDirty) return true;
        var active = document.activeElement;
        var mount = mountNode();
        if (!active || !mount) return false;
        return mount.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
    }

    function scheduleRefresh(immediate) {
        stop();
        if (!isActive()) return;
        refreshTimer = window.setTimeout(function() {
            if (!isActive()) return;
            if (shouldDeferRefresh()) {
                scheduleRefresh(false);
                return;
            }
            refresh(false);
        }, immediate ? 0 : refreshDelay());
    }

    function refresh(forceStats) {
        if (!api || !store) return Promise.resolve();
        store.state.loading = true;
        store.state.error = '';
        render();
        return api.dashboard({
            search: store.state.search,
            limit: store.state.limit,
            offset: store.state.offset,
            runsLimit: store.state.runsLimit,
            forceStats: !!forceStats
        }).then(function(payload) {
            store.setDashboard(payload || {});
        }).catch(function(error) {
            store.setError(error.message || '账号迁移数据加载失败');
            notify(store.state.error, 'error');
        }).finally(function() {
            store.state.loading = false;
            render();
            scheduleRefresh(false);
        });
    }

    function currentPolicyPayload() {
        var policy = store && store.state ? store.state.policyDraft : {};
        return {
            enabled: !!(policy && policy.enabled),
            daily_time: String(policy && policy.daily_time || '03:30'),
            limit_per_spec: Math.max(0, Number(policy && policy.limit_per_spec || 0) || 0)
        };
    }

    function savePolicy() {
        if (!api || !store) return;
        store.state.savingPolicy = true;
        render();
        api.savePolicy(currentPolicyPayload()).then(function(payload) {
            store.applyPolicy(payload && payload.policy);
            notify('账号迁移配置已保存', 'success');
            return refresh(true);
        }).catch(function(error) {
            store.state.savingPolicy = false;
            render();
            notify(error.message || '账号迁移配置保存失败', 'error');
        }).finally(function() {
            store.state.savingPolicy = false;
            render();
        });
    }

    function startSync() {
        if (!api || !store) return;
        store.state.startingSync = true;
        render();
        api.startSync({
            phase_key: '',
            dry_run: false,
            limit_per_spec: Math.max(0, Number(store.state.policyDraft && store.state.policyDraft.limit_per_spec || 0) || 0)
        }).then(function(payload) {
            notify(payload.message || '账号迁移同步已启动', 'success');
            return refresh(true);
        }).catch(function(error) {
            notify(error.message || '账号迁移同步启动失败', 'error');
        }).finally(function() {
            store.state.startingSync = false;
            render();
            scheduleRefresh(false);
        });
    }

    function updateSearchInputValue() {
        var node = searchInputNode();
        if (!node) return;
        store.state.searchInput = String(node.value || '');
    }

    function runSearch(clear) {
        if (!store) return;
        if (clear) {
            store.state.searchInput = '';
            store.state.search = '';
        } else {
            updateSearchInputValue();
            store.state.search = String(store.state.searchInput || '').trim();
        }
        store.state.offset = 0;
        refresh(true);
    }

    function handleClick(target) {
        var actionNode = target.closest('[data-action]');
        if (!actionNode) return;
        var action = actionNode.getAttribute('data-action');
        if (action === 'refresh') {
            refresh(true);
            return;
        }
        if (action === 'save-policy') {
            savePolicy();
            return;
        }
        if (action === 'start-sync') {
            startSync();
            return;
        }
        if (action === 'search') {
            runSearch(false);
            return;
        }
        if (action === 'clear-search') {
            runSearch(true);
        }
    }

    function handleChange(target) {
        if (!target || !store) return;
        var field = target.getAttribute('data-field');
        if (!field) return;
        if (field === 'enabled') {
            store.updatePolicyField(field, !!target.checked);
        } else if (field === 'limit_per_spec') {
            store.updatePolicyField(field, Math.max(0, Number(target.value || 0) || 0));
        } else {
            store.updatePolicyField(field, String(target.value || '').trim());
        }
    }

    function bindEvents() {
        var mount = mountNode();
        if (!mount || bound) return;
        bound = true;
        mount.addEventListener('click', function(event) {
            handleClick(event.target);
        });
        mount.addEventListener('change', function(event) {
            handleChange(event.target);
        });
        mount.addEventListener('input', function(event) {
            if (event.target && event.target.id === 'accountMigrationSearchInput') {
                store.state.searchInput = String(event.target.value || '');
            }
        });
        mount.addEventListener('keydown', function(event) {
            if (event.target && event.target.id === 'accountMigrationSearchInput' && event.key === 'Enter') {
                event.preventDefault();
                runSearch(false);
            }
        });
    }

    function start() {
        bindEvents();
        render();
        if (!store.state.dashboard && !store.state.loading) {
            refresh(true);
            return;
        }
        scheduleRefresh(false);
    }

    function stop() {
        if (refreshTimer) {
            window.clearTimeout(refreshTimer);
            refreshTimer = null;
        }
    }

    window.AKAccountMigrationPanel = {
        start: start,
        stop: stop,
        refresh: function() {
            return refresh(true);
        }
    };
})();
