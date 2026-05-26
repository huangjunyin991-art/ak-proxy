(function() {
    'use strict';

    if (window.AKRiskIsolationPanelLoaded) return;
    window.AKRiskIsolationPanelLoaded = true;

    var state = {
        loading: false,
        saving: false,
        loaded: false,
        role: '',
        subName: '',
        subAdmins: [],
        selectedSubAdmin: '',
        search: '',
        total: 0,
        isolatedTotal: 0,
        rows: []
    };
    var STYLE_ID = 'akRiskIsolationPanelStyle';
    var dropdownDocumentHandlerBound = false;

    function token() {
        return sessionStorage.getItem('admin_token') || '';
    }

    function mount() {
        return document.getElementById('riskIsolationPanelMount');
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>'"]/g, function(ch) {
            return {'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[ch] || ch;
        });
    }

    function jsArg(value) {
        return JSON.stringify(String(value == null ? '' : value));
    }

    function notify(message, type) {
        try {
            if (typeof showToast === 'function') {
                showToast(message, type || 'info');
                return;
            }
        } catch (e) {}
        window.alert(message);
    }

    function api(path) {
        return fetch('/admin/api/risk-isolation' + path, {
            headers: { 'Authorization': 'Bearer ' + token() },
            credentials: 'same-origin'
        }).then(function(resp) {
            return resp.json().then(function(body) {
                if (!resp.ok || body.error || body.success === false) throw new Error(body.message || body.detail || '风险隔离接口请求失败');
                return body;
            });
        });
    }

    function apiPost(path, payload) {
        return fetch('/admin/api/risk-isolation' + path, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token(),
                'Content-Type': 'application/json'
            },
            credentials: 'same-origin',
            body: JSON.stringify(payload || {})
        }).then(function(resp) {
            return resp.json().then(function(body) {
                if (!resp.ok || body.error || body.success === false) throw new Error(body.message || body.detail || '风险隔离接口请求失败');
                return body;
            });
        });
    }

    function isSuperAdmin() {
        return state.role === 'super_admin';
    }

    function fmtTime(value) {
        if (!value) return '-';
        try {
            return new Date(value.replace(' ', 'T')).toLocaleString();
        } catch (e) {
            return value;
        }
    }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = '#riskIsolationPanelMount{display:block}.ri-wrap{display:flex;flex-direction:column;gap:16px}.ri-card{border:1px solid var(--border);border-radius:16px;background:linear-gradient(135deg,var(--bg-card),rgba(255,71,87,.05));padding:16px}.ri-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}.ri-title{color:var(--accent);font-size:18px;font-weight:800}.ri-desc{color:var(--text-secondary);font-size:12px;margin-top:4px;line-height:1.5}.ri-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.ri-stat{border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.035);padding:14px}.ri-stat-label{font-size:12px;color:var(--text-secondary)}.ri-stat-value{font-size:24px;font-weight:800;color:var(--accent);margin-top:5px}.ri-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.ri-input{min-height:38px;border:1px solid var(--border);border-radius:10px;padding:8px 10px;color:var(--text-primary);background:var(--bg-primary);font-size:13px;outline:none}.ri-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,212,255,.12)}.ri-scope-dropdown{position:relative;min-width:198px;z-index:20}.ri-scope-trigger{width:100%;min-height:40px;border:1px solid rgba(255,221,87,.82);border-radius:18px;padding:8px 14px 8px 18px;color:#fff;background:linear-gradient(180deg,rgba(6,18,34,.98),rgba(9,24,44,.98));font-size:18px;font-weight:800;line-height:1.2;display:flex;align-items:center;justify-content:space-between;gap:14px;cursor:pointer;outline:none;box-shadow:0 0 0 2px rgba(255,221,87,.08),0 10px 24px rgba(0,0,0,.28)}.ri-scope-trigger:focus{border-color:#ffdf5d;box-shadow:0 0 0 3px rgba(255,221,87,.18),0 10px 24px rgba(0,0,0,.28)}.ri-scope-caret{font-size:20px;line-height:1;transition:transform .16s ease}.ri-scope-menu{position:absolute;left:0;right:0;top:calc(100% - 1px);display:none;overflow:hidden;border:1px solid rgba(255,221,87,.82);border-top:0;border-radius:0 0 14px 14px;background:linear-gradient(180deg,rgba(9,24,44,.99),#242c39);box-shadow:0 16px 34px rgba(0,0,0,.42),0 0 0 2px rgba(255,221,87,.08);z-index:30}.ri-scope-dropdown.open .ri-scope-trigger{border-bottom-color:transparent;border-bottom-left-radius:0;border-bottom-right-radius:0;box-shadow:0 0 0 2px rgba(255,221,87,.08)}.ri-scope-dropdown.open .ri-scope-caret{transform:rotate(180deg)}.ri-scope-dropdown.open .ri-scope-menu{display:block}.ri-scope-option{width:100%;border:0;border-top:1px solid rgba(255,255,255,.05);background:transparent;color:#fff;padding:9px 20px;text-align:left;font-size:18px;font-weight:800;line-height:1.25;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer}.ri-scope-option:first-child{border-top:0}.ri-scope-option:hover,.ri-scope-option.active{background:#2d6cdf}.ri-scope-count{font-size:16px;color:#fff;font-weight:800;white-space:nowrap}.ri-btn{border:0;border-radius:10px;padding:9px 14px;background:linear-gradient(135deg,#00d4ff,#667eea);color:#fff;font-weight:700;cursor:pointer}.ri-btn.secondary{background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border)}.ri-btn.danger{background:linear-gradient(135deg,#ff4757,#ff6b81)}.ri-btn.success{background:linear-gradient(135deg,#00c851,#00ff88);color:#051018}.ri-btn:disabled,.ri-scope-trigger:disabled{opacity:.55;cursor:not-allowed}.ri-table-wrap{overflow-x:auto}.ri-table{width:100%;border-collapse:collapse;min-width:920px}.ri-table th,.ri-table td{padding:10px 12px;border-bottom:1px solid var(--border);text-align:left;font-size:13px}.ri-table th{color:var(--accent);font-weight:800;background:rgba(0,212,255,.04)}.ri-muted{color:var(--text-secondary)}.ri-pill{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:700}.ri-pill.on{background:rgba(255,71,87,.16);color:#ff6b81}.ri-pill.off{background:rgba(0,255,136,.12);color:#00ff88}.ri-empty{text-align:center;color:var(--text-secondary);padding:28px 0}.ri-cards{display:none}.ri-user-card{border:1px solid var(--border);border-radius:14px;background:rgba(255,255,255,.035);padding:14px;display:flex;flex-direction:column;gap:10px}.ri-user-head{display:flex;justify-content:space-between;gap:10px}.ri-user-name{font-weight:800;color:var(--text-primary)}.ri-user-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.ri-user-label{font-size:11px;color:var(--text-secondary)}.ri-user-value{font-size:13px;color:var(--text-primary);word-break:break-all}@media(max-width:760px){.ri-table-wrap{display:none}.ri-cards{display:grid;gap:12px}.ri-toolbar{align-items:stretch}.ri-input,.ri-scope-dropdown,.ri-btn{width:100%}.ri-user-grid{grid-template-columns:1fr}}';
        document.head.appendChild(style);
    }

    function buildShell() {
        var root = mount();
        if (!root) return;
        injectStyle();
        root.innerHTML = '<div class="ri-wrap">' +
            '<section class="ri-card"><div class="ri-head"><div><div class="ri-title">风险隔离</div><div class="ri-desc">隔离白名单玩家后，该玩家调用 /RPC/Login 将直接得到 404；子管理员仅能管理自己名下白名单玩家。</div></div><button class="ri-btn secondary" id="riRefreshBtn">刷新</button></div></section>' +
            '<section class="ri-stats"><div class="ri-stat"><div class="ri-stat-label">当前范围玩家</div><div class="ri-stat-value" id="riTotal">-</div></div><div class="ri-stat"><div class="ri-stat-label">已隔离玩家</div><div class="ri-stat-value" id="riIsolatedTotal">-</div></div><div class="ri-stat"><div class="ri-stat-label">当前范围</div><div class="ri-stat-value" id="riScopeLabel" style="font-size:16px;line-height:1.5;">-</div></div></section>' +
            '<section class="ri-card"><div class="ri-toolbar"><div class="ri-scope-dropdown" id="riSubAdminDropdown" style="display:none;"><button type="button" class="ri-scope-trigger" id="riSubAdminTrigger"><span id="riSubAdminTriggerText">全部白名单</span><span class="ri-scope-caret">⌄</span></button><div class="ri-scope-menu" id="riSubAdminMenu"></div></div><input class="ri-input" id="riSearch" placeholder="搜索账号/姓名"><button class="ri-btn secondary" id="riSearchBtn">搜索</button><button class="ri-btn danger" id="riIsolateAllBtn">一键隔离当前范围</button></div></section>' +
            '<section class="ri-card"><div class="ri-table-wrap"><table class="ri-table"><thead><tr><th>账号</th><th>姓名</th><th>添加人</th><th>到期时间</th><th>隔离状态</th><th>隔离人</th><th>隔离时间</th><th>操作</th></tr></thead><tbody id="riTableBody"><tr><td colspan="8" class="ri-empty">加载中...</td></tr></tbody></table></div><div class="ri-cards" id="riCardList"></div></section>' +
        '</div>';
        bindEvents();
    }

    function bindEvents() {
        var refreshBtn = document.getElementById('riRefreshBtn');
        var searchBtn = document.getElementById('riSearchBtn');
        var searchInput = document.getElementById('riSearch');
        var subDropdown = document.getElementById('riSubAdminDropdown');
        var subTrigger = document.getElementById('riSubAdminTrigger');
        var isolateAllBtn = document.getElementById('riIsolateAllBtn');
        if (refreshBtn) refreshBtn.onclick = function() { loadAccounts(); };
        if (searchBtn) searchBtn.onclick = function() { state.search = searchInput ? searchInput.value.trim() : ''; loadAccounts(); };
        if (searchInput) searchInput.onkeyup = function(event) { if (event.key === 'Enter') { state.search = searchInput.value.trim(); loadAccounts(); } };
        if (subTrigger && subDropdown) subTrigger.onclick = function(event) {
            event.stopPropagation();
            if (state.loading) return;
            subDropdown.classList.toggle('open');
        };
        if (subDropdown) subDropdown.onclick = function(event) {
            var option = event.target.closest('[data-ri-sub-admin]');
            if (!option) return;
            event.stopPropagation();
            state.selectedSubAdmin = option.getAttribute('data-ri-sub-admin') || '';
            subDropdown.classList.remove('open');
            renderSubAdmins();
            loadAccounts();
        };
        if (!dropdownDocumentHandlerBound) {
            document.addEventListener('click', closeSubAdminDropdown);
            dropdownDocumentHandlerBound = true;
        }
        if (isolateAllBtn) isolateAllBtn.onclick = isolateAll;
    }

    function closeSubAdminDropdown() {
        var dropdown = document.getElementById('riSubAdminDropdown');
        if (dropdown) dropdown.classList.remove('open');
    }

    function updateHeader() {
        var totalEl = document.getElementById('riTotal');
        var isolatedEl = document.getElementById('riIsolatedTotal');
        var scopeEl = document.getElementById('riScopeLabel');
        if (totalEl) totalEl.textContent = String(state.total || 0);
        if (isolatedEl) isolatedEl.textContent = String(state.isolatedTotal || 0);
        if (scopeEl) scopeEl.textContent = isSuperAdmin() ? (state.selectedSubAdmin ? state.selectedSubAdmin : '全部白名单') : (state.subName || '当前子管理员');
    }

    function renderSubAdmins() {
        var dropdown = document.getElementById('riSubAdminDropdown');
        var triggerText = document.getElementById('riSubAdminTriggerText');
        var menu = document.getElementById('riSubAdminMenu');
        if (!dropdown || !triggerText || !menu) return;
        if (!isSuperAdmin()) {
            dropdown.style.display = 'none';
            return;
        }
        dropdown.style.display = '';
        var selectedName = state.selectedSubAdmin || '';
        var selectedItem = (state.subAdmins || []).filter(function(item) {
            return item.name === selectedName;
        })[0];
        triggerText.textContent = selectedItem ? selectedItem.name : '全部白名单';
        menu.innerHTML = '<button type="button" class="ri-scope-option' + (!selectedName ? ' active' : '') + '" data-ri-sub-admin=""><span>全部白名单</span></button>' + (state.subAdmins || []).map(function(item) {
            var name = String(item.name || '');
            var active = name === selectedName ? ' active' : '';
            var count = (item.isolated_count || 0) + '/' + (item.active_count || 0);
            return '<button type="button" class="ri-scope-option' + active + '" data-ri-sub-admin="' + escapeHtml(name) + '"><span>' + escapeHtml(name) + '</span><span class="ri-scope-count">(' + escapeHtml(count) + ')</span></button>';
        }).join('');
    }

    function renderRows() {
        updateHeader();
        var tbody = document.getElementById('riTableBody');
        var cardList = document.getElementById('riCardList');
        var rows = state.rows || [];
        if (!rows.length) {
            if (tbody) tbody.innerHTML = '<tr><td colspan="8" class="ri-empty">当前范围暂无白名单玩家</td></tr>';
            if (cardList) cardList.innerHTML = '<div class="ri-user-card ri-muted">当前范围暂无白名单玩家</div>';
            return;
        }
        if (tbody) {
            tbody.innerHTML = rows.map(function(row) {
                var action = row.isolated
                    ? '<button class="ri-btn success" onclick="window.AKRiskIsolationPanel.releaseUser(' + jsArg(row.username) + ')">解除</button>'
                    : '<button class="ri-btn danger" onclick="window.AKRiskIsolationPanel.isolateUser(' + jsArg(row.username) + ')">隔离</button>';
                return '<tr><td style="font-weight:800;">' + escapeHtml(row.username) + '</td><td>' + escapeHtml(row.nickname || '-') + '</td><td>' + escapeHtml(row.added_by === 'super_admin' ? '系统总管理' : (row.added_by || '-')) + '</td><td>' + escapeHtml(fmtTime(row.expire_time)) + '</td><td>' + statusPill(row.isolated) + '</td><td>' + escapeHtml(row.isolated_by || '-') + '</td><td>' + escapeHtml(fmtTime(row.isolated_at)) + '</td><td>' + action + '</td></tr>';
            }).join('');
        }
        if (cardList) {
            cardList.innerHTML = rows.map(function(row) {
                var action = row.isolated
                    ? '<button class="ri-btn success" onclick="window.AKRiskIsolationPanel.releaseUser(' + jsArg(row.username) + ')">解除隔离</button>'
                    : '<button class="ri-btn danger" onclick="window.AKRiskIsolationPanel.isolateUser(' + jsArg(row.username) + ')">隔离玩家</button>';
                return '<div class="ri-user-card"><div class="ri-user-head"><div class="ri-user-name">' + escapeHtml(row.username) + '</div>' + statusPill(row.isolated) + '</div><div class="ri-user-grid"><div><div class="ri-user-label">姓名</div><div class="ri-user-value">' + escapeHtml(row.nickname || '-') + '</div></div><div><div class="ri-user-label">添加人</div><div class="ri-user-value">' + escapeHtml(row.added_by === 'super_admin' ? '系统总管理' : (row.added_by || '-')) + '</div></div><div><div class="ri-user-label">到期时间</div><div class="ri-user-value">' + escapeHtml(fmtTime(row.expire_time)) + '</div></div><div><div class="ri-user-label">隔离人</div><div class="ri-user-value">' + escapeHtml(row.isolated_by || '-') + '</div></div></div>' + action + '</div>';
            }).join('');
        }
    }

    function statusPill(isolated) {
        return isolated ? '<span class="ri-pill on">已隔离</span>' : '<span class="ri-pill off">正常</span>';
    }

    function setBusy(busy) {
        state.loading = !!busy;
        if (busy) closeSubAdminDropdown();
        ['riRefreshBtn', 'riSearchBtn', 'riIsolateAllBtn', 'riSubAdminTrigger', 'riSearch'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.disabled = !!busy;
        });
    }

    function scopePayload() {
        return isSuperAdmin() ? { sub_admin: state.selectedSubAdmin || '' } : {};
    }

    function loadStatus() {
        return api('/status').then(function(data) {
            state.role = data.role || sessionStorage.getItem('admin_role') || '';
            state.subName = data.sub_name || sessionStorage.getItem('admin_role_name') || '';
            state.subAdmins = data.sub_admins || [];
            renderSubAdmins();
        });
    }

    function loadAccounts() {
        setBusy(true);
        var params = new URLSearchParams({ limit: '200', offset: '0' });
        if (state.search) params.append('search', state.search);
        if (isSuperAdmin() && state.selectedSubAdmin) params.append('sub_admin', state.selectedSubAdmin);
        return api('/accounts?' + params.toString()).then(function(data) {
            state.total = data.total || 0;
            state.isolatedTotal = data.isolated_total || 0;
            state.rows = data.rows || [];
            renderRows();
        }).catch(function(err) {
            notify(err.message || '加载风险隔离列表失败', 'error');
        }).finally(function() {
            setBusy(false);
        });
    }

    function isolateUser(username) {
        var reason = window.prompt('隔离原因（可选）', '') || '';
        setBusy(true);
        return apiPost('/isolate', Object.assign(scopePayload(), { usernames: [username], reason: reason })).then(function(data) {
            notify(data.message || '已隔离');
            return loadStatus().then(loadAccounts);
        }).catch(function(err) {
            notify(err.message || '隔离失败', 'error');
        }).finally(function() {
            setBusy(false);
        });
    }

    function releaseUser(username) {
        if (!window.confirm('确定解除该玩家的风险隔离吗？')) return;
        setBusy(true);
        return apiPost('/release', Object.assign(scopePayload(), { usernames: [username] })).then(function(data) {
            notify(data.message || '已解除');
            return loadStatus().then(loadAccounts);
        }).catch(function(err) {
            notify(err.message || '解除失败', 'error');
        }).finally(function() {
            setBusy(false);
        });
    }

    function isolateAll() {
        if (isSuperAdmin() && !state.selectedSubAdmin) {
            notify('请先选择一个子管理员范围，再执行一键隔离', 'warning');
            return;
        }
        var label = isSuperAdmin() ? state.selectedSubAdmin : (state.subName || '当前子管理员');
        if (!window.confirm('确定隔离 [' + label + '] 名下全部白名单玩家吗？')) return;
        var reason = window.prompt('隔离原因（可选）', '') || '';
        setBusy(true);
        return apiPost('/isolate_scope', Object.assign(scopePayload(), { reason: reason })).then(function(data) {
            notify(data.message || '已批量隔离');
            return loadStatus().then(loadAccounts);
        }).catch(function(err) {
            notify(err.message || '批量隔离失败', 'error');
        }).finally(function() {
            setBusy(false);
        });
    }

    function start() {
        buildShell();
        if (!state.loaded) {
            state.loaded = true;
            loadStatus().then(loadAccounts).catch(function(err) {
                notify(err.message || '风险隔离模块不可用', 'error');
            });
            return;
        }
        renderSubAdmins();
        renderRows();
    }

    window.AKRiskIsolationPanel = {
        start: start,
        isolateUser: isolateUser,
        releaseUser: releaseUser,
        reload: function() { return loadStatus().then(loadAccounts); }
    };
})();
