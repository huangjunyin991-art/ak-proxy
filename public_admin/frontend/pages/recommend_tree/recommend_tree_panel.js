(function() {
    if (window.AKRecommendTreePanelLoaded) return;
    window.AKRecommendTreePanelLoaded = true;

    var api = window.AKRecommendTreeApi;
    var storeFactory = window.AKRecommendTreeStore;
    var renderer = window.AKRecommendTreeRenderer;
    var utils = window.AKRecommendTreeUtils;
    var store = storeFactory.createStore();
    var initialized = false;

    function mount() {
        return document.getElementById('recommendTreePanelMount');
    }

    function ensureCss() {
        if (document.querySelector('link[data-recommend-tree-panel-css="1"]')) return;
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/admin/api/recommend-tree-panel/recommend_tree_panel.css?v=20260505-01';
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

    function render() {
        var root = mount();
        if (!root) return;
        renderer.render(root, store);
        bindEvents(root);
    }

    function bindEvents(root) {
        var accountInput = root.querySelector('#rtAccountInput');
        var searchInput = root.querySelector('#rtSearchInput');
        var loadBtn = root.querySelector('#rtLoadBtn');
        var refreshBtn = root.querySelector('#rtRefreshBtn');

        if (accountInput) {
            accountInput.onkeydown = function(event) {
                if (event.key === 'Enter') loadCache();
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
        return String((input && input.value) || store.state.account || '').trim().toLowerCase();
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
        render();
        api.refresh({ account: account }).then(function(result) {
            store.state.refreshing = false;
            store.setPayload(account, result);
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
