(function() {
    'use strict';

    if (window.AKMeetingAdminPanelLoaded) return;
    window.AKMeetingAdminPanelLoaded = true;

    const API_ROOT = (typeof API_BASE === 'string' && API_BASE) ? API_BASE : window.location.origin;
    const state = {
        candidates: [],
        candidateSearch: '',
        loading: false,
        saving: false
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
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (e) {
            return String(value || '-');
        }
    }

    function loadAll() {
        state.loading = true;
        render();
        return request('/admin/api/meeting/candidates?limit=300&search=' + encodeURIComponent(state.candidateSearch || ''), { method: 'GET' }).then(function(data) {
            state.candidates = Array.isArray(data.rows) ? data.rows : [];
            state.loading = false;
            render();
        }).catch(function(error) {
            state.loading = false;
            toast('会议权限加载失败：' + error.message, 'error');
            render();
        });
    }

    function savePermission(username, owned, all) {
        state.saving = true;
        render();
        return request('/admin/api/meeting/permissions', {
            method: 'POST',
            body: {
                username: username,
                can_publish_owned: !!owned,
                can_publish_all: !!all
            }
        }).then(function() {
            toast('会议发布权限已保存', 'success');
            return loadAll();
        }).catch(function(error) {
            state.saving = false;
            toast('保存失败：' + error.message, 'error');
            render();
        });
    }

    function revokePermission(username) {
        if (!window.confirm('确定收回该账号的全部会议发布权限？')) return;
        state.saving = true;
        render();
        request('/admin/api/meeting/permissions/revoke', {
            method: 'POST',
            body: { username: username }
        }).then(function() {
            toast('会议发布权限已收回', 'success');
            return loadAll();
        }).catch(function(error) {
            state.saving = false;
            toast('收回失败：' + error.message, 'error');
            render();
        });
    }

    function renderPermissionRows() {
        const rows = state.candidates.map(function(item) {
            const username = normalizeUsername(item.username);
            const owned = !!item.can_publish_owned;
            const all = !!item.can_publish_all;
            return `
                <tr data-meeting-user="${escapeHtml(username)}">
                    <td><strong>${escapeHtml(username)}</strong><div class="meeting-muted">${escapeHtml(item.nickname || '')}</div></td>
                    <td><strong>${escapeHtml(item.added_by || '-')}</strong><div class="meeting-muted">过期：${escapeHtml(formatTime(item.expire_time))}</div></td>
                    <td>${owned || all ? [owned ? '<span class="meeting-badge owned">伞下</span>' : '', all ? '<span class="meeting-badge all">全体</span>' : ''].join('') : '<span class="meeting-muted">未授权</span>'}</td>
                    <td><label><input type="checkbox" data-meeting-perm="owned" ${owned ? 'checked' : ''}> 发布给伞下玩家</label></td>
                    <td><label><input type="checkbox" data-meeting-perm="all" ${all ? 'checked' : ''}> 发布给全体玩家</label></td>
                    <td>
                        <button type="button" class="meeting-small-btn" data-meeting-save="${escapeHtml(username)}" ${state.saving ? 'disabled' : ''}>保存</button>
                        <button type="button" class="meeting-small-btn danger" data-meeting-revoke="${escapeHtml(username)}" ${state.saving ? 'disabled' : ''}>收回</button>
                    </td>
                </tr>`;
        }).join('');
        return rows || '<tr><td colspan="6" class="meeting-empty">暂无白名单账号</td></tr>';
    }

    function render() {
        const mount = document.getElementById('meetingAdminMount');
        if (!mount) return;
        refs.mount = mount;
        mount.innerHTML = `
            <style>
                .meeting-admin-wrap{display:flex;flex-direction:column;gap:16px}.meeting-card{background:rgba(15,23,42,.55);border:1px solid rgba(148,163,184,.18);border-radius:16px;padding:16px}.meeting-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}.meeting-head-main{display:flex;flex-direction:column;gap:4px}.meeting-title{font-size:18px;font-weight:800;color:var(--text-primary)}.meeting-subtitle,.meeting-muted,.meeting-empty{color:var(--text-secondary);font-size:12px}.meeting-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.meeting-search{height:36px;border-radius:9px;border:1px solid rgba(148,163,184,.22);background:rgba(15,23,42,.72);color:var(--text-primary);padding:0 10px;min-width:220px}.meeting-small-btn{border:0;border-radius:10px;padding:8px 12px;background:rgba(59,130,246,.85);color:white;font-weight:700;cursor:pointer;font-size:12px}.meeting-small-btn.danger{background:rgba(239,68,68,.82)}.meeting-small-btn:disabled{opacity:.55;cursor:not-allowed}.meeting-table{width:100%;border-collapse:collapse}.meeting-table th,.meeting-table td{padding:11px 10px;border-bottom:1px solid rgba(148,163,184,.12);text-align:left;vertical-align:top}.meeting-table label{color:var(--text-primary);font-size:13px;white-space:nowrap}.meeting-badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;margin-right:6px;font-size:12px;font-weight:700}.meeting-badge.owned{background:rgba(14,165,233,.18);color:#bae6fd}.meeting-badge.all{background:rgba(168,85,247,.18);color:#e9d5ff}
            </style>
            <div class="meeting-admin-wrap">
                <section class="meeting-card">
                    <div class="meeting-head">
                        <div class="meeting-head-main">
                            <div class="meeting-title">会议发布权限管理</div>
                            <div class="meeting-subtitle">这里只授权账号是否可以在用户端发布会议，会议发布入口在用户端会议页面。</div>
                        </div>
                        <div class="meeting-toolbar">
                            <input class="meeting-search" data-meeting-search="1" value="${escapeHtml(state.candidateSearch)}" placeholder="搜索账号或昵称">
                            <button type="button" class="meeting-small-btn" data-meeting-refresh="1">${state.loading ? '加载中...' : '刷新'}</button>
                        </div>
                    </div>
                    <div data-scroll-hint="right" style="overflow-x:auto"><table class="meeting-table"><thead><tr><th>账号</th><th>归属</th><th>当前权限</th><th>授权伞下</th><th>授权全体</th><th>操作</th></tr></thead><tbody>${state.loading ? '<tr><td colspan="6" class="meeting-empty">加载中...</td></tr>' : renderPermissionRows()}</tbody></table></div>
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
            if (refresh) { loadAll(); return; }
            const save = event.target.closest('[data-meeting-save]');
            if (save) {
                const row = save.closest('[data-meeting-user]');
                const username = save.getAttribute('data-meeting-save');
                const owned = row && row.querySelector('[data-meeting-perm="owned"]') ? row.querySelector('[data-meeting-perm="owned"]').checked : false;
                const all = row && row.querySelector('[data-meeting-perm="all"]') ? row.querySelector('[data-meeting-perm="all"]').checked : false;
                savePermission(username, owned, all);
                return;
            }
            const revoke = event.target.closest('[data-meeting-revoke]');
            if (revoke) revokePermission(revoke.getAttribute('data-meeting-revoke'));
        });
    }

    function init() {
        bind();
        render();
        loadAll();
    }

    window.AKMeetingAdminPanel = { init: init, reload: loadAll };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
