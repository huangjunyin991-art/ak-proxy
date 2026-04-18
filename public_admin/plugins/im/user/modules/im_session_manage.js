(function(global) {
    'use strict';

    const sessionManageModule = {
        ctx: null,

        init(ctx) {
            this.ctx = ctx || null;
        },

        getElements() {
            return this.ctx && this.ctx.elements ? this.ctx.elements : {};
        },

        getActiveSession() {
            const state = this.ctx && this.ctx.state;
            const sessions = Array.isArray(state && state.sessions) ? state.sessions : [];
            return sessions.find(function(item) {
                return Number(item && item.conversation_id || 0) === Number(state && state.activeConversationId || 0);
            }) || null;
        },

        isGroupSession(item) {
            return String(item && item.conversation_type || '').toLowerCase() === 'group';
        },

        isSessionPinned(item) {
            return !!(item && (item.is_pinned || String(item.pin_type || '').toLowerCase() === 'manual' || String(item.pin_type || '').toLowerCase() === 'system'));
        },

        isSessionSystemPinned(item) {
            return String(item && item.pin_type || '').toLowerCase() === 'system';
        },

        getSessionDisplayName(item) {
            if (this.isGroupSession(item)) {
                return String(item && (item.conversation_title || item.peer_display_name || '内部群聊') || '内部群聊').trim();
            }
            return String(item && (item.peer_display_name || item.peer_username || '内部聊天') || '内部聊天').trim();
        },

        buildSessionAvatarMarkup(item) {
            if (!this.ctx || typeof this.ctx.buildAvatarBoxMarkup !== 'function') return '';
            if (this.isGroupSession(item) && typeof this.ctx.buildGroupAvatarMosaicMarkup === 'function') {
                const previewMembers = Array.isArray(item && item.members_preview) ? item.members_preview : [];
                if (previewMembers.length) {
                    return '<div class="ak-im-session-avatar is-mosaic">' + this.ctx.buildGroupAvatarMosaicMarkup(previewMembers, this.getSessionDisplayName(item)) + '</div>';
                }
            }
            const displayName = this.getSessionDisplayName(item);
            return this.ctx.buildAvatarBoxMarkup('ak-im-session-avatar', item && item.avatar_url, displayName, displayName + '头像');
        },

        getSessionSubtitle(item) {
            if (this.isGroupSession(item)) {
                const memberCount = Math.max(0, Number(item && item.member_count || 0) || 0);
                return memberCount > 0 ? ('群聊 · ' + memberCount + '人') : '群聊';
            }
            const peerUsername = String(item && item.peer_username || '').trim();
            return peerUsername ? ('账号：' + peerUsername) : '';
        },

        getSessionPreview(item) {
            return String(item && item.last_message_preview || '').trim() || '暂无消息';
        },

        getUnreadCount(item) {
            return Number(item && (item.unread_count || item.unread || 0) || 0);
        },

        renderSessionList() {
            if (!this.ctx || !this.ctx.state || typeof this.ctx.escapeHtml !== 'function' || typeof this.ctx.formatSessionTime !== 'function') return;
            const state = this.ctx.state;
            const elements = this.getElements();
            const sessionList = elements.sessionList;
            if (!sessionList) return;
            sessionList.innerHTML = '';
            if (!state.sessions.length) {
                const empty = document.createElement('div');
                empty.className = 'ak-im-empty';
                empty.textContent = state.allowed ? '暂无会话\n点击右上角“发起”开始单聊' : '当前账号未开通聊天';
                sessionList.appendChild(empty);
                return;
            }
            const self = this;
            state.sessions.forEach(function(item) {
                const node = document.createElement('div');
                const unreadCount = self.getUnreadCount(item);
                const subtitle = self.getSessionSubtitle(item);
                const preview = self.getSessionPreview(item);
                const previewText = subtitle ? (subtitle + ' · ' + preview) : preview;
                const isPinned = self.isSessionPinned(item);
                const isSystemPinned = self.isSessionSystemPinned(item);
                const pinText = isSystemPinned ? '群置顶' : '置顶';
                node.className = 'ak-im-session-item' + (item.conversation_id === state.activeConversationId ? ' ak-active' : '') + (isPinned ? ' is-pinned' : '');
                node.innerHTML = self.buildSessionAvatarMarkup(item) +
                    '<div class="ak-im-session-body">' +
                        '<div class="ak-im-session-title"><span class="ak-im-session-title-text">' + self.ctx.escapeHtml(self.getSessionDisplayName(item)) + '</span><span class="ak-im-session-pin-tag' + (isPinned ? ' visible' : '') + (isSystemPinned ? ' is-system' : '') + '">' + self.ctx.escapeHtml(pinText) + '</span></div>' +
                        '<div class="ak-im-session-time">' + self.ctx.escapeHtml(self.ctx.formatSessionTime(item.last_message_at || item.updated_at || item.created_at)) + '</div>' +
                        '<div class="ak-im-session-preview">' + self.ctx.escapeHtml(previewText) + '</div>' +
                        '<div class="ak-im-session-unread' + (unreadCount > 0 ? ' visible' : '') + '">' + self.ctx.escapeHtml(unreadCount > 99 ? '99+' : String(unreadCount || '')) + '</div>' +
                    '</div>';
                let pressTimer = null;
                let didOpenActionSheet = false;
                const startPress = function() {
                    if (pressTimer) clearTimeout(pressTimer);
                    pressTimer = setTimeout(function() {
                        didOpenActionSheet = true;
                        if (typeof self.ctx.openSessionActionSheet === 'function') self.ctx.openSessionActionSheet(item);
                    }, 420);
                };
                const cancelPress = function() {
                    if (pressTimer) {
                        clearTimeout(pressTimer);
                        pressTimer = null;
                    }
                };
                node.addEventListener('click', function() {
                    if (didOpenActionSheet) {
                        didOpenActionSheet = false;
                        return;
                    }
                    if (typeof self.ctx.closeActionSheet === 'function') self.ctx.closeActionSheet();
                    if (typeof self.ctx.closeReadProgressPanel === 'function') self.ctx.closeReadProgressPanel();
                    if (typeof self.ctx.closeEmojiPicker === 'function') self.ctx.closeEmojiPicker({ silent: true });
                    if (typeof self.ctx.closeMemberPanel === 'function') self.ctx.closeMemberPanel();
                    state.activeConversationId = item.conversation_id;
                    state.view = 'chat';
                    state.activeMessages = [];
                    if (typeof self.ctx.loadMessages === 'function') self.ctx.loadMessages(item.conversation_id);
                    if (typeof self.ctx.render === 'function') self.ctx.render();
                });
                node.addEventListener('pointerdown', startPress);
                node.addEventListener('pointerup', cancelPress);
                node.addEventListener('pointercancel', cancelPress);
                node.addEventListener('pointerleave', cancelPress);
                node.addEventListener('contextmenu', function(event) {
                    event.preventDefault();
                    didOpenActionSheet = true;
                    if (typeof self.ctx.openSessionActionSheet === 'function') self.ctx.openSessionActionSheet(item);
                });
                sessionList.appendChild(node);
            });
        },

        loadSessions() {
            if (!this.ctx || !this.ctx.state || typeof this.ctx.request !== 'function' || typeof this.ctx.render !== 'function') {
                return Promise.resolve(null);
            }
            const self = this;
            const state = this.ctx.state;
            return this.ctx.request(this.ctx.httpRoot + '/sessions').then(function(data) {
                state.sessions = Array.isArray(data && data.items) ? data.items : [];
                if (Number(state.activeConversationId || 0) > 0) {
                    const stillExists = state.sessions.some(function(item) {
                        return Number(item && item.conversation_id || 0) === Number(state.activeConversationId || 0);
                    });
                    if (!stillExists) {
                        state.activeConversationId = 0;
                        state.activeMessages = [];
                        if (typeof self.ctx.closeReadProgressPanel === 'function') self.ctx.closeReadProgressPanel();
                        if (typeof self.ctx.closeEmojiPicker === 'function') self.ctx.closeEmojiPicker({ silent: true });
                        if (typeof self.ctx.closeMemberPanel === 'function') self.ctx.closeMemberPanel();
                        if (typeof self.ctx.closeSettingsPanel === 'function') self.ctx.closeSettingsPanel();
                        if (state.view === 'chat') state.view = 'sessions';
                    }
                }
                self.ctx.render();
                return null;
            }).catch(function() {
                self.ctx.render();
                return null;
            });
        },

        requestSessionPin(conversationId, pinned) {
            if (!this.ctx || typeof this.ctx.request !== 'function') return;
            const targetConversationId = Number(conversationId || 0);
            if (!targetConversationId) return;
            if (typeof this.ctx.closeActionSheet === 'function') this.ctx.closeActionSheet();
            const self = this;
            this.ctx.request(this.ctx.httpRoot + '/sessions/pin', {
                method: 'POST',
                body: JSON.stringify({ conversation_id: targetConversationId, pinned: !!pinned })
            }).then(function() {
                return self.loadSessions();
            }).catch(function(error) {
                window.alert(error && error.message ? error.message : '更新置顶状态失败');
            });
        },

        clearSessionUnread(conversationId) {
            if (!this.ctx || !this.ctx.state) return;
            const state = this.ctx.state;
            const targetConversationId = Number(conversationId || 0);
            if (!targetConversationId || !Array.isArray(state.sessions) || !state.sessions.length) return;
            const self = this;
            let changed = false;
            state.sessions = state.sessions.map(function(item) {
                if (!item || Number(item.conversation_id || 0) !== targetConversationId) return item;
                const unreadCount = self.getUnreadCount(item);
                if (unreadCount <= 0) return item;
                changed = true;
                return Object.assign({}, item, {
                    unread_count: 0,
                    unread: 0
                });
            });
            if (changed && typeof this.ctx.render === 'function') this.ctx.render();
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.sessionManage = sessionManageModule;
})(window);
