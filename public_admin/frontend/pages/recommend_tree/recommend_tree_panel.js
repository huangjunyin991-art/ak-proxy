(function() {
    if (window.AKRecommendTreePanelLoaded) return;
    window.AKRecommendTreePanelLoaded = true;

    var api = window.AKRecommendTreeApi;
    var storeFactory = window.AKRecommendTreeStore;
    var renderer = window.AKRecommendTreeRenderer;
    var store = storeFactory.createStore();

    var accountSearchTimer = null;
    var accountSearchSeq = 0;
    var initialized = false;
    var suppressAccountFocus = false;
    var searchSelectionStart = 0;
    var searchSelectionEnd = 0;

    function mount() {
        return document.getElementById('recommendTreePanelMount');
    }

    function isSuperAdmin() {
        return String(sessionStorage.getItem('admin_role') || '').toLowerCase() === 'super_admin';
    }

    function ensureCss() {
        var version = window.AKRecommendTreePanelAssetVersion || '20260508-37';
        var href = '/admin/api/recommend-tree-panel/recommend_tree_panel.css?v=' + encodeURIComponent(version);
        var existing = document.querySelector('link[data-recommend-tree-panel-css="1"]');
        if (existing) {
            if (existing.getAttribute('href') !== href) existing.href = href;
            return;
        }
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
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

    function render(focusAccount, focusSearch) {
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
        if (focusSearch) {
            var search = root.querySelector('#rtSearchInput');
            if (search) {
                search.focus();
                search.setSelectionRange(searchSelectionStart, searchSelectionEnd);
            }
        }
    }

    function bindEvents(root) {
        var accountInput = root.querySelector('#rtAccountInput');
        var searchInput = root.querySelector('#rtSearchInput');
        var generationFilter = root.querySelector('#rtGenerationFilter');
        var generationTrigger = root.querySelector('#rtGenerationTrigger');
        var loadBtn = root.querySelector('#rtLoadBtn');
        var refreshBtn = root.querySelector('#rtRefreshBtn');

        if (accountInput) {
            accountInput.onfocus = function() {
                if (suppressAccountFocus) return;
                if (store.state.accountAuthRequired) {
                    store.state.accountDropdownOpen = false;
                    render(true);
                    return;
                }
                store.state.accountDropdownOpen = true;
                store.state.accountSearching = true;
                render(true);
                searchAccounts(accountInput.value || '');
            };
            accountInput.oninput = function() {
                store.setAccountQuery(accountInput.value || '');
                if (store.state.accountAuthRequired) {
                    store.state.accountDropdownOpen = false;
                    store.state.accountSearching = false;
                    render(true);
                    return;
                }
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
                searchSelectionStart = typeof searchInput.selectionStart === 'number' ? searchInput.selectionStart : searchInput.value.length;
                searchSelectionEnd = typeof searchInput.selectionEnd === 'number' ? searchInput.selectionEnd : searchInput.value.length;
                store.setQuery(searchInput.value || '');
                render(false, true);
            };
        }

        if (loadBtn) loadBtn.onclick = loadCache;
        if (refreshBtn) refreshBtn.onclick = refreshTree;

        if (generationTrigger && generationFilter) {
            generationTrigger.onclick = function(event) {
                event.stopPropagation();
                generationFilter.classList.toggle('open');
            };
        }

        root.querySelectorAll('[data-view-mode]').forEach(function(btn) {
            btn.onclick = function() {
                store.setViewMode(btn.getAttribute('data-view-mode') || 'level');
                render();
            };
        });

        root.querySelectorAll('[data-level-group]').forEach(function(btn) {
            btn.onclick = function(event) {
                event.stopPropagation();
                store.toggleLevelGroup(btn.getAttribute('data-level-group') || '', btn.getAttribute('data-default-expanded') === '1');
                render();
            };
        });

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

        root.querySelectorAll('.rt-generation-option').forEach(function(btn) {
            btn.onclick = function() {
                if (generationFilter) generationFilter.classList.remove('open');
                store.setGeneration(btn.getAttribute('data-generation') || '');
                render();
            };
        });

        root.querySelectorAll('.rt-node-open').forEach(function(item) {
            item.onclick = function(event) {
                event.stopPropagation();
                var nodeId = item.getAttribute('data-id') || '';
                var node = store.state.index.byId.get(String(nodeId));
                renderer.showDetail(node, item);
            };
        });

        root.querySelectorAll('[data-policy-level]').forEach(function(item) {
            item.onclick = function(event) {
                event.stopPropagation();
                togglePromotionPolicy(item.getAttribute('data-policy-level') || '');
            };
        });

        root.onclick = function(event) {
            if (generationFilter && !event.target.closest('#rtGenerationFilter')) {
                generationFilter.classList.remove('open');
            }
        };

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
        store.state.accountAuthRequired = false;
        api.searchAccounts(query || '', 12).then(function(result) {
            if (seq !== accountSearchSeq) return;
            store.setAccountOptions(result.rows || []);
            render(true);
        }).catch(function(error) {
            if (seq !== accountSearchSeq) return;
            store.state.accountSearching = false;
            store.state.accountOptions = [];
            if (error && error.code === 'NEED_OPERATION_AUTH') {
                store.state.accountAuthRequired = true;
                store.state.accountDropdownOpen = false;
                render(true);
                return;
            }
            render(true);
            notify(error.message || String(error), 'error');
        });
    }

    function fetchCache(account, options) {
        var opts = options || {};
        store.state.loading = !opts.silent;
        store.state.error = '';
        store.state.account = account;
        store.state.accountQuery = account;
        store.state.accountDropdownOpen = false;
        render(opts.focusAccount, opts.focusSearch);
        return api.getCache(account).then(function(result) {
            store.state.loading = false;
            if (!result.cached) {
                store.setPayload(account, { cached: false, meta: null, payload: null });
                if (!opts.silent) notify('该账号暂无缓存，请点击更新数据', 'warning');
            } else {
                store.setPayload(account, result);
                if (!opts.silent) notify('已读取缓存', 'success');
            }
            render(opts.focusAccount, opts.focusSearch);
            return result;
        }).catch(function(error) {
            store.state.loading = false;
            store.state.error = error.message || String(error);
            render(opts.focusAccount, opts.focusSearch);
            if (!opts.quietError) notify(store.state.error, 'error');
            throw error;
        });
    }

    function loadCache() {
        var account = currentAccount();
        if (!account) {
            notify('请输入账号', 'warning');
            return;
        }
        fetchCache(account, {});
    }

    function showRefreshConfirm(onConfirm) {
        var existing = document.getElementById('rtRefreshConfirmModal');
        if (existing) existing.remove();
        var modal = document.createElement('div');
        modal.id = 'rtRefreshConfirmModal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:100000;display:flex;align-items:center;justify-content:center;';
        modal.innerHTML = ''
            + '<div style="background:var(--bg-card);border:1px solid rgba(255,196,90,0.4);border-radius:14px;max-width:460px;width:92%;box-shadow:0 18px 60px rgba(0,0,0,0.5);">'
            +   '<div style="padding:22px 26px 14px;border-bottom:1px solid var(--border);">'
            +     '<h3 style="margin:0;color:#ffc45a;font-size:18px;">确认更新数据</h3>'
            +     '<div style="margin-top:10px;color:var(--text-secondary);font-size:14px;line-height:1.75;">'
            +       '如果近期没有新增玩家，建议优先读取缓存，避免重复等待远端组织架构拉取。'
            +     '</div>'
            +     '<div style="margin-top:8px;color:var(--text-secondary);font-size:12px;line-height:1.6;opacity:0.75;">'
            +       '更新数据会重新从上游获取组织架构，耗时可能较长。'
            +     '</div>'
            +   '</div>'
            +   '<div style="display:flex;gap:10px;padding:16px 26px 22px;">'
            +     '<button id="rtRefreshCancelBtn" class="btn" style="flex:1;background:var(--bg-secondary);">取消</button>'
            +     '<button id="rtRefreshConfirmBtn" class="btn btn-primary" style="flex:1;" disabled>确定 (5)</button>'
            +   '</div>'
            + '</div>';
        document.body.appendChild(modal);

        var cancelBtn = document.getElementById('rtRefreshCancelBtn');
        var confirmBtn = document.getElementById('rtRefreshConfirmBtn');
        var remaining = 5;
        var timer = setInterval(function() {
            remaining -= 1;
            if (remaining <= 0) {
                clearInterval(timer);
                timer = null;
                if (confirmBtn) {
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = '确定更新';
                }
            } else if (confirmBtn) {
                confirmBtn.textContent = '确定 (' + remaining + ')';
            }
        }, 1000);

        function close() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
        }

        if (cancelBtn) cancelBtn.onclick = close;
        if (confirmBtn) {
            confirmBtn.onclick = function() {
                if (confirmBtn.disabled) return;
                close();
                try {
                    onConfirm && onConfirm();
                } catch (e) {
                    console.error('[RecommendTreePanel] refresh confirm error', e);
                }
            };
        }
        modal.onclick = function(event) {
            if (event.target === modal) close();
        };
    }

    function doRefreshTree() {
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
            notify('组织架构已更新并写入缓存', 'success');
        }).catch(function(error) {
            store.state.refreshing = false;
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
        showRefreshConfirm(doRefreshTree);
    }

    function loadPromotionPolicy() {
        if (!store.state.isSuperAdmin) return Promise.resolve(null);
        store.state.policyLoading = true;
        render();
        return api.getPromotionPolicy().then(function(result) {
            store.state.policyLoading = false;
            store.setPromotionPolicy(result.item || null);
            render();
            return result;
        }).catch(function(error) {
            store.state.policyLoading = false;
            render();
            notify(error.message || String(error), 'error');
            throw error;
        });
    }

    function refreshCurrentCacheSilently() {
        var account = currentAccount();
        if (!account || !store.state.payload) return Promise.resolve(null);
        return fetchCache(account, { silent: true, quietError: true }).catch(function() {
            return null;
        });
    }

    function togglePromotionPolicy(level) {
        if (!store.state.isSuperAdmin || !level || store.state.policySaving || store.state.policyLoading) return;
        var current = store.state.promotionPolicy || {};
        var next = JSON.parse(JSON.stringify(current || {}));
        next.levels = next.levels || {};
        next.levels[level] = next.levels[level] || {};
        next.levels[level].require_tripod = !next.levels[level].require_tripod;
        store.state.policySaving = true;
        render();
        api.updatePromotionPolicy(next).then(function(result) {
            store.state.policySaving = false;
            store.setPromotionPolicy(result.item || null);
            render();
            notify('晋升策略已更新', 'success');
            refreshCurrentCacheSilently();
        }).catch(function(error) {
            store.state.policySaving = false;
            render();
            notify(error.message || String(error), 'error');
        });
    }

    function start() {
        ensureCss();
        store.state.isSuperAdmin = isSuperAdmin();
        if (!store.state.isSuperAdmin) {
            store.setPromotionPolicy(null);
            store.state.policyLoaded = false;
        }
        if (!initialized) {
            initialized = true;
            render();
        } else {
            render();
        }
        if (store.state.isSuperAdmin) {
            loadPromotionPolicy().catch(function() {});
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
