(function() {
    'use strict';

    if (window.AKMeetingAdminPanelLoaded) return;
    window.AKMeetingAdminPanelLoaded = true;

    const API_ROOT = (typeof API_BASE === 'string' && API_BASE) ? API_BASE : window.location.origin;
    const state = {
        candidates: [],
        candidateSearch: '',
        loading: false,
        savingUsernames: {},
        savingSubAdmins: {},
        showOwnerColumn: true,
        role: '',
        subAdminToggles: []
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

    function loadAll() {
        if (!hasAdminToken()) {
            state.loading = false;
            state.candidates = [];
            render();
            return Promise.resolve();
        }
        state.loading = true;
        render();
        return request('/admin/api/meeting/candidates?limit=300&search=' + encodeURIComponent(state.candidateSearch || ''), { method: 'GET' }).then(function(data) {
            state.candidates = Array.isArray(data.rows) ? data.rows : [];
            state.showOwnerColumn = data.show_owner_column !== false;
            state.role = String(data.role || '');
            state.subAdminToggles = Array.isArray(data.sub_admin_meeting_toggles) ? data.sub_admin_meeting_toggles : [];
            state.loading = false;
            render();
        }).catch(function(error) {
            state.loading = false;
            toast('会议权限加载失败：' + error.message, 'error');
            render();
        });
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
            toast(enabled ? ('已允许子管理员 [' + key + '] 发布会议') : ('已暂停子管理员 [' + key + '] 发布会议'), 'success');
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
            toast('会议发布权限已保存', 'success');
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
            const ownerMeta = state.showOwnerColumn ? `<span>归属：<strong>${escapeHtml(view.owner)}</strong></span><span>过期：${escapeHtml(view.expireText)}</span>` : '';
            const nickname = view.nickname ? `<span>昵称：${escapeHtml(view.nickname)}</span>` : '';
            return `
                <div class="meeting-mobile-card" data-meeting-user="${escapeHtml(view.username)}">
                    <div class="meeting-mobile-top">
                        <div class="meeting-mobile-title"><span>账号</span><strong>${escapeHtml(view.username)}</strong></div>
                        <div class="meeting-mobile-meta">${ownerMeta}${nickname}</div>
                    </div>
                    <div class="meeting-mobile-actions">
                        <label class="meeting-mobile-check"><input type="checkbox" data-meeting-perm="publish" data-meeting-user="${escapeHtml(view.username)}" ${view.rawCanPublish ? 'checked' : ''} ${view.disabled ? 'disabled' : ''}> 允许发布会议</label>
                        <span class="meeting-mobile-status">状态：${escapeHtml(view.stateLabel)}</span>
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
            const stateLabel = saving ? '保存中...' : (enabled ? '允许发布' : '已停用（伞下会议发布暂时失效）');
            return `
                <div class="meeting-mobile-card">
                    <div class="meeting-mobile-top">
                        <div class="meeting-mobile-title"><span>子管理员</span><strong>${escapeHtml(subName)}</strong></div>
                        <div class="meeting-mobile-meta"><span>绑定账号：${escapeHtml(bound || '-')}</span></div>
                    </div>
                    <div class="meeting-mobile-actions">
                        <label class="meeting-mobile-check"><input type="checkbox" data-meeting-sub-toggle="${escapeHtml(subName)}" ${enabled ? 'checked' : ''} ${saving ? 'disabled' : ''}> 允许发布会议</label>
                        <span class="meeting-mobile-status">状态：${escapeHtml(stateLabel)}</span>
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
                <div class="meeting-table-wrap" data-scroll-hint="right" style="overflow-x:auto"><table class="meeting-table"><thead><tr><th>子管理员</th><th>允许发布</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table></div>
            </section>`;
    }

    function render() {
        const mount = document.getElementById('meetingAdminMount');
        if (!mount) return;
        refs.mount = mount;
        mount.innerHTML = `
            <style>
                .meeting-admin-wrap{display:flex;flex-direction:column;gap:16px}.meeting-card{background:rgba(15,23,42,.55);border:1px solid rgba(148,163,184,.18);border-radius:16px;padding:16px}.meeting-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}.meeting-head-main{display:flex;flex-direction:column;gap:4px}.meeting-title{font-size:18px;font-weight:800;color:var(--text-primary)}.meeting-subtitle,.meeting-muted,.meeting-empty{color:var(--text-secondary);font-size:12px}.meeting-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.meeting-search{height:36px;border-radius:9px;border:1px solid rgba(148,163,184,.22);background:rgba(15,23,42,.72);color:var(--text-primary);padding:0 10px;min-width:220px}.meeting-small-btn{border:0;border-radius:10px;padding:8px 12px;background:rgba(59,130,246,.85);color:white;font-weight:700;cursor:pointer;font-size:12px}.meeting-small-btn.danger{background:rgba(239,68,68,.82)}.meeting-small-btn:disabled{opacity:.55;cursor:not-allowed}.meeting-table{width:100%;border-collapse:collapse}.meeting-table th,.meeting-table td{padding:11px 10px;border-bottom:1px solid rgba(148,163,184,.12);text-align:left;vertical-align:top}.meeting-table label{color:var(--text-primary);font-size:13px;white-space:nowrap}.meeting-mobile-list{display:none}.meeting-badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;margin-right:6px;font-size:12px;font-weight:700}.meeting-badge.owned{background:rgba(14,165,233,.18);color:#bae6fd}.meeting-badge.all{background:rgba(168,85,247,.18);color:#e9d5ff}
            </style>
            <style>
                @media (max-width:768px){.meeting-admin-wrap{gap:12px}.meeting-card{padding:14px 12px;border-radius:18px}.meeting-head{gap:10px;margin-bottom:12px}.meeting-title{font-size:20px;line-height:1.2}.meeting-subtitle{font-size:12px;line-height:1.45}.meeting-toolbar{display:grid;grid-template-columns:minmax(0,1fr)72px;width:100%;gap:8px}.meeting-search{min-width:0;width:100%;height:42px;box-sizing:border-box}.meeting-small-btn{min-height:42px;padding:8px 10px}.meeting-table-wrap{display:none}.meeting-mobile-list{display:grid;gap:10px}.meeting-mobile-card{display:grid;gap:12px;padding:12px;border:1px solid rgba(148,163,184,.14);border-radius:14px;background:rgba(15,23,42,.45)}.meeting-mobile-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px 12px;flex-wrap:wrap}.meeting-mobile-title{display:flex;align-items:baseline;gap:8px;min-width:0}.meeting-mobile-title span,.meeting-mobile-meta,.meeting-mobile-status{color:var(--text-secondary);font-size:12px;line-height:1.35}.meeting-mobile-title strong{color:var(--text-primary);font-size:18px;line-height:1.15;white-space:nowrap}.meeting-mobile-meta{display:flex;align-items:baseline;gap:8px 12px;flex-wrap:wrap;min-width:0}.meeting-mobile-meta span{white-space:nowrap}.meeting-mobile-meta strong{color:var(--text-primary);font-size:14px;white-space:nowrap}.meeting-mobile-actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px 12px;align-items:center}.meeting-mobile-check{display:inline-flex;align-items:center;gap:6px;color:var(--text-primary);font-size:14px;font-weight:700;line-height:1.3;white-space:nowrap}.meeting-mobile-check input{width:17px;height:17px;flex:0 0 auto}.meeting-mobile-status{overflow-wrap:anywhere}.meeting-empty{padding:18px 0;text-align:center}}
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
                    <div class="meeting-table-wrap" data-scroll-hint="right" style="overflow-x:auto"><table class="meeting-table"><thead><tr><th>账号</th>${state.showOwnerColumn ? '<th>归属</th>' : ''}<th>允许发布</th><th>状态</th></tr></thead><tbody>${!hasAdminToken() ? `<tr><td colspan="${state.showOwnerColumn ? 4 : 3}" class="meeting-empty">请先登录后台</td></tr>` : (state.loading ? `<tr><td colspan="${state.showOwnerColumn ? 4 : 3}" class="meeting-empty">加载中...</td></tr>` : renderPermissionRows())}</tbody></table></div>
                </section>
            </div>`;
    }

    function bind() {
        const mount = document.getElementById('meetingAdminMount');
        if (!mount || mount.__meetingAdminBound) return;
        mount.__meetingAdminBound = true;
        mount.addEventListener('input', function(event) {
            const search = event.target.closest('[data-meeting-search]');
            if (search) {
                state.candidateSearch = search.value;
                clearTimeout(bind.searchTimer);
                bind.searchTimer = setTimeout(loadAll, 350);
            }
        });
        mount.addEventListener('click', function(event) {
            const refresh = event.target.closest('[data-meeting-refresh]');
            if (refresh) loadAll();
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
