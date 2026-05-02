(function() {
    'use strict';

    if (window.AKMeetingAdminPanelLoaded) return;
    window.AKMeetingAdminPanelLoaded = true;

    const API_ROOT = (typeof API_BASE === 'string' && API_BASE) ? API_BASE : window.location.origin;
    const state = {
        candidates: [],
        permissions: [],
        candidateSearch: '',
        selectedUsername: '',
        loading: false,
        saving: false,
        previewing: false,
        publishing: false,
        publish: {
            sender_username: '',
            url: '',
            subject: '',
            meeting_code: '',
            begin_time: '',
            end_time: '',
            creator_nickname: '',
            meeting_password: ''
        }
    };
    const refs = {};

    function headers(extra) {
        const base = typeof getHeaders === 'function' ? getHeaders() : {};
        return Object.assign({}, base, extra || {});
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

    function selectedPermission() {
        const username = normalizeUsername(state.publish.sender_username || state.selectedUsername);
        return state.candidates.find(function(item) { return normalizeUsername(item.username) === username; })
            || state.permissions.find(function(item) { return normalizeUsername(item.username) === username; })
            || null;
    }

    function formatAccount(item) {
        if (!item) return '';
        const username = item.username || '';
        const nickname = item.nickname ? (' · ' + item.nickname) : '';
        const owner = item.added_by ? (' · ' + item.added_by) : '';
        return username + nickname + owner;
    }

    function loadAll() {
        state.loading = true;
        render();
        return Promise.all([
            request('/admin/api/meeting/candidates?limit=300&search=' + encodeURIComponent(state.candidateSearch || ''), { method: 'GET' }),
            request('/admin/api/meeting/permissions?limit=300&search=' + encodeURIComponent(state.candidateSearch || ''), { method: 'GET' })
        ]).then(function(results) {
            state.candidates = Array.isArray(results[0].rows) ? results[0].rows : [];
            state.permissions = Array.isArray(results[1].rows) ? results[1].rows : [];
            state.loading = false;
            render();
        }).catch(function(error) {
            state.loading = false;
            toast('会议模块加载失败：' + error.message, 'error');
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

    function previewMeeting() {
        const url = String(state.publish.url || '').trim();
        if (!url) {
            toast('请先填写会议链接', 'error');
            return;
        }
        state.previewing = true;
        render();
        request('/admin/api/meeting/preview', { method: 'POST', body: { url: url } }).then(function(data) {
            const item = data && data.data ? data.data : {};
            state.publish.url = item.url || state.publish.url;
            state.publish.subject = item.subject || state.publish.subject;
            state.publish.meeting_code = item.meeting_code || state.publish.meeting_code;
            state.publish.begin_time = item.begin_time || state.publish.begin_time;
            state.publish.end_time = item.end_time || state.publish.end_time;
            state.publish.creator_nickname = item.creator_nickname || state.publish.creator_nickname;
            state.previewing = false;
            toast('会议链接解析成功', 'success');
            render();
        }).catch(function(error) {
            state.previewing = false;
            toast('解析失败：' + error.message, 'error');
            render();
        });
    }

    function publishMeeting(scope) {
        const selected = selectedPermission();
        const sender = normalizeUsername(state.publish.sender_username || state.selectedUsername);
        if (!sender) {
            toast('请选择发布账号', 'error');
            return;
        }
        if (scope === 'owned' && !(selected && selected.can_publish_owned)) {
            toast('该账号没有发布给伞下玩家的权限', 'error');
            return;
        }
        if (scope === 'all' && !(selected && selected.can_publish_all)) {
            toast('该账号没有发布给全体玩家的权限', 'error');
            return;
        }
        if (!state.publish.url || !state.publish.subject || !state.publish.meeting_code) {
            toast('请填写会议链接、主题和会议号', 'error');
            return;
        }
        state.publishing = true;
        render();
        request('/admin/api/meeting/publish', {
            method: 'POST',
            body: Object.assign({}, state.publish, {
                sender_username: sender,
                audience_scope: scope
            })
        }).then(function() {
            state.publishing = false;
            toast(scope === 'all' ? '已发布给全体玩家' : '已发布给伞下玩家', 'success');
            render();
        }).catch(function(error) {
            state.publishing = false;
            toast('发布失败：' + error.message, 'error');
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
                    <td>${escapeHtml(item.added_by || '-')}</td>
                    <td><label><input type="checkbox" data-meeting-perm="owned" ${owned ? 'checked' : ''}> 伞下</label></td>
                    <td><label><input type="checkbox" data-meeting-perm="all" ${all ? 'checked' : ''}> 全体</label></td>
                    <td>
                        <button type="button" class="meeting-small-btn" data-meeting-save="${escapeHtml(username)}">保存</button>
                        <button type="button" class="meeting-small-btn danger" data-meeting-revoke="${escapeHtml(username)}">收回</button>
                    </td>
                </tr>`;
        }).join('');
        return rows || '<tr><td colspan="5" class="meeting-empty">暂无白名单账号</td></tr>';
    }

    function renderPublisherOptions() {
        return state.candidates.filter(function(item) {
            return item && (item.can_publish_owned || item.can_publish_all);
        }).map(function(item) {
            const username = normalizeUsername(item.username);
            return `<option value="${escapeHtml(username)}">${escapeHtml(formatAccount(item))}</option>`;
        }).join('');
    }

    function renderPublishButtons() {
        const selected = selectedPermission();
        const disabled = state.publishing ? ' disabled' : '';
        const buttons = [];
        if (selected && selected.can_publish_owned) {
            buttons.push(`<button type="button" class="meeting-primary" data-meeting-publish="owned"${disabled}>${state.publishing ? '发布中...' : '发布给伞下玩家'}</button>`);
        }
        if (selected && selected.can_publish_all) {
            buttons.push(`<button type="button" class="meeting-primary all" data-meeting-publish="all"${disabled}>${state.publishing ? '发布中...' : '发布给全体玩家'}</button>`);
        }
        return buttons.length ? buttons.join('') : '<div class="meeting-empty">选择已授权账号后显示发布按钮</div>';
    }

    function render() {
        const mount = document.getElementById('meetingAdminMount');
        if (!mount) return;
        refs.mount = mount;
        mount.innerHTML = `
            <style>
                .meeting-admin-wrap{display:flex;flex-direction:column;gap:16px}.meeting-card{background:rgba(15,23,42,.55);border:1px solid rgba(148,163,184,.18);border-radius:16px;padding:16px}.meeting-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.meeting-field{display:flex;flex-direction:column;gap:6px;color:var(--text-secondary);font-size:13px}.meeting-field input,.meeting-field select{height:38px;border-radius:10px;border:1px solid rgba(148,163,184,.22);background:rgba(15,23,42,.72);color:var(--text-primary);padding:0 10px}.meeting-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.meeting-primary,.meeting-small-btn{border:0;border-radius:10px;padding:9px 14px;background:linear-gradient(135deg,#00d4ff,#1677ff);color:white;font-weight:700;cursor:pointer}.meeting-primary.all{background:linear-gradient(135deg,#a855f7,#ec4899)}.meeting-small-btn{padding:6px 10px;background:rgba(59,130,246,.85);font-size:12px}.meeting-small-btn.danger{background:rgba(239,68,68,.82)}.meeting-table{width:100%;border-collapse:collapse}.meeting-table th,.meeting-table td{padding:10px;border-bottom:1px solid rgba(148,163,184,.12);text-align:left}.meeting-muted,.meeting-empty{color:var(--text-secondary);font-size:12px}.meeting-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.meeting-search{height:34px;border-radius:9px;border:1px solid rgba(148,163,184,.22);background:rgba(15,23,42,.72);color:var(--text-primary);padding:0 10px}
            </style>
            <div class="meeting-admin-wrap">
                <section class="meeting-card">
                    <div class="meeting-head"><h3>发布会议</h3><button type="button" class="meeting-small-btn" data-meeting-refresh="1">刷新权限</button></div>
                    <div class="meeting-grid">
                        <label class="meeting-field"><span>发布账号</span><select data-meeting-publish-field="sender_username"><option value="">请选择已授权账号</option>${renderPublisherOptions()}</select></label>
                        <label class="meeting-field"><span>会议链接</span><input data-meeting-publish-field="url" value="${escapeHtml(state.publish.url)}" placeholder="https://meeting.tencent.com/dm/xxxx"></label>
                        <label class="meeting-field"><span>会议主题</span><input data-meeting-publish-field="subject" value="${escapeHtml(state.publish.subject)}"></label>
                        <label class="meeting-field"><span>会议号</span><input data-meeting-publish-field="meeting_code" value="${escapeHtml(state.publish.meeting_code)}"></label>
                        <label class="meeting-field"><span>开始时间</span><input data-meeting-publish-field="begin_time" value="${escapeHtml(state.publish.begin_time)}"></label>
                        <label class="meeting-field"><span>结束时间</span><input data-meeting-publish-field="end_time" value="${escapeHtml(state.publish.end_time)}"></label>
                        <label class="meeting-field"><span>主持人</span><input data-meeting-publish-field="creator_nickname" value="${escapeHtml(state.publish.creator_nickname)}"></label>
                        <label class="meeting-field"><span>入会密码</span><input data-meeting-publish-field="meeting_password" value="${escapeHtml(state.publish.meeting_password)}"></label>
                    </div>
                    <div class="meeting-actions"><button type="button" class="meeting-small-btn" data-meeting-preview="1">${state.previewing ? '解析中...' : '解析链接'}</button>${renderPublishButtons()}</div>
                </section>
                <section class="meeting-card">
                    <div class="meeting-head"><h3>发布权限管理</h3><input class="meeting-search" data-meeting-search="1" value="${escapeHtml(state.candidateSearch)}" placeholder="搜索账号或昵称"></div>
                    <div data-scroll-hint="right" style="overflow-x:auto"><table class="meeting-table"><thead><tr><th>账号</th><th>归属</th><th>发布给伞下</th><th>发布给全体</th><th>操作</th></tr></thead><tbody>${state.loading ? '<tr><td colspan="5" class="meeting-empty">加载中...</td></tr>' : renderPermissionRows()}</tbody></table></div>
                </section>
            </div>`;
        const select = mount.querySelector('[data-meeting-publish-field="sender_username"]');
        if (select) select.value = state.publish.sender_username || '';
    }

    function bind() {
        const mount = document.getElementById('meetingAdminMount');
        if (!mount || mount.__meetingAdminBound) return;
        mount.__meetingAdminBound = true;
        mount.addEventListener('input', function(event) {
            const field = event.target.closest('[data-meeting-publish-field]');
            if (field) {
                const key = field.getAttribute('data-meeting-publish-field');
                state.publish[key] = field.value;
                if (key === 'sender_username') {
                    state.selectedUsername = field.value;
                    render();
                }
                return;
            }
            const search = event.target.closest('[data-meeting-search]');
            if (search) {
                state.candidateSearch = search.value;
                clearTimeout(bind.searchTimer);
                bind.searchTimer = setTimeout(loadAll, 350);
            }
        });
        mount.addEventListener('change', function(event) {
            const field = event.target.closest('[data-meeting-publish-field]');
            if (!field) return;
            const key = field.getAttribute('data-meeting-publish-field');
            state.publish[key] = field.value;
            if (key === 'sender_username') state.selectedUsername = field.value;
            render();
        });
        mount.addEventListener('click', function(event) {
            const refresh = event.target.closest('[data-meeting-refresh]');
            if (refresh) { loadAll(); return; }
            const preview = event.target.closest('[data-meeting-preview]');
            if (preview) { previewMeeting(); return; }
            const publish = event.target.closest('[data-meeting-publish]');
            if (publish) { publishMeeting(publish.getAttribute('data-meeting-publish')); return; }
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
