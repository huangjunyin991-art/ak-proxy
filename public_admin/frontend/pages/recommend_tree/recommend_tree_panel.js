(function() {
    if (window.AKRecommendTreePanelLoaded) return;
    window.AKRecommendTreePanelLoaded = true;

    var api = window.AKRecommendTreeApi;
    var storeFactory = window.AKRecommendTreeStore;
    var renderer = window.AKRecommendTreeRenderer;
    var utils = window.AKRecommendTreeUtils;
    var store = storeFactory.createStore();
    var initialized = false;
    var accountSearchTimer = null;
    var accountSearchSeq = 0;
    var suppressAccountFocus = false;

    function mount() {
        return document.getElementById('recommendTreePanelMount');
    }

    function ensureCss() {
        var existing = document.querySelector('link[data-recommend-tree-panel-css="1"]');
        if (existing) {
            existing.href = '/admin/api/recommend-tree-panel/recommend_tree_panel.css?v=20260505-03';
            return;
        }
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/admin/api/recommend-tree-panel/recommend_tree_panel.css?v=20260505-03';
        link.setAttribute('data-recommend-tree-panel-css', '1');
        document.head.appendChild(link);
    }

    function notify(message, type) {
        try {
            if (typeof showToast === 'function') {
                showToast(message, type || 'info');
                return;
            }
        } catch (e) {}
        console.log('[RecommendTreePanel]', type || 'info', message);
    }

    function render(focusAccount) {
        var root = mount();
        if (!root) return;
        renderer.render(root, store);
        bindEvents(root);
        if (focusAccount) {
            var input = root.querySelector('#rtAccountInput');
            if (input) {
                suppressAccountFocus = true;
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
                setTimeout(function() {
                    suppressAccountFocus = false;
                }, 0);
            }
        }
    }

    function bindEvents(root) {
        var accountInput = root.querySelector('#rtAccountInput');
        var searchInput = root.querySelector('#rtSearchInput');
        var loadBtn = root.querySelector('#rtLoadBtn');
        var refreshBtn = root.querySelector('#rtRefreshBtn');

        if (accountInput) {
            accountInput.onfocus = function() {
                if (suppressAccountFocus) return;
                store.state.accountDropdownOpen = true;
                store.state.accountSearching = true;
                render(true);
                searchAccounts(accountInput.value || '');
            };
            accountInput.oninput = function() {
                store.setAccountQuery(accountInput.value || '');
                store.state.accountSearching = true;
                scheduleAccountSearch(accountInput.value || '');
                render(true);
            };
            accountInput.onkeydown = function(event) {
                if (event.key === 'Enter') loadCache();
                if (event.key === 'Escape') {
                    store.state.accountDropdownOpen = false;
                    render(true);
                }
            };
        }
        if (searchInput) {
            searchInput.oninput = function() {
                store.setQuery(searchInput.value || '');
                render();
            };
        }
        if (loadBtn) loadBtn.onclick = loadCache;
        if (refreshBtn) refreshBtn.onclick = refreshTree;

        root.querySelectorAll('.rt-account-option').forEach(function(btn) {
            btn.onmousedown = function(event) {
                event.preventDefault();
            };
            btn.onclick = function() {
                var account = btn.getAttribute('data-account') || '';
                var row = (store.state.accountOptions || []).find(function(item) {
                    return String(item.account || '').toLowerCase() === String(account).toLowerCase();
                });
                store.selectAccount(row || { account: account });
                render(true);
            };
        });

        root.querySelectorAll('[data-generation]').forEach(function(btn) {
            btn.onclick = function() {
                store.setGeneration(btn.getAttribute('data-generation') || '');
                render();
            };
        });

        root.querySelectorAll('.rt-path-list').forEach(function(list) {
            list.onclick = function(event) {
                var nodeTarget = event.target.closest('.rt-path-node');
                var itemTarget = event.target.closest('.rt-path-item');
                var target = nodeTarget || itemTarget;
                if (!target || !list.contains(target)) return;
                var nodeId = nodeTarget ? nodeTarget.getAttribute('data-node-id') : itemTarget.getAttribute('data-id');
                var node = store.state.index.byId.get(String(nodeId || ''));
                renderer.showDetail(node, target);
            };
        });
    }

    function currentAccount() {
        var input = mount() ? mount().querySelector('#rtAccountInput') : null;
        return String((input && input.value) || store.state.accountQuery || store.state.account || '').trim().toLowerCase();
    }

    function scheduleAccountSearch(query) {
        clearTimeout(accountSearchTimer);
        accountSearchTimer = setTimeout(function() {
            searchAccounts(query);
        }, 220);
    }

    function searchAccounts(query) {
        var seq = ++accountSearchSeq;
        store.state.accountSearching = true;
        store.state.accountDropdownOpen = true;
        api.searchAccounts(query || '', 12).then(function(result) {
            if (seq !== accountSearchSeq) return;
            store.setAccountOptions(result.rows || []);
            render(true);
        }).catch(function(error) {
            if (seq !== accountSearchSeq) return;
            store.state.accountSearching = false;
            store.state.accountOptions = [];
            render(true);
            notify(error.message || String(error), 'error');
        });
    }

    function loadCache() {
        var account = currentAccount();
        if (!account) {
            notify('请输入账号', 'warning');
            return;
        }
        store.state.loading = true;
        store.state.error = '';
        store.state.account = account;
        store.state.accountQuery = account;
        store.state.accountDropdownOpen = false;
        render();
        api.getCache(account).then(function(result) {
            store.state.loading = false;
            if (!result.cached) {
                store.setPayload(account, { cached: false, meta: null, payload: null });
                notify('该账号暂无缓存，请点击更新数据', 'warning');
            } else {
                store.setPayload(account, result);
                notify('已读取缓存', 'success');
            }
            render();
        }).catch(function(error) {
            store.state.loading = false;
            store.state.error = error.message || String(error);
            render();
            notify(store.state.error, 'error');
        });
    }

    function refreshTree() {
        var account = currentAccount();
        if (!account) {
            notify('请输入账号', 'warning');
            return;
        }
        store.state.refreshing = true;
        store.state.error = '';
        store.state.account = account;
        store.state.accountQuery = account;
        store.state.accountDropdownOpen = false;
        render();
        api.refresh({ account: account }).then(function(result) {
            store.state.refreshing = false;
            store.setPayload(account, result);
            store.state.cached = true;
            store.state.selectedAccountMeta = {
                account: account,
                hasCache: true,
                fetchedAt: result.meta && result.meta.fetchedAt,
                nodeCount: result.meta && result.meta.nodeCount
            };
            render();
            notify('推荐树已更新并写入缓存', 'success');
        }).catch(function(error) {
            store.state.refreshing = false;
            store.state.error = error.message || String(error);
            render();
            notify(store.state.error, 'error');
        });
    }

    function start() {
        ensureCss();
        if (!initialized) {
            initialized = true;
            render();
        } else {
            render();
        }
    }

    window.AKRecommendTreePanel = {
        start: start,
        loadCache: loadCache,
        refreshTree: refreshTree,
        state: store.state
    };

    window.addEventListener('ak-admin-panel-changed', function(event) {
        if (event && event.detail && event.detail.panel === 'recommendTree') start();
    });
})();
