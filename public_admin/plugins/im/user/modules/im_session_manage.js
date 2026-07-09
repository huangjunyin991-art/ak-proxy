(function(global) {
    'use strict';

    const AI_ASSISTANT_USERNAME = 'ak_ai_assistant';
    const AI_ASSISTANT_TITLE = '\u0041\u004b\u52a9\u624b';
    const AI_ASSISTANT_PREVIEW = '\u5c0f\u0041 \u00b7 \u70b9\u51fb\u5f00\u59cb\u5bf9\u8bdd';
    const AI_ASSISTANT_OPENING = '\u6253\u5f00\u4e2d';

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

        getSessionHonorName(item) {
            if (this.isGroupSession(item)) return '';
            return String(item && item.peer_honor_name || '').trim();
        },

        buildSessionTitleMarkup(item) {
            const displayName = this.getSessionDisplayName(item);
            if (!this.ctx || typeof this.ctx.escapeHtml !== 'function') return displayName;
            if (this.isGroupSession(item) || typeof this.ctx.buildDisplayNameWithHonorMarkup !== 'function') {
                return '<span class="ak-im-session-title-text">' + this.ctx.escapeHtml(displayName) + '</span>';
            }
            return this.ctx.buildDisplayNameWithHonorMarkup(displayName, this.getSessionHonorName(item), '内部聊天', {
                wrapperClassName: 'ak-im-session-title-text ak-im-name-with-honor',
                textClassName: 'ak-im-name-text',
                badgeClassName: 'ak-im-honor-badge'
            });
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
            return this.ctx.buildAvatarBoxMarkup('ak-im-session-avatar', item, displayName, displayName + '头像');
        },

        getSessionSubtitle(item) {
            if (this.isGroupSession(item)) {
                const memberCount = Math.max(0, Number(item && item.member_count || 0) || 0);
                return memberCount > 0 ? ('群聊 · ' + memberCount + '人') : '群聊';
            }
            const peerUsername = String(item && item.peer_username || '').trim();
            return peerUsername ? ('账号：' + peerUsername) : '';
        },

        safeParseJson(value) {
            const rawText = String(value || '').trim();
            if (!rawText) return null;
            try {
                const parsed = JSON.parse(rawText);
                return parsed && typeof parsed === 'object' ? parsed : null;
            } catch (e) {
                return null;
            }
        },

        isCallPreviewText(value) {
            return String(value || '').trim().indexOf('📞') === 0;
        },

        normalizeCallTextPreview(preview, senderUsername) {
            const normalizedPreview = String(preview || '').trim();
            const normalizedSender = String(senderUsername || '').trim().toLowerCase();
            const isRemote = !!(normalizedSender && !(this.ctx && typeof this.ctx.isCurrentIdentityUsername === 'function' && this.ctx.isCurrentIdentityUsername(normalizedSender)));
            const durationMatch = normalizedPreview.match(/通话时长\s*([0-9:]+)/);
            if (durationMatch && durationMatch[1]) return '通话时长 ' + durationMatch[1];
            if (normalizedPreview.indexOf('拒接') >= 0) return isRemote ? '对方已拒接' : '已拒接';
            if (normalizedPreview.indexOf('未接听') >= 0) return isRemote ? '你未接听' : '对方未接听';
            if (normalizedPreview.indexOf('取消') >= 0) return isRemote ? '对方已取消' : '已取消';
            return normalizedPreview.replace(/^📞\s*/, '').trim();
        },

        normalizeCallEventPreview(item, fallbackPreview) {
            const payload = this.safeParseJson(item && item.content);
            const normalizedFallbackPreview = String(fallbackPreview || '').trim();
            if (normalizedFallbackPreview) return normalizedFallbackPreview;
            if (!payload) return '';
            const eventName = String(payload.event || '').trim().toLowerCase();
            const durationText = String(payload.duration_text || payload.durationText || '').trim();
            if (eventName === 'completed') {
                return '通话时长 ' + (durationText || '00:00');
            }
            if (eventName === 'rejected') {
                return '已拒接';
            }
            if (eventName === 'cancelled') {
                return '已取消';
            }
            return '';
        },

        getSessionPreview(item) {
            let preview = String(item && item.last_message_preview || '').trim() || '暂无消息';
            if (String(item && item.last_message_type || '').trim().toLowerCase() === 'call_event') {
                preview = this.normalizeCallEventPreview(item, preview) || '暂无消息';
            } else if (this.isCallPreviewText(preview)) {
                preview = this.normalizeCallTextPreview(preview, item && (item.last_message_sender_username || item.sender_username));
            }
            if (String(item && item.last_message_type || '').trim().toLowerCase() === 'emoji_custom' && preview && preview !== '暂无消息' && !/^\[.*\]$/.test(preview)) {
                preview = '[' + preview + ']';
            }
            const mentionLabel = this.getSessionMentionLabel(item);
            return mentionLabel ? (mentionLabel + ' ' + preview) : preview;
        },

        getSessionMentionLabel(item) {
            if (!item || Number(item.mention_unread_count || 0) <= 0) return '';
            if (item.mention_me_unread) return '[有人@我]';
            if (item.mention_all_unread) return '[有人@全体]';
            return '';
        },

        getUnreadCount(item) {
            if (this.isAIAssistantSession(item)) return 0;
            return Number(item && (item.unread_count || item.unread || 0) || 0);
        },

        isAIAssistantSession(item) {
            return String(item && item.peer_username || '').trim().toLowerCase() === AI_ASSISTANT_USERNAME;
        },

        getAIAssistantSession(sessions) {
            const items = Array.isArray(sessions) ? sessions : [];
            for (let i = 0; i < items.length; i += 1) {
                if (this.isAIAssistantSession(items[i])) return items[i];
            }
            return null;
        },

        buildAIAssistantSessionItem(source) {
            const item = Object.assign({}, source || {});
            item.conversation_type = 'direct';
            item.peer_username = AI_ASSISTANT_USERNAME;
            item.peer_display_name = AI_ASSISTANT_TITLE;
            item.avatar_kind = item.avatar_kind || 'generated';
            item.avatar_style = item.avatar_style || 'thumbs';
            item.avatar_seed = item.avatar_seed || 'ak-ai-assistant';
            return item;
        },

        getAIAssistantPreview() {
            const state = this.ctx && this.ctx.state ? this.ctx.state : {};
            if (state.aiAssistant && state.aiAssistant.message) {
                return String(state.aiAssistant.message || '').trim();
            }
            const aiManage = this.ctx && typeof this.ctx.getAIManage === 'function' ? this.ctx.getAIManage() : null;
            const title = aiManage && typeof aiManage.getActiveContextTitle === 'function'
                ? String(aiManage.getActiveContextTitle() || '').trim()
                : '';
            if (title) return '当前上下文：' + title;
            return AI_ASSISTANT_PREVIEW;
        },

        renderAIAssistantEntry(sessionList, source) {
            if (!sessionList || !this.ctx || typeof this.ctx.openAIAssistant !== 'function') return;
            const state = this.ctx.state || {};
            const item = this.buildAIAssistantSessionItem(source);
            const conversationId = Number(item.conversation_id || 0);
            const unreadCount = 0;
            const isOpening = !!(state.aiAssistant && state.aiAssistant.opening);
            const preview = this.getAIAssistantPreview();
            const timeText = conversationId ? this.ctx.formatSessionTime(item.last_message_at || item.updated_at || item.created_at) : (isOpening ? AI_ASSISTANT_OPENING : 'AI');
            const node = document.createElement('div');
            node.className = 'ak-im-session-item is-ai-assistant' + (conversationId && conversationId === state.activeConversationId ? ' ak-active' : '') + (isOpening ? ' is-opening' : '');
            node.innerHTML = this.buildSessionAvatarMarkup(item) +
                '<div class="ak-im-session-body">' +
                    '<div class="ak-im-session-title"><span class="ak-im-session-title-text">' + this.ctx.escapeHtml(AI_ASSISTANT_TITLE) + '</span><span class="ak-im-session-pin-tag visible is-system">AI</span></div>' +
                    '<div class="ak-im-session-time">' + this.ctx.escapeHtml(timeText) + '</div>' +
                    '<div class="ak-im-session-preview">' + this.ctx.escapeHtml(preview) + '</div>' +
                    '<div class="ak-im-session-unread' + (unreadCount > 0 ? ' visible' : '') + '">' + this.ctx.escapeHtml(unreadCount > 99 ? '99+' : String(unreadCount || '')) + '</div>' +
                '</div>';
            node.addEventListener('click', () => {
                if (typeof this.ctx.closeActionSheet === 'function') this.ctx.closeActionSheet();
                if (typeof this.ctx.closeReadProgressPanel === 'function') this.ctx.closeReadProgressPanel();
                if (typeof this.ctx.closeEmojiPicker === 'function') this.ctx.closeEmojiPicker({ silent: true });
                if (typeof this.ctx.closeMemberPanel === 'function') this.ctx.closeMemberPanel();
                this.ctx.openAIAssistant();
            });
            sessionList.appendChild(node);
        },

        renderSessionList() {
            if (!this.ctx || !this.ctx.state || typeof this.ctx.escapeHtml !== 'function' || typeof this.ctx.formatSessionTime !== 'function') return;
            const state = this.ctx.state;
            const elements = this.getElements();
            const sessionList = elements.sessionList;
            if (!sessionList) return;
            const sessions = Array.isArray(state.sessions) ? state.sessions : [];
            const self = this;
            const assistantSession = this.getAIAssistantSession(sessions);
            const canShowAssistant = !!(state.allowed && typeof this.ctx.openAIAssistant === 'function');
            const visibleSessions = sessions.filter(function(item) {
                return !self.isAIAssistantSession(item);
            });
            sessionList.innerHTML = '';
            if (canShowAssistant) this.renderAIAssistantEntry(sessionList, assistantSession);
            if (!visibleSessions.length) {
                if (canShowAssistant) return;
                const empty = document.createElement('div');
                empty.className = 'ak-im-empty';
                empty.textContent = state.allowed ? '暂无会话\n点击右上角搜索联系人开始聊天' : '当前账号未开通聊天';
                sessionList.appendChild(empty);
                return;
            }
            visibleSessions.forEach(function(item) {
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
                        '<div class="ak-im-session-title">' + self.buildSessionTitleMarkup(item) + '<span class="ak-im-session-pin-tag' + (isPinned ? ' visible' : '') + (isSystemPinned ? ' is-system' : '') + '">' + self.ctx.escapeHtml(pinText) + '</span></div>' +
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
                    state.hiddenGroupsActiveSession = null;
                    state.view = 'chat';
                    state.activeMessages = Array.isArray(state.messagesByConversationId && state.messagesByConversationId[String(item.conversation_id)]) ? state.messagesByConversationId[String(item.conversation_id)].slice() : [];
                    if (!state.activeMessages.length && typeof self.ctx.restorePersistedConversationMessages === 'function') {
                        self.ctx.restorePersistedConversationMessages(item.conversation_id);
                    }
                    state.activeMessagesLoading = true;
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
                    if (stillExists) {
                        state.hiddenGroupsActiveSession = null;
                    }
                    if (!stillExists) {
                        const hiddenGroupSession = state.hiddenGroupsActiveSession;
                        const keepHiddenGroupActive = hiddenGroupSession && Number(hiddenGroupSession.conversation_id || 0) === Number(state.activeConversationId || 0);
                        if (!keepHiddenGroupActive) {
                            state.activeConversationId = 0;
                            state.activeMessages = [];
                            state.activeMessagesLoading = false;
                            if (typeof self.ctx.closeReadProgressPanel === 'function') self.ctx.closeReadProgressPanel();
                            if (typeof self.ctx.closeEmojiPicker === 'function') self.ctx.closeEmojiPicker({ silent: true });
                            if (typeof self.ctx.closeMemberPanel === 'function') self.ctx.closeMemberPanel();
                            if (typeof self.ctx.closeSettingsPanel === 'function') self.ctx.closeSettingsPanel();
                            if (state.view === 'chat') state.view = 'sessions';
                        }
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
                    unread: 0,
                    mention_unread_count: 0,
                    mention_me_unread: false,
                    mention_all_unread: false
                });
            });
            if (changed && typeof this.ctx.render === 'function') this.ctx.render();
        },

        applyIncomingMessage(item, isActiveChat) {
            if (!this.ctx || !this.ctx.state || !item || !item.conversation_id) return false;
            const state = this.ctx.state;
            const targetConversationId = Number(item.conversation_id || 0);
            const isSelfMessage = this.ctx && typeof this.ctx.isCurrentIdentityUsername === 'function'
                ? this.ctx.isCurrentIdentityUsername(item.sender_username)
                : String(item.sender_username || '') === String(state.username || '');
            const nextMessageType = String(item.message_type || '').trim();
            const nextPreview = nextMessageType.toLowerCase() === 'call_event'
                ? (this.normalizeCallEventPreview(item, item.content_preview) || String(item.content_preview || '').trim())
                : String(item.content_preview || '').trim();
            let changed = false;
            state.sessions = (Array.isArray(state.sessions) ? state.sessions : []).map(function(session) {
                if (!session || Number(session.conversation_id || 0) !== targetConversationId) return session;
                const currentUnreadCount = Math.max(0, Number(session.unread_count || session.unread || 0) || 0);
                const nextUnreadCount = isSelfMessage || isActiveChat ? currentUnreadCount : currentUnreadCount + 1;
                changed = true;
                return Object.assign({}, session, {
                    last_message_id: Number(item.id || session.last_message_id || 0) || 0,
                    last_message_type: nextMessageType || String(session.last_message_type || '').trim(),
                    last_message_preview: nextPreview || String(session.last_message_preview || '').trim(),
                    last_message_sender_username: String(item.sender_username || session.last_message_sender_username || '').trim().toLowerCase(),
                    last_message_at: String(item.sent_at || session.last_message_at || '').trim(),
                    unread_count: nextUnreadCount,
                    unread: nextUnreadCount
                });
            });
            if (changed && typeof this.ctx.render === 'function') this.ctx.render();
            return changed;
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.sessionManage = sessionManageModule;
})(window);
