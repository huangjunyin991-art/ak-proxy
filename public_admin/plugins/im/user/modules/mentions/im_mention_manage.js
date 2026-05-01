(function(global) {
    'use strict';

    const ALL_LABEL = '全体成员';

    const mentionManageModule = {
        ctx: null,
        memberCache: {},

        init(ctx) {
            this.ctx = ctx || null;
            this.ensureState();
            this.bindInputEvents();
            this.renderPanel();
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        getElements() {
            return this.ctx && this.ctx.elements ? this.ctx.elements : {};
        },

        ensureState() {
            const state = this.getState();
            if (!state) return null;
            if (!state.mentionManage || typeof state.mentionManage !== 'object') {
                state.mentionManage = {
                    open: false,
                    conversationId: 0,
                    keyword: '',
                    triggerIndex: -1,
                    selectedUsernames: [],
                    selectedLabels: {},
                    mentionAll: false,
                    loading: false,
                    error: '',
                    members: []
                };
            }
            return state.mentionManage;
        },

        getActiveSession() {
            return this.ctx && typeof this.ctx.getActiveSession === 'function' ? this.ctx.getActiveSession() : null;
        },

        isGroupSession() {
            const activeSession = this.getActiveSession();
            if (this.ctx && typeof this.ctx.isGroupSession === 'function') return this.ctx.isGroupSession(activeSession);
            return String(activeSession && activeSession.conversation_type || '').toLowerCase() === 'group';
        },

        getConversationId() {
            const state = this.getState();
            return Number(state && state.activeConversationId || 0);
        },

        canMentionAll() {
            const activeSession = this.getActiveSession();
            const role = String(activeSession && activeSession.my_role || '').trim().toLowerCase();
            return this.isGroupSession() && (role === 'owner' || role === 'admin');
        },

        escapeHtml(value) {
            if (this.ctx && typeof this.ctx.escapeHtml === 'function') return this.ctx.escapeHtml(value);
            return String(value == null ? '' : value).replace(/[&<>'"]/g, function(ch) {
                return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[ch] || ch;
            });
        },

        getAvatarUrl(value) {
            return this.ctx && typeof this.ctx.getAvatarUrl === 'function' ? this.ctx.getAvatarUrl(value) : String(value || '');
        },

        getDisplayName(member) {
            return String(member && (member.display_name || member.username) || '').trim();
        },

        bindInputEvents() {
            const inputEl = this.getElements().inputEl;
            if (!inputEl || inputEl.__akMentionBound) return;
            inputEl.__akMentionBound = true;
            inputEl.addEventListener('click', this.handleComposerCaretChange.bind(this));
            inputEl.addEventListener('keyup', this.handleComposerCaretChange.bind(this));
            inputEl.addEventListener('keydown', this.handleComposerKeydown.bind(this));
        },

        handleComposerInput() {
            this.updateTriggerFromInput();
        },

        handleComposerCaretChange() {
            this.updateTriggerFromInput();
        },

        handleComposerKeydown(event) {
            const mentionState = this.ensureState();
            if (!mentionState || !mentionState.open) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                this.closePanel();
            }
        },

        updateTriggerFromInput() {
            const state = this.getState();
            const mentionState = this.ensureState();
            const inputEl = this.getElements().inputEl;
            if (!state || !mentionState || !inputEl || !this.isGroupSession()) {
                this.closePanel();
                return;
            }
            const conversationId = this.getConversationId();
            const value = String(inputEl.value || '');
            const caret = typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : value.length;
            const beforeCaret = value.slice(0, caret);
            const triggerIndex = beforeCaret.lastIndexOf('@');
            if (triggerIndex < 0) {
                this.closePanel();
                return;
            }
            const keyword = beforeCaret.slice(triggerIndex + 1);
            if (/\s/.test(keyword)) {
                this.closePanel();
                return;
            }
            mentionState.open = true;
            mentionState.conversationId = conversationId;
            mentionState.keyword = keyword.toLowerCase();
            mentionState.triggerIndex = triggerIndex;
            this.ensureMembersLoaded(conversationId);
            this.renderPanel();
        },

        ensureMembersLoaded(conversationId) {
            const mentionState = this.ensureState();
            const targetConversationId = Number(conversationId || 0);
            if (!mentionState || !targetConversationId) return;
            if (this.memberCache[targetConversationId]) {
                mentionState.members = this.memberCache[targetConversationId];
                this.renderPanel();
                return;
            }
            if (mentionState.loading || !this.ctx || typeof this.ctx.request !== 'function' || !this.ctx.httpRoot) return;
            mentionState.loading = true;
            mentionState.error = '';
            this.renderPanel();
            this.ctx.request(this.ctx.httpRoot + '/sessions/members?conversation_id=' + encodeURIComponent(targetConversationId)).then(function(data) {
                const item = data && data.item ? data.item : null;
                const members = Array.isArray(item && item.members) ? item.members : [];
                this.memberCache[targetConversationId] = members;
                if (mentionState.conversationId === targetConversationId) {
                    mentionState.members = members;
                    mentionState.loading = false;
                    mentionState.error = '';
                    this.renderPanel();
                }
            }.bind(this)).catch(function(error) {
                if (mentionState.conversationId !== targetConversationId) return;
                mentionState.loading = false;
                mentionState.error = error && error.message ? error.message : '成员加载失败';
                this.renderPanel();
            }.bind(this));
        },

        getFilteredMembers() {
            const state = this.getState();
            const mentionState = this.ensureState();
            if (!state || !mentionState) return [];
            const currentUsername = String(state.username || '').trim().toLowerCase();
            const keyword = String(mentionState.keyword || '').trim().toLowerCase();
            const members = Array.isArray(mentionState.members) ? mentionState.members : [];
            return members.filter(function(member) {
                const username = String(member && member.username || '').trim().toLowerCase();
                if (!username || username === currentUsername) return false;
                const displayName = String(member && member.display_name || '').trim().toLowerCase();
                const honorName = String(member && member.honor_name || '').trim().toLowerCase();
                const text = username + '\n' + displayName + '\n' + honorName;
                return !keyword || text.indexOf(keyword) >= 0;
            }).slice(0, 8);
        },

        buildPanelMarkup() {
            const mentionState = this.ensureState();
            if (!mentionState || !mentionState.open) return '';
            if (mentionState.loading && !mentionState.members.length) {
                return '<div class="ak-im-mention-empty">成员加载中...</div>';
            }
            if (mentionState.error) {
                return '<div class="ak-im-mention-empty">' + this.escapeHtml(mentionState.error) + '</div>';
            }
            const parts = [];
            if (this.canMentionAll()) {
                parts.push('<button class="ak-im-mention-item ak-im-mention-all" type="button" data-im-mention-all="1"><span class="ak-im-mention-avatar">全</span><span class="ak-im-mention-main"><span class="ak-im-mention-name">@全体成员</span><span class="ak-im-mention-sub">通知所有群成员</span></span></button>');
            }
            this.getFilteredMembers().forEach(function(member) {
                const username = String(member && member.username || '').trim().toLowerCase();
                const displayName = this.getDisplayName(member) || username;
                const avatarUrl = this.getAvatarUrl(member && member.avatar_url);
                const avatar = avatarUrl ? '<img class="ak-im-mention-avatar" src="' + this.escapeHtml(avatarUrl) + '" alt="">' : '<span class="ak-im-mention-avatar">' + this.escapeHtml(displayName.slice(0, 1) || '@') + '</span>';
                parts.push('<button class="ak-im-mention-item" type="button" data-im-mention-username="' + this.escapeHtml(username) + '">' + avatar + '<span class="ak-im-mention-main"><span class="ak-im-mention-name">' + this.escapeHtml(displayName) + '</span><span class="ak-im-mention-sub">' + this.escapeHtml(username) + '</span></span></button>');
            }.bind(this));
            if (!parts.length) return '<div class="ak-im-mention-empty">没有匹配的成员</div>';
            return parts.join('');
        },

        renderPanel() {
            this.bindInputEvents();
            const panelEl = this.getElements().mentionPanelEl;
            const mentionState = this.ensureState();
            if (!panelEl || !mentionState) return;
            panelEl.innerHTML = this.buildPanelMarkup();
            panelEl.classList.toggle('is-open', !!mentionState.open);
            panelEl.setAttribute('aria-hidden', mentionState.open ? 'false' : 'true');
            this.bindPanelEvents(panelEl);
        },

        bindPanelEvents(panelEl) {
            Array.prototype.forEach.call(panelEl.querySelectorAll('[data-im-mention-username]'), function(button) {
                button.addEventListener('click', function() {
                    this.insertUserMention(button.getAttribute('data-im-mention-username'));
                }.bind(this));
            }.bind(this));
            Array.prototype.forEach.call(panelEl.querySelectorAll('[data-im-mention-all]'), function(button) {
                button.addEventListener('click', function() {
                    this.insertAllMention();
                }.bind(this));
            }.bind(this));
        },

        replaceTriggerWith(text) {
            const mentionState = this.ensureState();
            const state = this.getState();
            const inputEl = this.getElements().inputEl;
            if (!mentionState || !state || !inputEl) return;
            const value = String(inputEl.value || '');
            const start = Math.max(0, Number(mentionState.triggerIndex || 0) || 0);
            const end = typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : value.length;
            const insertion = '@' + text + ' ';
            const merged = value.slice(0, start) + insertion + value.slice(end);
            inputEl.value = merged;
            state.inputValue = merged;
            if (this.ctx && typeof this.ctx.syncInputHeight === 'function') this.ctx.syncInputHeight();
            if (this.ctx && typeof this.ctx.syncComposerState === 'function') this.ctx.syncComposerState();
            try {
                const caret = start + insertion.length;
                inputEl.focus();
                inputEl.setSelectionRange(caret, caret);
            } catch (e) {}
            this.closePanel();
        },

        insertUserMention(username) {
            const mentionState = this.ensureState();
            const normalizedUsername = String(username || '').trim().toLowerCase();
            if (!mentionState || !normalizedUsername) return;
            const member = (Array.isArray(mentionState.members) ? mentionState.members : []).filter(function(item) {
                return String(item && item.username || '').trim().toLowerCase() === normalizedUsername;
            })[0] || null;
            const label = this.getDisplayName(member) || normalizedUsername;
            if (mentionState.selectedUsernames.indexOf(normalizedUsername) < 0) mentionState.selectedUsernames.push(normalizedUsername);
            mentionState.selectedLabels[normalizedUsername] = label;
            this.replaceTriggerWith(label);
        },

        insertAllMention() {
            const mentionState = this.ensureState();
            if (!mentionState || !this.canMentionAll()) return;
            mentionState.mentionAll = true;
            this.replaceTriggerWith(ALL_LABEL);
        },

        closePanel() {
            const mentionState = this.ensureState();
            if (!mentionState) return;
            mentionState.open = false;
            mentionState.keyword = '';
            mentionState.triggerIndex = -1;
            this.renderPanel();
        },

        resetDraft() {
            const mentionState = this.ensureState();
            if (!mentionState) return;
            mentionState.open = false;
            mentionState.keyword = '';
            mentionState.triggerIndex = -1;
            mentionState.selectedUsernames = [];
            mentionState.selectedLabels = {};
            mentionState.mentionAll = false;
            this.renderPanel();
        },

        buildTextPayload(content) {
            const mentionState = this.ensureState();
            const text = String(content || '');
            const payload = {
                message_type: 'text',
                content: text
            };
            if (!mentionState) return payload;
            const usernames = [];
            const usernameMap = {};
            (Array.isArray(mentionState.selectedUsernames) ? mentionState.selectedUsernames : []).forEach(function(username) {
                const normalizedUsername = String(username || '').trim().toLowerCase();
                const label = String(mentionState.selectedLabels && mentionState.selectedLabels[normalizedUsername] || '').trim();
                if (!normalizedUsername) return;
                if (usernameMap[normalizedUsername]) return;
                if (text.indexOf('@' + label) >= 0 || text.indexOf('@' + normalizedUsername) >= 0) {
                    usernameMap[normalizedUsername] = true;
                    usernames.push(normalizedUsername);
                }
            });
            if (usernames.length) payload.mention_usernames = usernames;
            if (mentionState.mentionAll && text.indexOf('@' + ALL_LABEL) >= 0 && this.canMentionAll()) payload.mention_all = true;
            return payload;
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.mentionManage = mentionManageModule;
})(window);
