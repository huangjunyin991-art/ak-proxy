(function(global) {
    'use strict';

    const groupTitleModule = {
        ctx: null,

        init(ctx) {
            this.ctx = ctx || null;
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        getElements() {
            return this.ctx && this.ctx.elements ? this.ctx.elements : {};
        },

        openPage() {
            const state = this.getState();
            if (!state) return;
            const detail = state.groupSettingsData;
            const conversationId = Number(state.groupSettingsConversationId || 0);
            if (!conversationId || !detail || !detail.can_manage) return;
            state.groupTitleEditConversationId = conversationId;
            state.groupTitleEditValue = String(detail.conversation_title || '').trim();
            state.groupTitleEditOriginal = state.groupTitleEditValue;
            state.groupTitleEditSaving = false;
            state.groupTitleEditError = '';
            state.view = 'group_title_edit';
            if (typeof this.ctx.render === 'function') this.ctx.render();
            this.focusInput();
        },

        closePage(options) {
            const state = this.getState();
            if (!state || state.groupTitleEditSaving) return;
            const silent = !!(options && options.silent);
            state.groupTitleEditConversationId = 0;
            state.groupTitleEditValue = '';
            state.groupTitleEditOriginal = '';
            state.groupTitleEditError = '';
            if (state.view === 'group_title_edit') state.view = state.groupSettingsOpen ? 'group_info' : (state.activeConversationId ? 'chat' : 'sessions');
            if (!silent && typeof this.ctx.render === 'function') this.ctx.render();
        },

        setValue(value) {
            const state = this.getState();
            if (!state) return;
            state.groupTitleEditValue = String(value || '');
            if (state.groupTitleEditError) state.groupTitleEditError = '';
            this.renderPage();
        },

        renderPage() {
            const state = this.getState();
            const elements = this.getElements();
            const bodyEl = elements.groupTitleEditBodyEl;
            const inputEl = elements.groupTitleEditInputEl;
            const submitBtnEl = elements.groupTitleEditSubmitBtnEl;
            if (!state || !bodyEl || !inputEl || !submitBtnEl) return;
            inputEl.value = String(state.groupTitleEditValue || '');
            inputEl.disabled = state.view !== 'group_title_edit' || !!state.groupTitleEditSaving;
            if (state.view !== 'group_title_edit') {
                bodyEl.innerHTML = '';
                submitBtnEl.disabled = true;
                submitBtnEl.textContent = '保存';
                return;
            }
            const escapeHtml = this.ctx && typeof this.ctx.escapeHtml === 'function' ? this.ctx.escapeHtml : function(text) { return String(text || ''); };
            const value = String(state.groupTitleEditValue || '').trim();
            const original = String(state.groupTitleEditOriginal || '').trim();
            bodyEl.innerHTML = (state.groupTitleEditError ? '<div class="ak-im-group-title-error">' + escapeHtml(state.groupTitleEditError) + '</div>' : '') +
                '<div class="ak-im-group-title-panel"><div class="ak-im-group-title-label">当前群名</div><div class="ak-im-group-title-current">' + escapeHtml(original || '未设置') + '</div><div class="ak-im-group-title-help">只有群主和群管理员可以修改群名。</div></div>';
            submitBtnEl.disabled = !!state.groupTitleEditSaving || !value || value === original;
            submitBtnEl.textContent = state.groupTitleEditSaving ? '保存中...' : '保存';
        },

        submitPage() {
            const state = this.getState();
            if (!state || state.groupTitleEditSaving) return Promise.resolve(null);
            const conversationId = Number(state.groupTitleEditConversationId || state.groupSettingsConversationId || 0);
            const title = String(state.groupTitleEditValue || '').trim();
            if (!conversationId) return Promise.resolve(null);
            if (!title) {
                state.groupTitleEditError = '请输入群名';
                this.renderPage();
                this.focusInput();
                return Promise.resolve(null);
            }
            if (!this.ctx || typeof this.ctx.request !== 'function') return Promise.resolve(null);
            const self = this;
            state.groupTitleEditSaving = true;
            state.groupTitleEditError = '';
            this.renderPage();
            return this.ctx.request(this.ctx.httpRoot + '/sessions/group/title', {
                method: 'POST',
                body: JSON.stringify({ conversation_id: conversationId, title: title })
            }).then(function(data) {
                state.groupTitleEditSaving = false;
                state.groupTitleEditOriginal = title;
                if (state.groupSettingsData) state.groupSettingsData.conversation_title = title;
                const tasks = [];
                if (typeof self.ctx.loadSessions === 'function') tasks.push(self.ctx.loadSessions());
                if (typeof self.ctx.loadMessages === 'function' && Number(state.activeConversationId || 0) === conversationId) tasks.push(self.ctx.loadMessages(conversationId));
                if (typeof self.ctx.loadGroupSettings === 'function') tasks.push(self.ctx.loadGroupSettings(conversationId));
                return Promise.all(tasks).then(function() {
                    state.groupTitleEditConversationId = 0;
                    state.groupTitleEditValue = '';
                    state.groupTitleEditOriginal = '';
                    state.groupTitleEditError = '';
                    state.view = 'group_info';
                    if (typeof self.ctx.render === 'function') self.ctx.render();
                    return data;
                });
            }).catch(function(error) {
                state.groupTitleEditSaving = false;
                state.groupTitleEditError = error && error.message ? error.message : '修改群名失败';
                self.renderPage();
                return null;
            });
        },

        focusInput() {
            const state = this.getState();
            const elements = this.getElements();
            const inputEl = elements.groupTitleEditInputEl;
            if (!inputEl) return;
            setTimeout(function() {
                if (!state || state.view !== 'group_title_edit' || inputEl.disabled) return;
                try {
                    inputEl.focus();
                    if (typeof inputEl.setSelectionRange === 'function') {
                        const value = String(inputEl.value || '');
                        inputEl.setSelectionRange(value.length, value.length);
                    }
                } catch (e) {}
            }, 0);
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.groupTitle = groupTitleModule;
})(window);
