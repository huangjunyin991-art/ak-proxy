(function(global) {
    'use strict';

    // 会议（腾讯会议链接广播）前端模块
    // 独立职责：拉取/渲染会议列表、发布会议（解析预览 + 手动编辑降级）、wemeet:// 直接入会、复制密码、已读
    // 模块失败/缺失时，im_client 会显示降级文案；其他 IM 功能不受影响

    const meetingManageModule = {
        ctx: null,

        init(ctx) {
            this.ctx = ctx || null;
            this.initState();
            this.bindPanelActions();
        },

        initState() {
            const state = this.getState();
            if (!state) return;
            if (!Array.isArray(state.meetingsItems)) state.meetingsItems = [];
            if (typeof state.meetingsLoaded !== 'boolean') state.meetingsLoaded = false;
            if (typeof state.meetingsLoading !== 'boolean') state.meetingsLoading = false;
            if (typeof state.meetingsError !== 'string') state.meetingsError = '';
            if (typeof state.meetingsCanPublish !== 'boolean') state.meetingsCanPublish = false;
            if (typeof state.meetingsPublishOpen !== 'boolean') state.meetingsPublishOpen = false;
            if (typeof state.meetingsPublishSubmitting !== 'boolean') state.meetingsPublishSubmitting = false;
            if (typeof state.meetingsPublishError !== 'string') state.meetingsPublishError = '';
            if (!state.meetingsPublishForm) state.meetingsPublishForm = this.blankPublishForm();
            if (typeof state.meetingsPasswordPromptOpen !== 'boolean') state.meetingsPasswordPromptOpen = false;
            if (typeof state.meetingsPasswordPromptValue !== 'string') state.meetingsPasswordPromptValue = '';
            if (typeof state.meetingsPasswordPromptError !== 'string') state.meetingsPasswordPromptError = '';
            if (typeof state.meetingsPasswordSubmitting !== 'boolean') state.meetingsPasswordSubmitting = false;
        },

        blankPublishForm() {
            return {
                url: '',
                short_id: '',
                meeting_code: '',
                subject: '',
                begin_time: '',
                end_time: '',
                creator_nickname: '',
                mtoken: '',
                group_key: '',
                parsed: false,
                parsing: false,
                parse_error: ''
            };
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        getHttpRoot() {
            return this.ctx && this.ctx.httpRoot ? this.ctx.httpRoot : '/im/api';
        },

        getPanelRoot() {
            const root = this.ctx && this.ctx.getRoot ? this.ctx.getRoot() : null;
            if (!root) return null;
            return root.querySelector('[data-im-home-panel="meetings"]');
        },

        request(path, options) {
            const http = this.getHttpRoot();
            const url = http + path;
            const opts = Object.assign({ credentials: 'include' }, options || {});
            if (opts.body && typeof opts.body !== 'string') {
                opts.body = JSON.stringify(opts.body);
                opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
            }
            return fetch(url, opts).then(function(resp) {
                return resp.json().then(function(data) {
                    if (!resp.ok || (data && data.error)) {
                        const msg = (data && data.message) ? data.message : ('HTTP ' + resp.status);
                        const err = new Error(msg);
                        err.response = data || null;
                        if (data && data.need_password) err.need_password = true;
                        throw err;
                    }
                    return data;
                });
            });
        },

        triggerRender() {
            if (this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
            this.renderMeetings();
        },

        // ============================ 数据加载 ============================

        loadMeetings() {
            const state = this.getState();
            if (!state) return Promise.resolve(null);
            if (state.meetingsLoading) return Promise.resolve(null);
            state.meetingsLoading = true;
            state.meetingsError = '';
            const self = this;
            return this.request('/meetings?limit=50', { method: 'GET' }).then(function(data) {
                state.meetingsItems = Array.isArray(data.items) ? data.items : [];
                state.meetingsLoaded = true;
                state.meetingsLoading = false;
                state.meetingsCanPublish = !!data.can_publish;
                if (state.homeTab === 'meetings' && typeof self.markTabSeen === 'function' && self.getTabUnreadCount() > 0) {
                    return self.markTabSeen().then(function() {
                        self.triggerRender();
                        return data;
                    });
                }
                self.triggerRender();
                return data;
            }).catch(function(err) {
                state.meetingsLoading = false;
                state.meetingsError = err && err.message ? err.message : '加载会议列表失败';
                self.renderMeetings();
                return null;
            });
        },

        getUnreadCount() {
            const state = this.getState();
            if (!state || !Array.isArray(state.meetingsItems)) return 0;
            return state.meetingsItems.reduce(function(sum, item) {
                return sum + (item && item.is_read === false ? 1 : 0);
            }, 0);
        },

        isExpiredForTabUnread(meeting) {
            if (!meeting || !meeting.end_time) return false;
            const end = new Date(meeting.end_time).getTime();
            return !isNaN(end) && end > 0 && Date.now() > end;
        },

        getTabUnreadCount() {
            const state = this.getState();
            const self = this;
            if (!state || !Array.isArray(state.meetingsItems)) return 0;
            return state.meetingsItems.reduce(function(sum, item) {
                if (!item || item.is_read !== false || self.isExpiredForTabUnread(item)) return sum;
                return sum + 1;
            }, 0);
        },

        markTabSeen() {
            const state = this.getState();
            if (!state || !Array.isArray(state.meetingsItems) || this.getTabUnreadCount() <= 0) return Promise.resolve(null);
            return this.markAllRead();
        },

        markRead(meetingId) {
            const state = this.getState();
            if (!state || !meetingId) return Promise.resolve(null);
            const self = this;
            const target = state.meetingsItems.find(function(item) { return item && Number(item.id) === Number(meetingId); });
            if (target && target.is_read) return Promise.resolve(null);
            return this.request('/meetings/read', { method: 'POST', body: { meeting_id: Number(meetingId) } }).then(function() {
                if (target) target.is_read = true;
                self.triggerRender();
                return null;
            }).catch(function() { return null; });
        },

        markAllRead() {
            const state = this.getState();
            if (!state) return Promise.resolve(null);
            const self = this;
            return this.request('/meetings/read', { method: 'POST', body: { all: true } }).then(function() {
                state.meetingsItems.forEach(function(item) { if (item) item.is_read = true; });
                self.triggerRender();
                return null;
            }).catch(function() { return null; });
        },

        deleteMeeting(meetingId) {
            if (!meetingId) return Promise.resolve(null);
            if (!window.confirm('确定删除该会议？')) return Promise.resolve(null);
            const self = this;
            return this.request('/meetings/delete', { method: 'POST', body: { meeting_id: Number(meetingId) } }).then(function() {
                return self.loadMeetings();
            }).catch(function(err) {
                window.alert('删除失败：' + (err && err.message ? err.message : '未知错误'));
                return null;
            });
        },

        // ============================ 发布流程 ============================

        openPublish() {
            const state = this.getState();
            if (!state || !state.meetingsCanPublish) return;
            state.meetingsPublishOpen = true;
            state.meetingsPublishError = '';
            state.meetingsPublishForm = this.blankPublishForm();
            this.triggerRender();
        },

        closePublish() {
            const state = this.getState();
            if (!state) return;
            state.meetingsPublishOpen = false;
            state.meetingsPublishSubmitting = false;
            state.meetingsPublishError = '';
            state.meetingsPublishForm = this.blankPublishForm();
            state.meetingsPasswordPromptOpen = false;
            state.meetingsPasswordPromptValue = '';
            state.meetingsPasswordPromptError = '';
            state.meetingsPasswordSubmitting = false;
            this.triggerRender();
        },

        previewShareUrl(url) {
            const state = this.getState();
            if (!state) return Promise.resolve(null);
            const form = state.meetingsPublishForm;
            form.url = String(url || '').trim();
            form.parsing = true;
            form.parse_error = '';
            const self = this;
            this.renderMeetings();
            return this.request('/meetings/preview', { method: 'POST', body: { url: form.url } }).then(function(data) {
                form.parsing = false;
                if (data && data.parsed && data.info) {
                    const info = data.info;
                    form.parsed = true;
                    form.short_id = info.short_id || '';
                    form.meeting_code = info.meeting_code || '';
                    form.subject = info.subject || '';
                    form.begin_time = info.begin_time || '';
                    form.end_time = info.end_time || '';
                    form.creator_nickname = info.creator_nickname || '';
                    form.mtoken = info.mtoken || '';
                    if (info.url) form.url = info.url;
                } else {
                    form.parsed = false;
                    form.parse_error = (data && data.error) ? String(data.error) : '解析失败，请手动填写会议信息';
                    if (data && data.short_id && !form.short_id) form.short_id = data.short_id;
                    if (data && data.url) form.url = data.url;
                }
                self.renderMeetings();
                return null;
            }).catch(function(err) {
                form.parsing = false;
                form.parsed = false;
                form.parse_error = err && err.message ? err.message : '解析失败';
                self.renderMeetings();
                return null;
            });
        },

        submitPublish() {
            const state = this.getState();
            if (!state) return Promise.resolve(null);
            const form = state.meetingsPublishForm;
            if (!form.url) { state.meetingsPublishError = '请粘贴会议链接'; this.renderMeetings(); return Promise.resolve(null); }
            if (!form.subject) { state.meetingsPublishError = '请填写会议主题'; this.renderMeetings(); return Promise.resolve(null); }
            if (!form.meeting_code) { state.meetingsPublishError = '请填写会议号'; this.renderMeetings(); return Promise.resolve(null); }
            return this.doSubmitPublish('');
        },

        submitWithPassword() {
            const state = this.getState();
            if (!state) return Promise.resolve(null);
            const pwd = String(state.meetingsPasswordPromptValue || '').trim();
            if (!pwd) { state.meetingsPasswordPromptError = '请输入入会密码'; this.renderMeetings(); return Promise.resolve(null); }
            state.meetingsPasswordPromptError = '';
            return this.doSubmitPublish(pwd);
        },

        closePasswordPrompt() {
            const state = this.getState();
            if (!state) return;
            state.meetingsPasswordPromptOpen = false;
            state.meetingsPasswordPromptValue = '';
            state.meetingsPasswordPromptError = '';
            state.meetingsPasswordSubmitting = false;
            this.renderMeetings();
        },

        doSubmitPublish(meetingPassword) {
            const state = this.getState();
            if (!state) return Promise.resolve(null);
            const form = state.meetingsPublishForm;
            const withPwd = !!meetingPassword;
            if (withPwd) {
                state.meetingsPasswordSubmitting = true;
            } else {
                state.meetingsPublishSubmitting = true;
                state.meetingsPublishError = '';
            }
            this.renderMeetings();
            const self = this;
            // has_password / mtoken / short_id 完全由后端解析决定，前端不再传
            return this.request('/meetings', { method: 'POST', body: {
                url: form.url,
                meeting_code: form.meeting_code,
                subject: form.subject,
                begin_time: form.begin_time,
                end_time: form.end_time,
                creator_nickname: form.creator_nickname,
                meeting_password: meetingPassword || '',
                group_key: form.group_key || ''
            }}).then(function() {
                state.meetingsPublishSubmitting = false;
                state.meetingsPasswordSubmitting = false;
                state.meetingsPasswordPromptOpen = false;
                state.meetingsPasswordPromptValue = '';
                state.meetingsPasswordPromptError = '';
                self.closePublish();
                return self.loadMeetings();
            }).catch(function(err) {
                state.meetingsPublishSubmitting = false;
                state.meetingsPasswordSubmitting = false;
                if (err && err.need_password) {
                    state.meetingsPasswordPromptOpen = true;
                    state.meetingsPasswordPromptError = '';
                    state.meetingsPasswordPromptValue = '';
                } else if (state.meetingsPasswordPromptOpen) {
                    state.meetingsPasswordPromptError = err && err.message ? err.message : '发布失败';
                } else {
                    state.meetingsPublishError = err && err.message ? err.message : '发布失败';
                }
                self.renderMeetings();
                return null;
            });
        },

        // ============================ wemeet:// / 复制 ============================

        buildJoinUrl(meeting) {
            if (!meeting || !meeting.meeting_code) return '';
            const params = ['meeting_code=' + encodeURIComponent(meeting.meeting_code)];
            if (meeting.mtoken) params.push('token=' + encodeURIComponent(meeting.mtoken));
            if (meeting.has_password && meeting.meeting_password) {
                params.push('meeting_password=' + encodeURIComponent(meeting.meeting_password));
            }
            return 'wemeet://page/inmeeting?' + params.join('&');
        },

        joinMeeting(meetingId) {
            const state = this.getState();
            if (!state) return;
            const meeting = state.meetingsItems.find(function(m) { return m && Number(m.id) === Number(meetingId); });
            if (!meeting) return;
            const url = this.buildJoinUrl(meeting);
            if (!url) {
                window.alert('会议号缺失，无法唤起腾讯会议');
                return;
            }
            // 兜底：有入会密码时先复制到剪贴板；wemeet:// URL scheme 若未生效，用户到会议 APP 内一键粘贴即可
            if (meeting.has_password && meeting.meeting_password) {
                this.copyToClipboard(meeting.meeting_password);
            }
            this.markRead(meetingId);
            try {
                window.location.href = url;
            } catch (e) {}
        },

        copyToClipboard(text) {
            const payload = String(text || '');
            if (!payload) return;
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(payload).then(function() {
                        // 轻量提示
                    }, function() {});
                    return;
                }
            } catch (e) {}
            const textarea = document.createElement('textarea');
            textarea.value = payload;
            textarea.style.position = 'fixed';
            textarea.style.top = '-1000px';
            document.body.appendChild(textarea);
            textarea.select();
            try { document.execCommand('copy'); } catch (e) {}
            document.body.removeChild(textarea);
        },

        // ============================ WebSocket 事件 ============================

        handleSocketPayload(data) {
            if (!data || typeof data !== 'object') return false;
            if (data.type === 'im.meeting.created' || data.type === 'im.meeting.deleted') {
                // 无论创建还是删除，最稳的做法是重新拉取列表（发布频率低，成本可忽略）
                this.loadMeetings();
                return true;
            }
            return false;
        },

        // ============================ 渲染 ============================

        escapeHtml(raw) {
            return String(raw == null ? '' : raw).replace(/[&<>"']/g, function(ch) {
                return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
            });
        },

        formatTimeRange(beginISO, endISO) {
            if (!beginISO) return '';
            const begin = new Date(beginISO);
            if (isNaN(begin.getTime())) return '';
            const fmt = function(d) {
                const pad = function(n) { return n < 10 ? ('0' + n) : String(n); };
                return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
            };
            let text = fmt(begin);
            if (endISO) {
                const end = new Date(endISO);
                if (!isNaN(end.getTime())) {
                    const sameDay = begin.getFullYear() === end.getFullYear() && begin.getMonth() === end.getMonth() && begin.getDate() === end.getDate();
                    if (sameDay) {
                        const pad = function(n) { return n < 10 ? ('0' + n) : String(n); };
                        text += ' ~ ' + pad(end.getHours()) + ':' + pad(end.getMinutes());
                    } else {
                        text += ' ~ ' + fmt(end);
                    }
                }
            }
            return text;
        },

        computeMeetingStateLabel(meeting) {
            if (!meeting) return { label: '', color: '' };
            const now = Date.now();
            const begin = meeting.begin_time ? new Date(meeting.begin_time).getTime() : 0;
            const end = meeting.end_time ? new Date(meeting.end_time).getTime() : 0;
            if (end && now > end) return { label: '已结束', color: '#9ca3af' };
            if (begin && now >= begin && (!end || now <= end)) return { label: '进行中', color: '#07c160' };
            if (begin && now < begin) return { label: '未开始', color: '#1e88e5' };
            return { label: '', color: '' };
        },

        renderMeetingCard(meeting) {
            const self = this;
            const esc = function(v) { return self.escapeHtml(v); };
            const stateInfo = this.computeMeetingStateLabel(meeting);
            const timeText = this.formatTimeRange(meeting.begin_time, meeting.end_time);
            const joinUrl = this.buildJoinUrl(meeting);
            const passwordRow = meeting.has_password && meeting.meeting_password
                ? `<div class="ak-im-meeting-row ak-im-meeting-password">
                        <span>🔒 入会密码：<strong>${esc(meeting.meeting_password)}</strong></span>
                        <button type="button" class="ak-im-meeting-copy-btn" data-im-meeting-copy="${esc(meeting.meeting_password)}">复制密码</button>
                   </div>`
                : '';
            const unreadDot = meeting.is_read ? '' : '<span class="ak-im-meeting-unread-dot" aria-hidden="true"></span>';
            const stateBadge = stateInfo.label
                ? `<span class="ak-im-meeting-state" style="color:${stateInfo.color};border-color:${stateInfo.color}">${esc(stateInfo.label)}</span>`
                : '';
            const senderLine = meeting.sender_display_name || meeting.sender_username
                ? `<div class="ak-im-meeting-row ak-im-meeting-sender">发布者：${esc(meeting.sender_display_name || meeting.sender_username)}</div>`
                : '';
            const creatorLine = meeting.creator_nickname && meeting.creator_nickname !== (meeting.sender_display_name || '')
                ? `<div class="ak-im-meeting-row">主持人：${esc(meeting.creator_nickname)}</div>`
                : '';
            return `
                <div class="ak-im-meeting-card" data-meeting-id="${esc(meeting.id)}">
                    <div class="ak-im-meeting-head">
                        <div class="ak-im-meeting-title">${unreadDot}<span>🎥 ${esc(meeting.subject || '会议')}</span></div>
                        ${stateBadge}
                    </div>
                    ${timeText ? `<div class="ak-im-meeting-row">🕒 ${esc(timeText)}</div>` : ''}
                    <div class="ak-im-meeting-row">📞 会议号：<strong>${esc(meeting.meeting_code)}</strong></div>
                    ${creatorLine}
                    ${senderLine}
                    ${passwordRow}
                    <div class="ak-im-meeting-actions">
                        <button type="button" class="ak-im-meeting-join-btn" data-im-meeting-join="${esc(meeting.id)}"${joinUrl ? '' : ' disabled'}>进入会议</button>
                        <button type="button" class="ak-im-meeting-link-btn" data-im-meeting-copy-link="${esc(meeting.url)}">复制链接</button>
                    </div>
                </div>`;
        },

        renderPublishForm() {
            const state = this.getState();
            if (!state || !state.meetingsPublishOpen) return '';
            const self = this;
            const esc = function(v) { return self.escapeHtml(v); };
            const form = state.meetingsPublishForm;
            const submitDisabled = state.meetingsPublishSubmitting ? ' disabled' : '';
            const parsingLabel = form.parsing ? ' · 正在解析...' : (form.parsed ? ' · 解析成功（可修改）' : (form.parse_error ? (' · ' + form.parse_error) : ''));
            const passwordPrompt = state.meetingsPasswordPromptOpen ? this.renderPasswordPrompt() : '';
            return `
                <div class="ak-im-meeting-publish-mask" data-im-meeting-close="1"></div>
                <div class="ak-im-meeting-publish-sheet">
                    <div class="ak-im-meeting-publish-header">
                        <span>发布会议</span>
                        <button type="button" class="ak-im-meeting-publish-close" data-im-meeting-close="1">×</button>
                    </div>
                    <div class="ak-im-meeting-publish-body">
                        <label class="ak-im-meeting-field">
                            <span>分享链接 <em class="ak-im-meeting-hint">${esc(parsingLabel)}</em></span>
                            <input type="url" data-im-meeting-field="url" value="${esc(form.url)}" placeholder="https://meeting.tencent.com/dm/xxxxxxx" autocomplete="off">
                        </label>
                        <label class="ak-im-meeting-field">
                            <span>会议主题</span>
                            <input type="text" data-im-meeting-field="subject" value="${esc(form.subject)}" placeholder="如：产品评审会">
                        </label>
                        <div class="ak-im-meeting-field-row">
                            <label class="ak-im-meeting-field">
                                <span>会议号</span>
                                <input type="text" data-im-meeting-field="meeting_code" value="${esc(form.meeting_code)}" placeholder="9 位数字">
                            </label>
                            <label class="ak-im-meeting-field">
                                <span>主持人（可选）</span>
                                <input type="text" data-im-meeting-field="creator_nickname" value="${esc(form.creator_nickname)}">
                            </label>
                        </div>
                        <div class="ak-im-meeting-field-row">
                            <label class="ak-im-meeting-field">
                                <span>开始时间（可选）</span>
                                <input type="datetime-local" data-im-meeting-field="begin_time_local" value="${esc(this.isoToLocalInput(form.begin_time))}">
                            </label>
                            <label class="ak-im-meeting-field">
                                <span>结束时间（可选）</span>
                                <input type="datetime-local" data-im-meeting-field="end_time_local" value="${esc(this.isoToLocalInput(form.end_time))}">
                            </label>
                        </div>
                        ${state.meetingsPublishError ? `<div class="ak-im-meeting-publish-error">${esc(state.meetingsPublishError)}</div>` : ''}
                    </div>
                    <div class="ak-im-meeting-publish-footer">
                        <button type="button" class="ak-im-meeting-publish-cancel" data-im-meeting-close="1">取消</button>
                        <button type="button" class="ak-im-meeting-publish-submit" data-im-meeting-submit="1"${submitDisabled}>${state.meetingsPublishSubmitting ? '发布中...' : '发布'}</button>
                    </div>
                </div>
                ${passwordPrompt}`;
        },

        renderPasswordPrompt() {
            const state = this.getState();
            if (!state) return '';
            const self = this;
            const esc = function(v) { return self.escapeHtml(v); };
            const value = state.meetingsPasswordPromptValue || '';
            const submitting = !!state.meetingsPasswordSubmitting;
            const submitLabel = submitting ? '提交中...' : '确认发布';
            const submitDisabled = submitting ? ' disabled' : '';
            const errBlock = state.meetingsPasswordPromptError
                ? `<div class="ak-im-meeting-password-error">${esc(state.meetingsPasswordPromptError)}</div>`
                : '';
            return `
                <div class="ak-im-meeting-password-mask" data-im-meeting-password-cancel="1"></div>
                <div class="ak-im-meeting-password-sheet">
                    <div class="ak-im-meeting-password-title">请输入入会密码</div>
                    <div class="ak-im-meeting-password-desc">该链接需要入会密码，将与会议一并保存；成员入会时会自动填入或粘贴。</div>
                    <div class="ak-im-meeting-password-body">
                        <input type="text" data-im-meeting-password-field="1" value="${esc(value)}" placeholder="输入入会密码" autocomplete="off">
                    </div>
                    ${errBlock}
                    <div class="ak-im-meeting-password-footer">
                        <button type="button" class="ak-im-meeting-password-cancel" data-im-meeting-password-cancel="1">取消</button>
                        <button type="button" class="ak-im-meeting-password-submit" data-im-meeting-password-submit="1"${submitDisabled}>${submitLabel}</button>
                    </div>
                </div>`;
        },

        isoToLocalInput(iso) {
            if (!iso) return '';
            const d = new Date(iso);
            if (isNaN(d.getTime())) return '';
            const pad = function(n) { return n < 10 ? ('0' + n) : String(n); };
            return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        },

        localInputToIso(localValue) {
            if (!localValue) return '';
            const d = new Date(localValue);
            if (isNaN(d.getTime())) return '';
            return d.toISOString();
        },

        renderMeetings() {
            const panelRoot = this.getPanelRoot();
            if (!panelRoot) return;
            const state = this.getState();
            if (!state) return;
            const items = Array.isArray(state.meetingsItems) ? state.meetingsItems : [];
            let listHtml = '';
            if (state.meetingsLoading && !state.meetingsLoaded) {
                listHtml = '<div class="ak-im-meeting-empty">加载中...</div>';
            } else if (state.meetingsError) {
                listHtml = `<div class="ak-im-meeting-empty ak-im-meeting-error">${this.escapeHtml(state.meetingsError)}</div>`;
            } else if (items.length === 0) {
                listHtml = '<div class="ak-im-meeting-empty">暂无会议。主群群主或管理员可发布腾讯会议链接，成员可一键入会。</div>';
            } else {
                listHtml = items.map(item => this.renderMeetingCard(item)).join('');
            }
            const publishOverlay = state.meetingsPublishOpen ? this.renderPublishForm() : '';
            panelRoot.innerHTML = `
                <div class="ak-im-meeting-list">${listHtml}</div>
                ${publishOverlay}`;
        },

        bindPanelActions() {
            const panelRoot = this.getPanelRoot();
            if (!panelRoot) return;
            const self = this;
            // 事件委托：面板根节点上绑定 click 和 input，所有按钮/表单字段通过 data-* 分发
            panelRoot.addEventListener('click', function(event) {
                const target = event.target.closest('[data-im-meeting-open-publish],[data-im-meeting-close],[data-im-meeting-submit],[data-im-meeting-join],[data-im-meeting-copy],[data-im-meeting-copy-link],[data-im-meeting-password-cancel],[data-im-meeting-password-submit]');
                if (!target) return;
                if (target.hasAttribute('data-im-meeting-open-publish')) {
                    self.openPublish();
                    return;
                }
                if (target.hasAttribute('data-im-meeting-close')) {
                    self.closePublish();
                    return;
                }
                if (target.hasAttribute('data-im-meeting-submit')) {
                    self.submitPublish();
                    return;
                }
                if (target.hasAttribute('data-im-meeting-password-cancel')) {
                    self.closePasswordPrompt();
                    return;
                }
                if (target.hasAttribute('data-im-meeting-password-submit')) {
                    self.submitWithPassword();
                    return;
                }
                if (target.hasAttribute('data-im-meeting-join')) {
                    self.joinMeeting(target.getAttribute('data-im-meeting-join'));
                    return;
                }
                if (target.hasAttribute('data-im-meeting-copy')) {
                    self.copyToClipboard(target.getAttribute('data-im-meeting-copy'));
                    return;
                }
                if (target.hasAttribute('data-im-meeting-copy-link')) {
                    self.copyToClipboard(target.getAttribute('data-im-meeting-copy-link'));
                    return;
                }
            });
            panelRoot.addEventListener('input', function(event) {
                // 二级密码卡片的密码输入框
                const pwdTarget = event.target.closest('[data-im-meeting-password-field]');
                if (pwdTarget) {
                    const s = self.getState();
                    if (s) {
                        s.meetingsPasswordPromptValue = pwdTarget.value;
                        s.meetingsPasswordPromptError = '';
                    }
                    return;
                }
                const target = event.target.closest('[data-im-meeting-field]');
                if (!target) return;
                const field = target.getAttribute('data-im-meeting-field');
                const state = self.getState();
                if (!state || !state.meetingsPublishForm) return;
                const form = state.meetingsPublishForm;
                if (field === 'begin_time_local') {
                    form.begin_time = self.localInputToIso(target.value);
                    return;
                }
                if (field === 'end_time_local') {
                    form.end_time = self.localInputToIso(target.value);
                    return;
                }
                if (field === 'url') {
                    form.url = target.value;
                    // 触发防抖解析
                    if (self._urlDebounce) clearTimeout(self._urlDebounce);
                    self._urlDebounce = setTimeout(function() {
                        const val = String(form.url || '').trim();
                        if (/^https?:\/\/meeting\.tencent\.com\/(?:dm|dw|p)\//i.test(val)) {
                            self.previewShareUrl(val);
                        }
                    }, 600);
                    return;
                }
                form[field] = target.value;
            });
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.meetingManage = meetingManageModule;
})(window);
