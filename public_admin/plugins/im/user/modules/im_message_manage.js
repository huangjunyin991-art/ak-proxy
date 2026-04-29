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

        getActiveSendRestrictionMessage() {
            const activeSession = this.getActiveSession();
            if (!activeSession || activeSession.can_send !== false) return '';
            return String(activeSession.send_restriction_hint || '').trim() || '当前会话暂不可发送消息';
        },

        markConversationRestricted(conversationId, restriction, message) {
            const state = this.getState();
            const targetConversationId = Number(conversationId || 0);
            if (!state || !targetConversationId) return;
            state.sessions = (Array.isArray(state.sessions) ? state.sessions : []).map(function(item) {
                if (Number(item && item.conversation_id || 0) !== targetConversationId) return item;
                return Object.assign({}, item, {
                    can_send: false,
                    send_restriction: String(restriction || '').trim(),
                    send_restriction_hint: String(message || '').trim() || '当前会话暂不可发送消息'
                });
            });
            if (Number(state.activeConversationId || 0) === targetConversationId && this.ctx && typeof this.ctx.syncComposerState === 'function') {
                this.ctx.syncComposerState();
            }
            if (this.ctx && typeof this.ctx.render === 'function') {
                this.ctx.render();
            }
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
            if (Number(item.id || 0) <= 0 || this.isLocalTempMessage(item)) return false;
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

        isLocalTempMessage(item) {
            if (!item || typeof item !== 'object') return false;
            if (String(item.__akTempId || '').trim()) return true;
            return Number(item.id || 0) <= 0 && !!String(item.client_temp_id || '').trim();
        },

        getLocalTempId(item) {
            if (!item || typeof item !== 'object') return '';
            return String(item.__akTempId || item.client_temp_id || '').trim();
        },

        getLocalMessageStatus(item) {
            return String(item && item.__akLocalStatus || '').trim().toLowerCase();
        },

        findLocalMessageIndexByTempId(tempId, conversationId) {
            const state = this.getState();
            const normalizedTempId = String(tempId || '').trim();
            const targetConversationId = Number(conversationId || 0);
            if (!state || !normalizedTempId || !targetConversationId) return -1;
            let matchedIndex = -1;
            (Array.isArray(state.activeMessages) ? state.activeMessages : []).forEach(function(current, index) {
                if (matchedIndex >= 0 || !current) return;
                if (Number(current.conversation_id || 0) !== targetConversationId) return;
                if (String(current.__akTempId || current.client_temp_id || '').trim() !== normalizedTempId) return;
                matchedIndex = index;
            });
            return matchedIndex;
        },

        getLocalMessageMetaText(item, fallbackText) {
            const localStatus = this.getLocalMessageStatus(item);
            if (localStatus === 'preparing') return '图片处理中...';
            if (localStatus === 'uploading') {
                const progress = Math.max(0, Math.min(100, Number(item && item.__akUploadProgress || 0) || 0));
                return progress > 0 ? ('上传中 ' + progress + '%') : '上传中...';
            }
            if (localStatus === 'failed') return '发送失败';
            return String(fallbackText || '').trim();
        },

        buildImageMatchKey(item) {
            if (!item || typeof item !== 'object') return '';
            if (String(item.message_type || '').trim().toLowerCase() !== 'image') return '';
            const rawContent = String(item.content || '').trim();
            if (!rawContent) return '';
            try {
                const parsed = JSON.parse(rawContent);
                const senderUsername = String(item.sender_username || '').trim().toLowerCase();
                const fileName = String(parsed && parsed.file_name || '').trim().toLowerCase();
                const fileSize = Math.max(0, Number(parsed && parsed.file_size || 0) || 0);
                const source = String(parsed && parsed.source || '').trim().toLowerCase();
                const parts = [senderUsername, fileName, String(fileSize), source];
                return parts.join('|');
            } catch (e) {
                return '';
            }
        },

        findPendingLocalMessageIndex(item) {
            const state = this.getState();
            if (!state || !item || typeof item !== 'object') return -1;
            const targetConversationId = Number(item.conversation_id || 0);
            if (!targetConversationId) return -1;
            const matchKey = this.buildImageMatchKey(item);
            if (!matchKey) return -1;
            const targetSentAt = new Date(item.sent_at).getTime();
            const self = this;
            let matchedIndex = -1;
            (Array.isArray(state.activeMessages) ? state.activeMessages : []).forEach(function(current, index) {
                if (matchedIndex >= 0 || !self.isLocalTempMessage(current)) return;
                const localStatus = self.getLocalMessageStatus(current);
                if (localStatus !== 'preparing' && localStatus !== 'uploading') return;
                if (Number(current.conversation_id || 0) !== targetConversationId) return;
                if (self.buildImageMatchKey(current) !== matchKey) return;
                const currentSentAt = new Date(current.sent_at).getTime();
                if (!isNaN(targetSentAt) && !isNaN(currentSentAt) && Math.abs(targetSentAt - currentSentAt) > (2 * 60 * 1000)) return;
                matchedIndex = index;
            });
            return matchedIndex;
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

        getMessageBubbleMarkup(item) {
            if (this.ctx && typeof this.ctx.buildMessageBubbleMarkup === 'function') {
                return this.ctx.buildMessageBubbleMarkup(item);
            }
            if (!this.ctx || typeof this.ctx.escapeHtml !== 'function') return '';
            return this.ctx.escapeHtml(item && (item.content || item.content_preview || '') || '');
        },

        getMessageBubbleClassName(item) {
            const classes = ['ak-im-bubble'];
            if (this.ctx && typeof this.ctx.getMessageBubbleClassName === 'function') {
                const nextClassName = String(this.ctx.getMessageBubbleClassName(item) || '').trim();
                if (nextClassName) classes.push(nextClassName);
            }
            return classes.join(' ');
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
            const activeSessionTitleMarkup = activeSession
                ? (typeof this.buildSessionTitleMarkup === 'function'
                    ? this.buildSessionTitleMarkup(activeSession)
                    : (this.ctx && typeof this.ctx.buildDisplayNameWithHonorMarkup === 'function' && !isActiveGroupSession
                        ? this.ctx.buildDisplayNameWithHonorMarkup(activeSessionDisplayName, activeSession && activeSession.peer_honor_name, '内部聊天', {
                            wrapperClassName: 'ak-im-name-with-honor',
                            textClassName: 'ak-im-name-text',
                            badgeClassName: 'ak-im-honor-badge'
                        })
                        : this.ctx.escapeHtml(activeSessionDisplayName || '内部聊天')))
                : '内部聊天';
            const subtitleText = activeSession ? this.getSessionSubtitle(activeSession) : '';
            if (headerTitle) {
                if (activeSession) headerTitle.innerHTML = activeSessionTitleMarkup;
                else headerTitle.textContent = '内部聊天';
            }
            if (headerSubtitle) headerSubtitle.textContent = activeSession ? subtitleText : '';
            if (chatTitleBtnEl) {
                const canOpenGroupInfo = !!activeSession && isActiveGroupSession;
                chatTitleBtnEl.disabled = !canOpenGroupInfo;
                chatTitleBtnEl.classList.toggle('is-clickable', canOpenGroupInfo);
                chatTitleBtnEl.setAttribute('aria-label', canOpenGroupInfo ? '打开群信息' : '聊天标题');
                const groupAdmins = this.ctx && typeof this.ctx.getGroupAdmins === 'function' ? this.ctx.getGroupAdmins() : null;
                if (canOpenGroupInfo && groupAdmins && typeof groupAdmins.bindGroupAvatarLongPress === 'function') {
                    groupAdmins.bindGroupAvatarLongPress(chatTitleBtnEl, Number(activeSession && activeSession.conversation_id || state.activeConversationId || 0));
                } else if (groupAdmins && typeof groupAdmins.unbindPress === 'function') {
                    groupAdmins.unbindPress(chatTitleBtnEl);
                }
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
            if (isActiveGroupSession && activeSession && activeSession.all_muted) {
                const allMuteBanner = document.createElement('div');
                allMuteBanner.className = 'ak-im-all-mute-banner';
                const myRole = String(activeSession.my_role || '').trim().toLowerCase();
                allMuteBanner.textContent = (myRole === 'owner' || myRole === 'admin') ? '全体禁言已开启，你仍可发言' : '全体禁言中，仅群主和管理员可发言';
                messageList.appendChild(allMuteBanner);
            }
            if (state.activeMessagesLoading && !state.activeMessages.length) {
                const empty = document.createElement('div');
                empty.className = 'ak-im-empty';
                empty.textContent = '消息加载中...';
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
                const senderHonorName = String(item && item.sender_honor_name || '').trim();
                const displayName = isSelf ? (state.displayName || senderDisplayName || state.username || '我') : (isActiveGroupSession ? (senderDisplayName || item.sender_username || '群成员') : (activeSession ? activeSessionDisplayName : (senderDisplayName || item.sender_username || '对方')));
                const defaultMetaText = summary && Number(summary.total_count || 0) > 0 ? ('已读 ' + Number(summary.read_count || 0) + '/' + Number(summary.total_count || 0)) : ((isSelf && item.read) ? '对方已读' : '');
                const metaText = self.getLocalMessageMetaText(item, defaultMetaText);
                const senderMarkup = !isSelf && isActiveGroupSession
                    ? (self.ctx && typeof self.ctx.buildDisplayNameWithHonorMarkup === 'function'
                        ? self.ctx.buildDisplayNameWithHonorMarkup(senderDisplayName || item.sender_username || '群成员', senderHonorName, '群成员')
                        : self.ctx.escapeHtml(senderDisplayName || item.sender_username || '群成员'))
                    : '';
                const progressMarkup = self.buildReadProgressButtonMarkup(item, activeSession);
                const avatarText = displayName || item.sender_username || '成员';
                const avatarUrl = isSelf ? self.ctx.getAvatarUrl((state.profile && state.profile.avatar_url) || item.sender_avatar_url) : self.ctx.getAvatarUrl(item.sender_avatar_url);
                const bubbleClassName = self.getMessageBubbleClassName(item);
                const bubbleMarkup = self.getMessageBubbleMarkup(item);
                const footerMarkup = (metaText || progressMarkup) ? '<div class="ak-im-message-footer">' +
                    (metaText ? '<div class="ak-im-meta">' + self.ctx.escapeHtml(metaText) + '</div>' : '') +
                    progressMarkup +
                '</div>' : '';
                wrapper.innerHTML = '<div class="ak-im-time-divider">' + self.ctx.escapeHtml(self.ctx.formatTime(item.sent_at)) + '</div>' +
                    '<div class="ak-im-message-row ' + (isSelf ? 'ak-self' : 'ak-peer') + '">' +
                        '<div class="ak-im-avatar-wrap" data-im-message-avatar-username="' + self.ctx.escapeHtml(String(item && item.sender_username || '').trim().toLowerCase()) + '">' + self.ctx.buildAvatarBoxMarkup('ak-im-avatar', avatarUrl, avatarText, avatarText + '头像') + '</div>' +
                        '<div class="ak-im-message-main">' +
                            (senderMarkup ? '<div class="ak-im-message-sender">' + senderMarkup + '</div>' : '') +
                            '<div class="' + bubbleClassName + '">' + bubbleMarkup + '</div>' +
                            footerMarkup +
                        '</div>' +
                    '</div>';
                const messageAvatar = wrapper.querySelector('[data-im-message-avatar-username]');
                const groupAdmins = self.ctx && typeof self.ctx.getGroupAdmins === 'function' ? self.ctx.getGroupAdmins() : null;
                if (messageAvatar && groupAdmins && typeof groupAdmins.bindMemberLongPress === 'function' && isActiveGroupSession) {
                    groupAdmins.bindMemberLongPress(messageAvatar, Number(activeSession && activeSession.conversation_id || state.activeConversationId || 0), messageAvatar.getAttribute('data-im-message-avatar-username'));
                }
                if (isSelf) {
                    const bubble = wrapper.querySelector('.ak-im-bubble');
                    if (bubble && !bubble.classList.contains('ak-im-bubble-voice')) {
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
                    }
                    if (bubble) {
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
            if (this.ctx && typeof this.ctx.syncVoiceMessageBubbles === 'function') {
                this.ctx.syncVoiceMessageBubbles();
            }
            messageList.scrollTop = messageList.scrollHeight;
        },

        sendMessagePayload(payload, options) {
            const state = this.getState();
            if (!state || !state.allowed || !state.activeConversationId || !this.ctx || typeof this.ctx.request !== 'function') {
                return Promise.resolve(null);
            }
            const restrictedMessage = this.getActiveSendRestrictionMessage();
            if (restrictedMessage) {
                return Promise.reject(new Error(restrictedMessage));
            }
            const requestPayload = Object.assign({
                conversation_id: state.activeConversationId
            }, payload || {});
            const self = this;
            const finalizeLocalState = function() {
                if (!options || options.resetComposer !== false) self.resetComposerInput();
                if (options && typeof options.onAfterLocalSend === 'function') options.onAfterLocalSend();
            };
            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(JSON.stringify({
                    type: 'im.message.send',
                    payload: requestPayload
                }));
                finalizeLocalState();
                return Promise.resolve(null);
            }
            return this.ctx.request(this.ctx.httpRoot + '/messages', {
                method: 'POST',
                body: JSON.stringify(requestPayload)
            }).then(function() {
                const activeConversationId = Number(state.activeConversationId || 0);
                finalizeLocalState();
                return self.loadMessages(activeConversationId).then(function() {
                    return typeof self.ctx.loadSessions === 'function' ? self.ctx.loadSessions() : null;
                });
            });
        },

        loadMessages(conversationId) {
            const state = this.getState();
            if (!state || !this.ctx || typeof this.ctx.request !== 'function' || typeof this.ctx.render !== 'function') {
                return Promise.resolve(null);
            }
            const targetConversationId = Number(conversationId || 0);
            if (!targetConversationId) {
                state.activeMessages = [];
                state.activeMessagesLoading = false;
                this.ctx.render();
                return Promise.resolve(null);
            }
            const self = this;
            state.activeMessagesLoading = true;
            return this.ctx.request(this.ctx.httpRoot + '/messages?conversation_id=' + encodeURIComponent(targetConversationId)).then(function(data) {
                state.activeMessages = Array.isArray(data && data.items) ? data.items : [];
                state.activeMessagesLoading = false;
                self.ctx.render();
                self.markRead(targetConversationId);
                return null;
            }).catch(function() {
                state.activeMessagesLoading = false;
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
            return this.sendMessagePayload({
                message_type: 'text',
                content: content
            }).catch(function(error) {
                window.alert(error && error.message ? error.message : '发送失败');
                return null;
            });
        },

        sendCustomEmoji(emojiAssetId, emojiCode) {
            const state = this.getState();
            if (!state || !state.allowed || !state.activeConversationId) return Promise.resolve(null);
            const normalizedEmojiAssetId = Number(emojiAssetId || 0);
            if (!normalizedEmojiAssetId) return Promise.resolve(null);
            return this.sendMessagePayload({
                message_type: 'emoji_custom',
                emoji_asset_id: normalizedEmojiAssetId,
                content: String(emojiCode || '').trim()
            }, {
                resetComposer: false
            }).catch(function(error) {
                window.alert(error && error.message ? error.message : '发送表情失败');
                return null;
            });
        },

        sendVoiceMessage(blob, meta) {
            const state = this.getState();
            if (!state || !state.allowed || !state.activeConversationId || !blob || !blob.size || !this.ctx || typeof this.ctx.requestFormData !== 'function') {
                return Promise.resolve(null);
            }
            const restrictedMessage = this.getActiveSendRestrictionMessage();
            if (restrictedMessage) {
                return Promise.reject(new Error(restrictedMessage));
            }
            const targetConversationId = Number(state.activeConversationId || 0);
            if (!targetConversationId) return Promise.resolve(null);
            const durationMs = Math.max(1, Number(meta && meta.durationMs || 0) || 0);
            const fileName = String(meta && meta.fileName || '').trim() || 'voice-message.webm';
            const formData = new FormData();
            formData.append('conversation_id', String(targetConversationId));
            formData.append('duration_ms', String(durationMs));
            formData.append('file', blob, fileName);
            const self = this;
            return this.ctx.requestFormData(this.ctx.httpRoot + '/messages/voice', formData, {
                method: 'POST'
            }).then(function(data) {
                const item = data && data.item ? data.item : null;
                if (item && self.upsertActiveMessage(item)) {
                    self.renderMessages();
                }
                return typeof self.ctx.loadSessions === 'function' ? self.ctx.loadSessions() : null;
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
                if (item && item.id) {
                    if (String(item.status || '').toLowerCase() === 'deleted') {
                        self.applyMessageDeleted(item);
                    } else {
                        self.applyMessageRecalled(item);
                    }
                }
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

        applyMessageDeleted(item) {
            const state = this.getState();
            if (!state || !item || !item.id) return;
            const cid = Number(item.conversation_id || 0);
            delete state.recalledDraftByMessageId[item.id];
            if (!cid) return;
            if (Number(cid) === Number(state.activeConversationId || 0)) {
                const beforeLength = Array.isArray(state.activeMessages) ? state.activeMessages.length : 0;
                state.activeMessages = (Array.isArray(state.activeMessages) ? state.activeMessages : []).filter(function(current) {
                    return !current || Number(current.id || 0) !== Number(item.id || 0);
                });
                if (state.activeMessages.length !== beforeLength) {
                    this.renderMessages();
                }
            }
        },

        upsertActiveMessage(item) {
            const state = this.getState();
            if (!state || !item || !item.id) return false;
            const targetConversationId = Number(item.conversation_id || 0);
            if (!targetConversationId || targetConversationId !== Number(state.activeConversationId || 0)) return false;
            const nextMessages = Array.isArray(state.activeMessages) ? state.activeMessages.slice() : [];
            for (let index = 0; index < nextMessages.length; index += 1) {
                const current = nextMessages[index];
                if (current && Number(current.id || 0) === Number(item.id || 0)) {
                    nextMessages[index] = item;
                    state.activeMessages = nextMessages;
                    return true;
                }
            }
            const localTempIndex = this.findLocalMessageIndexByTempId(item.client_temp_id, targetConversationId);
            if (localTempIndex >= 0) {
                nextMessages[localTempIndex] = item;
                state.activeMessages = nextMessages;
                return true;
            }
            const pendingLocalIndex = this.findPendingLocalMessageIndex(item);
            if (pendingLocalIndex >= 0) {
                nextMessages[pendingLocalIndex] = item;
                state.activeMessages = nextMessages;
                return true;
            }
            nextMessages.push(item);
            state.activeMessages = nextMessages;
            return true;
        },

        insertLocalMessage(item) {
            const state = this.getState();
            if (!state || !item || !this.isLocalTempMessage(item)) return false;
            const targetConversationId = Number(item.conversation_id || 0);
            if (!targetConversationId || targetConversationId !== Number(state.activeConversationId || 0)) return false;
            const tempId = this.getLocalTempId(item);
            if (!tempId) return false;
            let replaced = false;
            const nextMessages = [];
            (Array.isArray(state.activeMessages) ? state.activeMessages : []).forEach(function(current) {
                if (current && String(current.__akTempId || current.client_temp_id || '').trim() === tempId) {
                    nextMessages.push(item);
                    replaced = true;
                    return;
                }
                nextMessages.push(current);
            });
            if (!replaced) nextMessages.push(item);
            state.activeMessages = nextMessages;
            return true;
        },

        updateLocalMessage(tempId, patch) {
            const state = this.getState();
            const normalizedTempId = String(tempId || '').trim();
            if (!state || !normalizedTempId) return false;
            let changed = false;
            state.activeMessages = (Array.isArray(state.activeMessages) ? state.activeMessages : []).map(function(current) {
                if (!current || String(current.__akTempId || current.client_temp_id || '').trim() !== normalizedTempId) return current;
                changed = true;
                return Object.assign({}, current, patch || {});
            });
            return changed;
        },

        replaceLocalMessage(tempId, item) {
            const state = this.getState();
            const normalizedTempId = String(tempId || '').trim();
            if (!state || !normalizedTempId || !item || Number(item.id || 0) <= 0) return false;
            let replaced = false;
            state.activeMessages = (Array.isArray(state.activeMessages) ? state.activeMessages : []).map(function(current) {
                if (!current || String(current.__akTempId || current.client_temp_id || '').trim() !== normalizedTempId) return current;
                replaced = true;
                return item;
            });
            if (!replaced) return this.upsertActiveMessage(item);
            return true;
        },

        removeLocalMessage(tempId) {
            const state = this.getState();
            const normalizedTempId = String(tempId || '').trim();
            if (!state || !normalizedTempId) return false;
            const beforeLength = Array.isArray(state.activeMessages) ? state.activeMessages.length : 0;
            state.activeMessages = (Array.isArray(state.activeMessages) ? state.activeMessages : []).filter(function(current) {
                return !current || String(current.__akTempId || current.client_temp_id || '').trim() !== normalizedTempId;
            });
            return state.activeMessages.length !== beforeLength;
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
            if (data.type === 'im.message.error') {
                const payload = data.payload || null;
                const restrictedConversationId = Number(payload && payload.conversation_id || 0);
                const restrictedMessage = String(payload && payload.message || '').trim();
                const restriction = String(payload && payload.restriction || '').trim();
                if (restrictedConversationId > 0) {
                    this.markConversationRestricted(restrictedConversationId, restriction, restrictedMessage);
                    if (typeof this.ctx.loadSessions === 'function') {
                        this.ctx.loadSessions();
                    }
                }
                if (restrictedMessage) {
                    window.alert(restrictedMessage);
                }
                return;
            }
            if (data.type === 'im.message.created') {
                const item = data.payload || null;
                if (!item || !item.conversation_id) return;
                if (Number(item.conversation_id) === Number(state.activeConversationId || 0)) {
                    this.upsertActiveMessage(item);
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
            if (data.type === 'im.message.deleted') {
                const payload = data.payload || null;
                if (payload && payload.id) {
                    this.applyMessageDeleted(payload);
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
                return;
            }
            // 未命中消息相关分支时，委派给其他模块（如会议模块）——保持松耦合：模块缺失不影响本流程
            const meetingModule = window.AKIMUserModules && window.AKIMUserModules.meetingManage;
            if (meetingModule && typeof meetingModule.handleSocketPayload === 'function') {
                try { meetingModule.handleSocketPayload(data); } catch (e) {}
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
