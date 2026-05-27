(function() {
    'use strict';

    if (window.AKMeetingAdminPanelLoaded) return;
    window.AKMeetingAdminPanelLoaded = true;

    const API_ROOT = (typeof API_BASE === 'string' && API_BASE) ? API_BASE : window.location.origin;
    const state = {
        candidates: [],
        candidateSearch: '',
        loading: false,
        loadingSearch: '',
        loadingPromise: null,
        loadSeq: 0,
        savingUsernames: {},
        savingSubAdmins: {},
        showOwnerColumn: true,
        role: '',
        subAdminToggles: [],
        renderHtml: ''
    };
    const refs = {};

    function headers(extra) {
        const base = typeof getHeaders === 'function' ? getHeaders() : {};
        const merged = Object.assign({}, base, extra || {});
        if (!merged.Authorization) {
            const token = sessionStorage.getItem('admin_token') || '';
            if (token) merged.Authorization = `Bearer ${token}`;
        }
        return merged;
    }

    function hasAdminToken() {
        return !!String(sessionStorage.getItem('admin_token') || '').trim();
    }

    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = String(value == null ? '' : value);
        return div.innerHTML;
    }

    function toast(message, type) {
        if (typeof showToast === 'function') {
            showToast(message, type || 'info');
            return;
        }
        window.alert(message);
    }

    function request(path, options) {
        const opts = Object.assign({ credentials: 'include' }, options || {});
        opts.headers = headers(opts.headers || {});
        if (opts.body && typeof opts.body !== 'string') {
            opts.body = JSON.stringify(opts.body);
            opts.headers = Object.assign({}, opts.headers, { 'Content-Type': 'application/json' });
        }
        return fetch(API_ROOT + path, opts).then(function(response) {
            if (typeof checkTokenValid === 'function') checkTokenValid(response);
            return response.json().catch(function() { return {}; }).then(function(data) {
                if (!response.ok || (data && data.error) || data.success === false) {
                    throw new Error((data && data.message) || ('HTTP ' + response.status));
                }
                return data;
            });
        });
    }

    function normalizeUsername(value) {
        return String(value || '').trim().toLowerCase();
    }

    function formatTime(value) {
        if (!value) return '-';
        try {
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return String(value || '-');
            return date.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (e) {
            return String(value || '-');
        }
    }

    function setRowSaving(username, saving) {
        const normalized = normalizeUsername(username);
        if (!normalized) return;
        if (saving) {
            state.savingUsernames[normalized] = true;
        } else {
            delete state.savingUsernames[normalized];
        }
    }

    function isRowSaving(username) {
        return !!state.savingUsernames[normalizeUsername(username)];
    }

    function buildPermissionView(item) {
        const username = normalizeUsername(item.username);
        const rawCanPublish = !!item.can_publish || !!item.can_publish_owned || !!item.can_publish_all;
        const isDefaultBinding = !!item.is_default_admin_binding;
        const subEnabled = item.sub_admin_meeting_enabled !== false;
        const subOwner = String(item.sub_admin_owner || '').trim();
        const effective = !!item.effective_can_publish && subEnabled && rawCanPublish;
        const rowSaving = isRowSaving(username);
        const disabled = rowSaving || isDefaultBinding;
        let stateLabel;
        if (isDefaultBinding) {
            stateLabel = subEnabled ? '默认允许（由子管理员总开关控制）' : '已被总管理员停用';
        } else if (rowSaving) {
            stateLabel = '保存中...';
        } else if (rawCanPublish && !subEnabled) {
            stateLabel = subOwner ? ('已授权，但子管理员 [' + subOwner + '] 已被停用，当前不生效') : '已授权，但当前不生效';
        } else if (effective) {
            stateLabel = '已允许发布';
        } else if (rawCanPublish) {
            stateLabel = '已允许发布';
        } else {
            stateLabel = '未授权';
        }
        return {
            username,
            nickname: String(item.nickname || ''),
            owner: String(item.added_by || '-'),
            expireText: formatTime(item.expire_time),
            rawCanPublish,
            disabled,
            stateLabel
        };
    }

    function loadAll(force) {
        if (!hasAdminToken()) {
            state.loading = false;
            state.candidates = [];
            render();
            return Promise.resolve();
        }
        const search = String(state.candidateSearch || '').trim();
        if (!force && state.loading && state.loadingSearch === search) {
            return state.loadingPromise || Promise.resolve();
        }
        const seq = ++state.loadSeq;
        state.loading = true;
        state.loadingSearch = search;
        render();
        state.loadingPromise = request('/admin/api/meeting/candidates?limit=300&search=' + encodeURIComponent(search), { method: 'GET' }).then(function(data) {
            if (seq !== state.loadSeq || search !== state.candidateSearch) return;
            state.candidates = Array.isArray(data.rows) ? data.rows : [];
            state.showOwnerColumn = data.show_owner_column !== false;
            state.role = String(data.role || '');
            state.subAdminToggles = Array.isArray(data.sub_admin_meeting_toggles) ? data.sub_admin_meeting_toggles : [];
            state.loading = false;
            render();
        }).catch(function(error) {
            if (seq !== state.loadSeq || search !== state.candidateSearch) return;
            state.loading = false;
            toast('会议权限加载失败：' + error.message, 'error');
            render();
        }).finally(function() {
            if (seq === state.loadSeq && search === state.candidateSearch) state.loadingPromise = null;
        });
        return state.loadingPromise;
    }

    function toggleSubAdmin(subName, enabled) {
        const key = String(subName || '').trim();
        if (!key) return Promise.resolve();
        if (!hasAdminToken()) {
            toast('请先登录后台', 'error');
            return Promise.resolve();
        }
        state.savingSubAdmins[key] = true;
        render();
        return request('/admin/api/meeting/sub_admin_toggle', {
            method: 'POST',
            body: { sub_name: key, enabled: !!enabled }
        }).then(function() {
            toast(enabled ? '已允许发布会议' : '已禁止发布会议', 'success');
            delete state.savingSubAdmins[key];
            return loadAll();
        }).catch(function(error) {
            delete state.savingSubAdmins[key];
            toast('操作失败：' + error.message, 'error');
            render();
        });
    }

    function savePermission(username, canPublish) {
        if (!hasAdminToken()) {
            toast('请先登录后台', 'error');
            return Promise.resolve();
        }
        setRowSaving(username, true);
        render();
        return request('/admin/api/meeting/permissions', {
            method: 'POST',
            body: {
                username: username,
                can_publish: !!canPublish
            }
        }).then(function() {
            toast(canPublish ? '已允许发布会议' : '已禁止发布会议', 'success');
            setRowSaving(username, false);
            return loadAll();
        }).catch(function(error) {
            setRowSaving(username, false);
            toast('保存失败：' + error.message, 'error');
            render();
        });
    }

    function renderPermissionRows() {
        const rows = state.candidates.map(function(item) {
            const view = buildPermissionView(item);
            const ownerCell = state.showOwnerColumn ? `<td data-label="归属"><strong>${escapeHtml(view.owner)}</strong><div class="meeting-muted">过期：${escapeHtml(view.expireText)}</div></td>` : '';
            return `
                <tr data-meeting-user="${escapeHtml(view.username)}">
                    <td data-label="账号"><strong>${escapeHtml(view.username)}</strong><div class="meeting-muted">${escapeHtml(view.nickname)}</div></td>
                    ${ownerCell}
                    <td data-label="允许发布"><label><input type="checkbox" data-meeting-perm="publish" data-meeting-user="${escapeHtml(view.username)}" ${view.rawCanPublish ? 'checked' : ''} ${view.disabled ? 'disabled' : ''}> 允许发布会议</label></td>
                    <td data-label="状态"><span class="meeting-muted">${escapeHtml(view.stateLabel)}</span></td>
                </tr>`;
        }).join('');
        return rows || `<tr><td colspan="${state.showOwnerColumn ? 4 : 3}" class="meeting-empty">暂无白名单账号</td></tr>`;
    }

    function renderPermissionCards() {
        const cards = state.candidates.map(function(item) {
            const view = buildPermissionView(item);
            const ownerCell = state.showOwnerColumn
                ? `<div class="meeting-grid-cell"><span class="meeting-grid-label">归属</span><strong class="meeting-grid-value">${escapeHtml(view.owner || '-')}</strong></div>`
                : '';
            const expireCell = state.showOwnerColumn
                ? `<div class="meeting-grid-cell"><span class="meeting-grid-label">过期</span><strong class="meeting-grid-value">${escapeHtml(view.expireText || '-')}</strong></div>`
                : '';
            const nicknameRow = view.nickname
                ? `<div class="meeting-grid-cell meeting-grid-full"><span class="meeting-grid-label">昵称</span><strong class="meeting-grid-value">${escapeHtml(view.nickname)}</strong></div>`
                : '';
            const permTone = view.rawCanPublish ? 'is-on' : 'is-off';
            const disabledClass = view.disabled ? ' is-disabled' : '';
            // 状态仅靠勾选框反映；去掉独立状态文本，使面板更简洁
            return `
                <div class="meeting-mobile-card ${permTone}${disabledClass}" data-meeting-user="${escapeHtml(view.username)}">
                    <div class="meeting-mobile-grid">
                        <div class="meeting-grid-cell"><span class="meeting-grid-label">账号</span><strong class="meeting-grid-value meeting-grid-username">${escapeHtml(view.username)}</strong></div>
                        ${ownerCell}
                        ${expireCell}
                        <label class="meeting-grid-cell meeting-grid-toggle" aria-label="允许发布会议">
                            <input type="checkbox" data-meeting-perm="publish" data-meeting-user="${escapeHtml(view.username)}" ${view.rawCanPublish ? 'checked' : ''} ${view.disabled ? 'disabled' : ''}>
                            <span class="meeting-switch-control" aria-hidden="true"></span>
                        </label>
                        ${nicknameRow}
                    </div>
                </div>`;
        }).join('');
        return cards || '<div class="meeting-empty">暂无白名单账号</div>';
    }

    function renderSubAdminToggles() {
        const toggles = Array.isArray(state.subAdminToggles) ? state.subAdminToggles : [];
        const isSuper = state.role !== 'sub_admin';
        if (!isSuper) {
            if (!toggles.length) return '';
            const mine = toggles[0];
            if (!mine) return '';
            const tip = mine.meeting_publish_enabled
                ? '当前可在用户端发布会议。'
                : '已被总管理员暂停：你及伞下所有账号的会议发布暂时失效。';
            return `
                <section class="meeting-card">
                    <div class="meeting-title">会议发布总开关状态</div>
                    <div class="meeting-subtitle">${escapeHtml(tip)}</div>
                </section>`;
        }
        if (!toggles.length) {
            return `
                <section class="meeting-card">
                    <div class="meeting-title">子管理员会议发布总开关</div>
                    <div class="meeting-subtitle">暂无子管理员。</div>
                </section>`;
        }
        const rows = toggles.map(function(toggle) {
            const subName = String(toggle.sub_name || '').trim();
            const enabled = !!toggle.meeting_publish_enabled;
            const bound = String(toggle.bound_username || '').trim();
            const saving = !!state.savingSubAdmins[subName];
            return `
                <tr>
                    <td data-label="子管理员" class="meeting-subadmin-cell"><strong>${escapeHtml(subName)}</strong><span class="meeting-bound-text">绑定账号：${escapeHtml(bound || '-')}</span></td>
                    <td data-label="允许发布"><label><input type="checkbox" data-meeting-sub-toggle="${escapeHtml(subName)}" ${enabled ? 'checked' : ''} ${saving ? 'disabled' : ''}> 允许发布会议</label></td>
                    <td data-label="状态"><span class="meeting-muted">${saving ? '保存中...' : (enabled ? '允许发布' : '已停用（伞下会议发布暂时失效）')}</span></td>
                </tr>`;
        }).join('');
        const cards = toggles.map(function(toggle) {
            const subName = String(toggle.sub_name || '').trim();
            const enabled = !!toggle.meeting_publish_enabled;
            const bound = String(toggle.bound_username || '').trim();
            const saving = !!state.savingSubAdmins[subName];
            const permTone = enabled ? 'is-on' : 'is-off';
            const disabledClass = saving ? ' is-disabled' : '';
            // 状态仅靠 toggle 反映；保存中以 saving 微提示
            const savingHint = saving ? '<div class="meeting-grid-cell meeting-grid-full"><span class="meeting-grid-label">保存中…</span></div>' : '';
            return `
                <div class="meeting-mobile-card meeting-card-3col ${permTone}${disabledClass}">
                    <div class="meeting-mobile-grid">
                        <div class="meeting-grid-cell"><span class="meeting-grid-label">子管理员</span><strong class="meeting-grid-value meeting-grid-username">${escapeHtml(subName)}</strong></div>
                        <div class="meeting-grid-cell"><span class="meeting-grid-label">绑定账号</span><strong class="meeting-grid-value">${escapeHtml(bound || '-')}</strong></div>
                        <label class="meeting-grid-cell meeting-grid-toggle" aria-label="允许发布会议">
                            <input type="checkbox" data-meeting-sub-toggle="${escapeHtml(subName)}" ${enabled ? 'checked' : ''} ${saving ? 'disabled' : ''}>
                            <span class="meeting-switch-control" aria-hidden="true"></span>
                        </label>
                        ${savingHint}
                    </div>
                </div>`;
        }).join('');
        return `
            <section class="meeting-card">
                <div class="meeting-head">
                    <div class="meeting-head-main">
                        <div class="meeting-title">子管理员会议发布总开关</div>
                        <div class="meeting-subtitle">关闭后，此子管理员的绑定账号与伞下全部账号的会议发布能力暂时失效，授权数据不变。</div>
                    </div>
                </div>
                <div class="meeting-mobile-list">${cards}</div>
                <div class="meeting-table-wrap" data-ak-sticky-table data-ak-sticky-table-min-width="620" data-ak-sticky-first-column-min="120" data-ak-sticky-first-column-max="180" style="overflow-x:auto"><table class="meeting-table"><thead><tr><th>子管理员</th><th>允许发布</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table></div>
            </section>`;
    }

    function refreshStickyTables() {
        if (!refs.mount || !window.AKStickyTable || typeof window.AKStickyTable.enhanceAll !== 'function') return;
        window.AKStickyTable.enhanceAll(refs.mount);
    }

    function render() {
        const mount = document.getElementById('meetingAdminMount');
        if (!mount) return;
        refs.mount = mount;
        const html = `
            <style>
.meeting-admin-wrap{display:flex;flex-direction:column;gap:16px}.meeting-card{background:linear-gradient(135deg,var(--bg-card),rgba(0,212,255,.04));border:1px solid var(--border);border-radius:16px;padding:16px}.meeting-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}.meeting-head-main{display:flex;flex-direction:column;gap:4px}.meeting-title{font-size:18px;font-weight:800;color:var(--text-primary)}.meeting-subtitle,.meeting-muted,.meeting-empty{color:var(--text-secondary);font-size:12px}.meeting-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.meeting-search{height:36px;border-radius:9px;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);padding:0 10px;min-width:220px;transition:border-color .2s,box-shadow .2s}.meeting-search:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,212,255,.18)}.meeting-small-btn{border:0;border-radius:10px;padding:8px 14px;background:linear-gradient(135deg,var(--accent),#00b8d9);color:#0a1929;font-weight:700;cursor:pointer;font-size:12px;transition:transform .15s,box-shadow .2s}.meeting-small-btn:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,212,255,.32)}.meeting-small-btn.danger{background:linear-gradient(135deg,#ff5252,#ef4444);color:#fff}.meeting-small-btn:disabled{opacity:.55;cursor:not-allowed}.meeting-table{width:100%;border-collapse:collapse}.meeting-table th,.meeting-table td{padding:11px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}.meeting-table label{color:var(--text-primary);font-size:13px;white-space:nowrap}.meeting-mobile-list{display:none}.meeting-badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;margin-right:6px;font-size:12px;font-weight:700}.meeting-badge.owned{background:rgba(0,212,255,.16);color:#7ee5ff}.meeting-badge.all{background:rgba(168,85,247,.18);color:#e9d5ff}
            </style>
            <style>
.meeting-mobile-list{display:none!important;gap:12px}.meeting-mobile-card{position:relative;display:block;padding:14px;border:1px solid var(--border);border-radius:14px;background:linear-gradient(135deg,var(--bg-secondary),rgba(0,212,255,.03));transition:border-color .22s ease,box-shadow .22s ease,transform .22s ease}.meeting-mobile-card.is-on{border-color:rgba(0,212,255,.45);box-shadow:0 0 0 1px rgba(0,212,255,.18),0 6px 16px rgba(0,212,255,.08)}.meeting-mobile-card.is-disabled{opacity:.7}.meeting-mobile-card:hover{transform:translateY(-1px);border-color:var(--accent)}.meeting-mobile-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px;align-items:stretch}.meeting-mobile-card.meeting-card-3col .meeting-mobile-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto}.meeting-mobile-card.meeting-card-3col .meeting-grid-toggle{white-space:nowrap;flex-wrap:nowrap}.meeting-mobile-card.meeting-card-3col .meeting-grid-toggle .meeting-grid-label{white-space:nowrap;writing-mode:horizontal-tb;flex:0 0 auto}.meeting-grid-cell{display:flex;flex-direction:column;gap:3px;min-width:0;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid rgba(148,163,184,.08)}.meeting-grid-cell.meeting-grid-full{grid-column:1 / -1}.meeting-grid-label{color:var(--text-secondary);font-size:11px;line-height:1.2;letter-spacing:.5px}.meeting-grid-value{color:var(--text-primary);font-size:14px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meeting-grid-value.meeting-grid-username{color:var(--accent);font-size:15px;font-weight:700;letter-spacing:.3px}.meeting-grid-cell.meeting-grid-toggle{flex-direction:row;align-items:center;justify-content:center;gap:10px;cursor:pointer;background:rgba(0,212,255,.06);border-color:rgba(0,212,255,.18)}.meeting-mobile-card.is-on .meeting-grid-cell.meeting-grid-toggle{background:linear-gradient(135deg,rgba(0,212,255,.18),rgba(0,212,255,.08));border-color:rgba(0,212,255,.4)}.meeting-grid-cell.meeting-grid-toggle .meeting-grid-label{color:var(--text-primary);font-size:13px;font-weight:600;letter-spacing:0}.meeting-mobile-card.is-on .meeting-grid-cell.meeting-grid-toggle .meeting-grid-label{color:var(--accent)}.meeting-grid-cell.meeting-grid-toggle input[type=checkbox]{appearance:none;-webkit-appearance:none;width:42px;height:24px;border-radius:999px;background:rgba(148,163,184,.32);position:relative;cursor:pointer;flex:0 0 auto;transition:background .22s ease,box-shadow .22s ease;border:none;outline:none;margin:0}.meeting-grid-cell.meeting-grid-toggle input[type=checkbox]::before{content:'';position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.32);transition:transform .22s cubic-bezier(.32,.72,.4,1.2)}.meeting-grid-cell.meeting-grid-toggle input[type=checkbox]:checked{background:linear-gradient(135deg,var(--accent),#00b8d9);box-shadow:0 0 0 1px rgba(0,212,255,.5),0 0 12px rgba(0,212,255,.35)}.meeting-grid-cell.meeting-grid-toggle input[type=checkbox]:checked::before{transform:translateX(18px)}.meeting-grid-cell.meeting-grid-toggle input[type=checkbox]:disabled{opacity:.55;cursor:not-allowed}.meeting-empty{padding:18px 0;text-align:center}@media (max-width:768px){.meeting-admin-wrap{gap:12px}.meeting-card{padding:14px 12px;border-radius:18px}.meeting-head{gap:10px;margin-bottom:12px}.meeting-title{font-size:20px;line-height:1.2}.meeting-subtitle{font-size:12px;line-height:1.45}.meeting-toolbar{display:grid;grid-template-columns:minmax(0,1fr) 72px;width:100%;gap:8px}.meeting-search{min-width:0;width:100%;height:42px;box-sizing:border-box}.meeting-small-btn{min-height:42px;padding:8px 10px}.meeting-table-wrap{display:block;overflow:auto}.meeting-mobile-grid{gap:8px 10px}.meeting-grid-value{font-size:13px}.meeting-grid-value.meeting-grid-username{font-size:14px}}
            </style>
            <style>
.meeting-grid-cell.meeting-grid-toggle{min-width:72px;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.035);border-color:rgba(255,255,255,.08);box-shadow:none}.meeting-mobile-card.is-on .meeting-grid-cell.meeting-grid-toggle{background:rgba(0,212,255,.06);border-color:rgba(0,212,255,.24);box-shadow:none}.meeting-grid-toggle input{position:absolute;opacity:0;pointer-events:none}.meeting-switch-control{position:relative;display:block;width:46px;height:26px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.1);box-shadow:inset 0 0 0 1px rgba(0,0,0,.12);transition:background .2s ease,border-color .2s ease,box-shadow .2s ease}.meeting-switch-control::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#d8e5ec;box-shadow:0 2px 6px rgba(0,0,0,.28);transition:transform .2s ease,background .2s ease}.meeting-grid-toggle input:checked+.meeting-switch-control{border-color:rgba(0,255,136,.65);background:linear-gradient(135deg,#00d4ff,#00ff88);box-shadow:0 0 16px rgba(0,255,136,.18)}.meeting-grid-toggle input:checked+.meeting-switch-control::after{transform:translateX(20px);background:#fff}.meeting-grid-toggle input:disabled+.meeting-switch-control{opacity:.62}
            </style>
            <div class="meeting-admin-wrap">
                ${renderSubAdminToggles()}
                <section class="meeting-card">
                    <div class="meeting-head">
                        <div class="meeting-head-main">
                            <div class="meeting-title">会议发布权限管理</div>
                            <div class="meeting-subtitle">这里只授权账号是否可以在用户端发布会议，发布范围由用户端发布时选择。子管理员被停用时，伞下已授权账号会暂时失效。</div>
                        </div>
                        <div class="meeting-toolbar">
                            <input class="meeting-search" data-meeting-search="1" value="${escapeHtml(state.candidateSearch)}" placeholder="搜索账号或昵称">
                            <button type="button" class="meeting-small-btn" data-meeting-refresh="1">${state.loading ? '加载中...' : '刷新'}</button>
                        </div>
                    </div>
                    ${!hasAdminToken() ? '<div class="meeting-mobile-list"><div class="meeting-empty">请先登录后台</div></div>' : (state.loading ? '<div class="meeting-mobile-list"><div class="meeting-empty">加载中...</div></div>' : '<div class="meeting-mobile-list">' + renderPermissionCards() + '</div>')}
                    <div class="meeting-table-wrap" data-ak-sticky-table data-ak-sticky-table-min-width="${state.showOwnerColumn ? 860 : 720}" data-ak-sticky-first-column-min="120" data-ak-sticky-first-column-max="180" style="overflow-x:auto"><table class="meeting-table"><thead><tr><th>账号</th>${state.showOwnerColumn ? '<th>归属</th>' : ''}<th>允许发布</th><th>状态</th></tr></thead><tbody>${!hasAdminToken() ? `<tr><td colspan="${state.showOwnerColumn ? 4 : 3}" class="meeting-empty">请先登录后台</td></tr>` : (state.loading ? `<tr><td colspan="${state.showOwnerColumn ? 4 : 3}" class="meeting-empty">加载中...</td></tr>` : renderPermissionRows())}</tbody></table></div>
                </section>
            </div>`;
        if (state.renderHtml === html) return;
        mount.innerHTML = html;
        state.renderHtml = html;
        requestAnimationFrame(refreshStickyTables);
    }

    function bind() {
        const mount = document.getElementById('meetingAdminMount');
        if (!mount || mount.__meetingAdminBound) return;
        mount.__meetingAdminBound = true;
        mount.addEventListener('input', function(event) {
            const search = event.target.closest('[data-meeting-search]');
            if (search) {
                const nextSearch = String(search.value || '').trim();
                if (state.candidateSearch === nextSearch) return;
                state.candidateSearch = nextSearch;
                clearTimeout(bind.searchTimer);
                bind.searchTimer = setTimeout(loadAll, 350);
            }
        });
        mount.addEventListener('click', function(event) {
            const refresh = event.target.closest('[data-meeting-refresh]');
            if (refresh) loadAll(true);
        });
        mount.addEventListener('change', function(event) {
            const subToggle = event.target.closest('[data-meeting-sub-toggle]');
            if (subToggle) {
                const subName = subToggle.getAttribute('data-meeting-sub-toggle') || '';
                if (subName) toggleSubAdmin(subName, !!subToggle.checked);
                return;
            }
            const checkbox = event.target.closest('[data-meeting-perm="publish"]');
            if (!checkbox) return;
            const username = checkbox.getAttribute('data-meeting-user') || '';
            if (!username) return;
            savePermission(username, !!checkbox.checked);
        });
    }

    function init() {
        bind();
        render();
        loadAll();
    }

    window.AKMeetingAdminPanel = { init: init, reload: loadAll };
    window.addEventListener('ak-admin-auth-ready', loadAll);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
