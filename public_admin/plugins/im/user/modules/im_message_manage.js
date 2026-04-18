(function(global) {
    'use strict';

    const messageManageModule = {
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

        getSessionManage() {
            return this.ctx && typeof this.ctx.getSessionManage === 'function' ? this.ctx.getSessionManage() : null;
        },

        getGroupManage() {
            return this.ctx && typeof this.ctx.getGroupManage === 'function' ? this.ctx.getGroupManage() : null;
        },

        getActiveSession() {
            const sessionManage = this.getSessionManage();
            if (sessionManage && typeof sessionManage.getActiveSession === 'function') {
                return sessionManage.getActiveSession();
            }
            return null;
        },

        isGroupSession(item) {
            const sessionManage = this.getSessionManage();
            if (sessionManage && typeof sessionManage.isGroupSession === 'function') {
                return sessionManage.isGroupSession(item);
            }
            return String(item && item.conversation_type || '').toLowerCase() === 'group';
        },

        getSessionDisplayName(item) {
            const sessionManage = this.getSessionManage();
            if (sessionManage && typeof sessionManage.getSessionDisplayName === 'function') {
                return sessionManage.getSessionDisplayName(item);
            }
            if (this.isGroupSession(item)) {
                return String(item && (item.conversation_title || item.peer_display_name || '内部群聊') || '内部群聊').trim();
            }
            return String(item && (item.peer_display_name || item.peer_username || '内部聊天') || '内部聊天').trim();
        },

        getSessionSubtitle(item) {
            const sessionManage = this.getSessionManage();
            if (sessionManage && typeof sessionManage.getSessionSubtitle === 'function') {
                return sessionManage.getSessionSubtitle(item);
            }
            if (this.isGroupSession(item)) {
                const memberCount = Math.max(0, Number(item && item.member_count || 0) || 0);
                return memberCount > 0 ? ('群聊 · ' + memberCount + '人') : '群聊';
            }
            const peerUsername = String(item && item.peer_username || '').trim();
            return peerUsername ? ('账号：' + peerUsername) : '';
        },

        focusComposerInput() {
            const elements = this.getElements();
            const inputEl = elements.inputEl;
            if (!inputEl) return;
            try {
                inputEl.focus();
            } catch (e) {}
        },

        resetComposerInput() {
            const state = this.getState();
            const elements = this.getElements();
            const inputEl = elements.inputEl;
            if (inputEl) inputEl.value = '';
            if (state) state.inputValue = '';
            if (this.ctx && typeof this.ctx.syncInputHeight === 'function') this.ctx.syncInputHeight();
            if (this.ctx && typeof this.ctx.syncComposerState === 'function') this.ctx.syncComposerState();
        },

        shouldAutoMarkRead(conversationId) {
            const state = this.getState();
            return !!(state && state.open && state.view === 'chat' && Number(state.activeConversationId || 0) === Number(conversationId || 0) && document.visibilityState !== 'hidden');
        },

        canRecallMessage(item) {
            const state = this.getState();
            if (!item || typeof item !== 'object' || !state) return false;
            if (String(item.status || '').toLowerCase() === 'recalled') return false;
            if (String(item.sender_username || '') !== String(state.username || '')) return false;
            try {
                const sentAt = new Date(item.sent_at);
                if (isNaN(sentAt.getTime())) return false;
                return (Date.now() - sentAt.getTime()) <= 60 * 1000;
            } catch (e) {
                return false;
            }
        },

        getMessageReadProgress(item) {
            return item && item.read_progress && typeof item.read_progress === 'object' ? item.read_progress : null;
        },

        getProgressPercent(summary) {
            const percent = Number(summary && summary.progress_percent || 0) || 0;
            return Math.max(0, Math.min(100, Math.round(percent)));
        },

        shouldShowReadProgress(item, activeSession) {
            const summary = this.getMessageReadProgress(item);
            if (!summary) return false;
            return !!activeSession;
        },

        buildReadProgressButtonMarkup(item, activeSession) {
            if (!this.ctx || typeof this.ctx.escapeHtml !== 'function') return '';
            const summary = this.getMessageReadProgress(item);
            if (!summary || !this.shouldShowReadProgress(item, activeSession)) return '';
            const percent = this.getProgressPercent(summary);
            const isComplete = !!summary.is_fully_read || percent >= 100;
            const label = isComplete ? '✓' : (percent + '%');
            const radius = 9;
            const circumference = 56.549;
            const dashOffset = (circumference * (1 - (Math.max(0, Math.min(100, percent)) / 100))).toFixed(3);
            const ariaLabel = isComplete ? '查看消息已读进度，已全部读完' : ('查看消息已读进度，当前 ' + percent + '%');
            return '<button class="ak-im-progress-btn' + (isComplete ? ' is-complete' : '') + '" type="button" aria-label="' + ariaLabel + '">' +
                '<svg class="ak-im-progress-ring" viewBox="0 0 24 24" aria-hidden="true"><circle class="ak-im-progress-track" cx="12" cy="12" r="' + radius + '"></circle><circle class="ak-im-progress-value" cx="12" cy="12" r="' + radius + '" style="stroke-dasharray:' + circumference + ';stroke-dashoffset:' + dashOffset + '"></circle></svg>' +
                '<span class="ak-im-progress-label">' + this.ctx.escapeHtml(label) + '</span>' +
            '</button>';
        },

        renderMessages() {
            const state = this.getState();
            if (!state || !this.ctx || typeof this.ctx.escapeHtml !== 'function' || typeof this.ctx.formatTime !== 'function' || typeof this.ctx.buildAvatarBoxMarkup !== 'function' || typeof this.ctx.getAvatarUrl !== 'function') return;
            const elements = this.getElements();
            const headerTitle = elements.chatTitleEl;
            const headerSubtitle = elements.chatSubtitleEl;
            const chatTitleBtnEl = elements.chatTitleBtnEl;
            const chatMenuBtnEl = elements.chatMenuBtnEl;
            const messageList = elements.messageList;
            const inputEl = elements.inputEl;
            if (!messageList) return;
            const activeSession = this.getActiveSession();
            const activeSessionDisplayName = activeSession ? this.getSessionDisplayName(activeSession) : '内部聊天';
            const isActiveGroupSession = !!activeSession && this.isGroupSession(activeSession);
            const subtitleText = activeSession ? this.getSessionSubtitle(activeSession) : '';
            if (headerTitle) headerTitle.textContent = activeSession ? activeSessionDisplayName : '内部聊天';
            if (headerSubtitle) headerSubtitle.textContent = activeSession ? subtitleText : '';
            if (chatTitleBtnEl) {
                const canOpenGroupInfo = !!activeSession && isActiveGroupSession;
                chatTitleBtnEl.disabled = !canOpenGroupInfo;
                chatTitleBtnEl.classList.toggle('is-clickable', canOpenGroupInfo);
                chatTitleBtnEl.setAttribute('aria-label', canOpenGroupInfo ? '打开群信息' : '聊天标题');
            }
            if (chatMenuBtnEl) {
                const canOpenMenu = !!activeSession && isActiveGroupSession;
                chatMenuBtnEl.disabled = !canOpenMenu;
                chatMenuBtnEl.classList.toggle('is-hidden', !canOpenMenu);
            }
            messageList.innerHTML = '';
            if (!state.activeConversationId) {
                const empty = document.createElement('div');
                empty.className = 'ak-im-empty';
                empty.textContent = state.allowed ? '选择一个会话\n开始内部单聊' : '当前账号未开通聊天';
                messageList.appendChild(empty);
                return;
            }
            if (!state.activeMessages.length) {
                const empty = document.createElement('div');
                empty.className = 'ak-im-empty';
                empty.textContent = '还没有消息\n发一条试试';
                messageList.appendChild(empty);
                return;
            }
            const self = this;
            state.activeMessages.forEach(function(item) {
                const isSelf = item.sender_username === state.username;
                const isRecalled = String(item.status || '').toLowerCase() === 'recalled';
                if (isRecalled) {
                    const systemRow = document.createElement('div');
                    systemRow.className = 'ak-im-system-row';
                    const systemText = isSelf ? '你撤回了一条消息' : '对方撤回了一条消息';
                    const draftText = String(state.recalledDraftByMessageId[item.id] || '').trim();
                    systemRow.textContent = systemText;
                    if (isSelf && draftText) {
                        const link = document.createElement('a');
                        link.href = 'javascript:void(0)';
                        link.textContent = '重新编辑';
                        link.addEventListener('click', function(event) {
                            event.preventDefault();
                            event.stopPropagation();
                            if (inputEl) inputEl.value = draftText;
                            state.inputValue = draftText;
                            state.view = 'chat';
                            state.open = true;
                            if (self.ctx && typeof self.ctx.syncInputHeight === 'function') self.ctx.syncInputHeight();
                            if (self.ctx && typeof self.ctx.syncComposerState === 'function') self.ctx.syncComposerState();
                            self.focusComposerInput();
                        });
                        systemRow.appendChild(link);
                    }
                    messageList.appendChild(systemRow);
                    return;
                }
                const wrapper = document.createElement('div');
                const summary = self.getMessageReadProgress(item);
                const senderDisplayName = String(item && (item.sender_display_name || item.sender_username) || '').trim();
                const displayName = isSelf ? (state.displayName || senderDisplayName || state.username || '我') : (isActiveGroupSession ? (senderDisplayName || item.sender_username || '群成员') : (activeSession ? activeSessionDisplayName : (senderDisplayName || item.sender_username || '对方')));
                const metaText = summary && Number(summary.total_count || 0) > 0 ? ('已读 ' + Number(summary.read_count || 0) + '/' + Number(summary.total_count || 0)) : ((isSelf && item.read) ? '对方已读' : '');
                const senderText = !isSelf && isActiveGroupSession ? String(senderDisplayName || item.sender_username || '').trim() : '';
                const progressMarkup = self.buildReadProgressButtonMarkup(item, activeSession);
                const avatarText = displayName || item.sender_username || '成员';
                const avatarUrl = isSelf ? self.ctx.getAvatarUrl((state.profile && state.profile.avatar_url) || item.sender_avatar_url) : self.ctx.getAvatarUrl(item.sender_avatar_url);
                const footerMarkup = (metaText || progressMarkup) ? '<div class="ak-im-message-footer">' +
                    (metaText ? '<div class="ak-im-meta">' + self.ctx.escapeHtml(metaText) + '</div>' : '') +
                    progressMarkup +
                '</div>' : '';
                wrapper.innerHTML = '<div class="ak-im-time-divider">' + self.ctx.escapeHtml(self.ctx.formatTime(item.sent_at)) + '</div>' +
                    '<div class="ak-im-message-row ' + (isSelf ? 'ak-self' : 'ak-peer') + '">' +
                        self.ctx.buildAvatarBoxMarkup('ak-im-avatar', avatarUrl, avatarText, avatarText + '头像') +
                        '<div class="ak-im-message-main">' +
                            (senderText ? '<div class="ak-im-message-sender">' + self.ctx.escapeHtml(senderText) + '</div>' : '') +
                            '<div class="ak-im-bubble">' + self.ctx.escapeHtml(item.content || item.content_preview || '') + '</div>' +
                            footerMarkup +
                        '</div>' +
                    '</div>';
                if (isSelf) {
                    const bubble = wrapper.querySelector('.ak-im-bubble');
                    if (bubble) {
                        let pressTimer = null;
                        const startPress = function() {
                            if (!self.canRecallMessage(item)) return;
                            if (pressTimer) clearTimeout(pressTimer);
                            pressTimer = setTimeout(function() {
                                if (typeof self.ctx.openActionSheet === 'function') self.ctx.openActionSheet(item);
                            }, 420);
                        };
                        const cancelPress = function() {
                            if (pressTimer) {
                                clearTimeout(pressTimer);
                                pressTimer = null;
                            }
                        };
                        bubble.addEventListener('pointerdown', startPress);
                        bubble.addEventListener('pointerup', cancelPress);
                        bubble.addEventListener('pointercancel', cancelPress);
                        bubble.addEventListener('pointerleave', cancelPress);
                        bubble.addEventListener('contextmenu', function(event) {
                            event.preventDefault();
                            if (!self.canRecallMessage(item)) return;
                            if (typeof self.ctx.openActionSheet === 'function') self.ctx.openActionSheet(item);
                        });
                    }
                }
                const progressBtn = wrapper.querySelector('.ak-im-progress-btn');
                if (progressBtn) {
                    progressBtn.addEventListener('click', function(event) {
                        event.preventDefault();
                        event.stopPropagation();
                        if (typeof self.ctx.openReadProgressPanel === 'function') self.ctx.openReadProgressPanel(item);
                    });
                }
                messageList.appendChild(wrapper);
            });
            messageList.scrollTop = messageList.scrollHeight;
        },

        loadMessages(conversationId) {
            const state = this.getState();
            if (!state || !this.ctx || typeof this.ctx.request !== 'function' || typeof this.ctx.render !== 'function') {
                return Promise.resolve(null);
            }
            const targetConversationId = Number(conversationId || 0);
            if (!targetConversationId) {
                state.activeMessages = [];
                this.ctx.render();
                return Promise.resolve(null);
            }
            const self = this;
            return this.ctx.request(this.ctx.httpRoot + '/messages?conversation_id=' + encodeURIComponent(targetConversationId)).then(function(data) {
                state.activeMessages = Array.isArray(data && data.items) ? data.items : [];
                self.ctx.render();
                self.markRead(targetConversationId);
                return null;
            }).catch(function() {
                self.ctx.render();
                return null;
            });
        },

        sendCurrentMessage() {
            const state = this.getState();
            const elements = this.getElements();
            const inputEl = elements.inputEl;
            if (!state || !state.allowed || !state.activeConversationId || !inputEl) return Promise.resolve(null);
            const content = String(inputEl.value || '').trim();
            if (!content) return Promise.resolve(null);
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({
                    type: 'im.message.send',
                    payload: {
                        conversation_id: state.activeConversationId,
                        content: content
                    }
                }));
                this.resetComposerInput();
                return Promise.resolve(null);
            }
            const self = this;
            return this.ctx.request(this.ctx.httpRoot + '/messages', {
                method: 'POST',
                body: JSON.stringify({
                    conversation_id: state.activeConversationId,
                    content: content
                })
            }).then(function() {
                const activeConversationId = Number(state.activeConversationId || 0);
                self.resetComposerInput();
                return self.loadMessages(activeConversationId).then(function() {
                    return typeof self.ctx.loadSessions === 'function' ? self.ctx.loadSessions() : null;
                });
            }).catch(function(error) {
                window.alert(error && error.message ? error.message : '发送失败');
                return null;
            });
        },

        recallMessage(messageId, conversationId, draftText) {
            const state = this.getState();
            if (!state || !this.ctx || typeof this.ctx.request !== 'function') return Promise.resolve(null);
            if (typeof this.ctx.closeActionSheet === 'function') this.ctx.closeActionSheet();
            const mid = Number(messageId || 0);
            const cid = Number(conversationId || 0);
            if (!mid || !cid) return Promise.resolve(null);
            const draft = String(draftText || '').trim();
            if (draft) state.recalledDraftByMessageId[mid] = draft;
            const self = this;
            return this.ctx.request(this.ctx.httpRoot + '/messages/recall', {
                method: 'POST',
                body: JSON.stringify({ message_id: mid })
            }).then(function(data) {
                const item = data && data.item ? data.item : null;
                if (item && item.id) self.applyMessageRecalled(item);
                return typeof self.ctx.loadSessions === 'function' ? self.ctx.loadSessions() : null;
            }).catch(function(error) {
                window.alert(error && error.message ? error.message : '撤回失败');
                return null;
            });
        },

        applyMessageRecalled(item) {
            const state = this.getState();
            if (!state || !item || !item.id) return;
            const cid = Number(item.conversation_id || 0);
            if (!cid) return;
            if (Number(cid) === Number(state.activeConversationId || 0)) {
                const next = [];
                state.activeMessages.forEach(function(current) {
                    if (!current || Number(current.id || 0) !== Number(item.id || 0)) {
                        next.push(current);
                        return;
                    }
                    next.push(Object.assign({}, current, {
                        status: 'recalled',
                        content: '',
                        content_preview: '[消息已撤回]'
                    }));
                });
                state.activeMessages = next;
                this.renderMessages();
            }
        },

        clearSessionUnread(conversationId) {
            const state = this.getState();
            const sessionManage = this.getSessionManage();
            if (sessionManage && typeof sessionManage.clearSessionUnread === 'function') {
                sessionManage.clearSessionUnread(conversationId);
                return;
            }
            if (!state) return;
            const targetConversationId = Number(conversationId || 0);
            if (!targetConversationId || !Array.isArray(state.sessions) || !state.sessions.length) return;
            let changed = false;
            state.sessions = state.sessions.map(function(item) {
                if (!item || Number(item.conversation_id || 0) !== targetConversationId) return item;
                const unreadCount = Number(item && (item.unread_count || item.unread || 0) || 0);
                if (unreadCount <= 0) return item;
                changed = true;
                return Object.assign({}, item, {
                    unread_count: 0,
                    unread: 0
                });
            });
            if (changed && this.ctx && typeof this.ctx.render === 'function') this.ctx.render();
        },

        markRead(conversationId) {
            const state = this.getState();
            if (!state || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
            const targetConversationId = Number(conversationId || state.activeConversationId || 0);
            if (!targetConversationId || !this.shouldAutoMarkRead(targetConversationId) || !state.activeMessages.length) return;
            let lastPeerMessage = null;
            for (let index = state.activeMessages.length - 1; index >= 0; index -= 1) {
                const candidate = state.activeMessages[index];
                if (candidate && candidate.sender_username !== state.username) {
                    lastPeerMessage = candidate;
                    break;
                }
            }
            if (!lastPeerMessage || !lastPeerMessage.seq_no) return;
            const lastSeqNo = Number(lastPeerMessage.seq_no || 0);
            if (!lastSeqNo) return;
            const previousMarkedSeqNo = Number(state.lastReadSentByConversation[targetConversationId] || 0);
            if (lastSeqNo <= previousMarkedSeqNo) return;
            state.lastReadSentByConversation[targetConversationId] = lastSeqNo;
            state.ws.send(JSON.stringify({
                type: 'im.message.read',
                payload: {
                    conversation_id: targetConversationId,
                    seq_no: lastSeqNo
                }
            }));
            this.clearSessionUnread(targetConversationId);
        },

        refreshMemberPanel(conversationId) {
            const state = this.getState();
            if (!state || !this.ctx || typeof this.ctx.request !== 'function' || typeof this.ctx.renderMemberPanel !== 'function') return;
            const targetConversationId = Number(conversationId || 0);
            if (!targetConversationId || !state.memberPanelOpen || Number(state.memberPanelConversationId || 0) !== targetConversationId) return;
            state.memberPanelLoading = true;
            state.memberPanelError = '';
            this.ctx.renderMemberPanel();
            this.ctx.request(this.ctx.httpRoot + '/sessions/members?conversation_id=' + encodeURIComponent(targetConversationId)).then(function(membersData) {
                if (!state.memberPanelOpen || Number(state.memberPanelConversationId || 0) !== targetConversationId) return;
                state.memberPanelLoading = false;
                state.memberPanelData = membersData && membersData.item ? membersData.item : null;
                if (typeof this.ctx.renderMemberPanel === 'function') this.ctx.renderMemberPanel();
            }.bind(this)).catch(function(error) {
                if (!state.memberPanelOpen || Number(state.memberPanelConversationId || 0) !== targetConversationId) return;
                state.memberPanelLoading = false;
                state.memberPanelError = error && error.message ? error.message : '读取群成员失败';
                if (typeof this.ctx.renderMemberPanel === 'function') this.ctx.renderMemberPanel();
            }.bind(this));
        },

        handleSocketPayload(data) {
            const state = this.getState();
            if (!state || !data || typeof data !== 'object') return;
            if (data.type === 'im.message.created') {
                const item = data.payload || null;
                if (!item || !item.conversation_id) return;
                if (Number(item.conversation_id) === Number(state.activeConversationId || 0)) {
                    state.activeMessages.push(item);
                    this.renderMessages();
                    if (item.sender_username !== state.username) this.markRead(item.conversation_id);
                }
                if (typeof this.ctx.loadSessions === 'function') this.ctx.loadSessions();
                return;
            }
            if (data.type === 'im.message.read') {
                const payload = data.payload || null;
                if (payload && Number(payload.conversation_id || 0) > 0 && typeof this.ctx.loadSessions === 'function') {
                    this.ctx.loadSessions();
                }
                if (payload && Number(payload.conversation_id || 0) === Number(state.activeConversationId || 0)) {
                    this.loadMessages(state.activeConversationId);
                }
                return;
            }
            if (data.type === 'im.message.recalled') {
                const payload = data.payload || null;
                if (payload && payload.id) {
                    this.applyMessageRecalled(payload);
                    if (typeof this.ctx.loadSessions === 'function') this.ctx.loadSessions();
                }
                return;
            }
            if (data.type === 'im.session.updated') {
                const payload = data.payload || null;
                if (typeof this.ctx.loadSessions === 'function') this.ctx.loadSessions();
                if ((state.homeTab === 'contacts' || state.contactsLoaded) && typeof this.ctx.loadContacts === 'function') {
                    this.ctx.loadContacts();
                }
                if (payload && Number(payload.conversation_id || 0) > 0) {
                    const updatedConversationId = Number(payload.conversation_id || 0);
                    if (updatedConversationId === Number(state.activeConversationId || 0)) {
                        this.loadMessages(state.activeConversationId);
                    }
                    this.refreshMemberPanel(updatedConversationId);
                    if (state.groupSettingsOpen && Number(state.groupSettingsConversationId || 0) === updatedConversationId && typeof this.ctx.loadGroupSettings === 'function') {
                        this.ctx.loadGroupSettings(updatedConversationId);
                    }
                }
            }
        },

        ensureWebSocket() {
            const state = this.getState();
            if (!state || !this.ctx || typeof this.ctx.createWebSocket !== 'function') return;
            if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
            const self = this;
            try {
                state.ws = this.ctx.createWebSocket();
                if (!state.ws) return;
                state.ws.addEventListener('message', function(event) {
                    try {
                        const data = JSON.parse(event.data || '{}');
                        self.handleSocketPayload(data);
                    } catch (e) {}
                });
                state.ws.addEventListener('close', function() {
                    state.ws = null;
                    setTimeout(function() {
                        if (state.allowed) self.ensureWebSocket();
                    }, 1500);
                });
            } catch (e) {}
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.messageManage = messageManageModule;
})(window);
