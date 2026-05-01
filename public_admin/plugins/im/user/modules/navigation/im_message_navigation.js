(function(global) {
    'use strict';

    const BOTTOM_THRESHOLD_PX = 72;
    const HIGHLIGHT_DURATION_MS = 1200;

    const messageNavigationModule = {
        ctx: null,
        scrollBoundEl: null,
        highlightTimer: null,

        init(ctx) {
            this.ctx = ctx || null;
            this.ensureNavigationState();
            this.bindScrollEvents();
            this.renderControls();
        },

        getState() {
            return this.ctx && this.ctx.state ? this.ctx.state : null;
        },

        getElements() {
            return this.ctx && this.ctx.elements ? this.ctx.elements : {};
        },

        ensureNavigationState() {
            const state = this.getState();
            if (!state) return null;
            if (!state.messageNavigation || typeof state.messageNavigation !== 'object') {
                state.messageNavigation = {
                    conversationId: 0,
                    entryUnreadCount: 0,
                    firstUnreadSeqNo: 0,
                    unreadAnchorPartial: false,
                    unreadAnchorConsumed: false,
                    newMessageCount: 0,
                    mentionSeqNo: 0,
                    mentionLabel: '',
                    atBottom: true
                };
            }
            return state.messageNavigation;
        },

        getActiveConversationId() {
            const state = this.getState();
            return Number(state && state.activeConversationId || 0);
        },

        getUnreadCount(session) {
            return Math.max(0, Number(session && (session.unread_count || session.unread || 0) || 0) || 0);
        },

        isAtBottom() {
            const messageList = this.getElements().messageList;
            if (!messageList) return true;
            const distance = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight;
            return distance <= BOTTOM_THRESHOLD_PX;
        },

        shouldMarkReadNow() {
            return this.isAtBottom();
        },

        bindScrollEvents() {
            const messageList = this.getElements().messageList;
            if (!messageList || this.scrollBoundEl === messageList) return;
            if (this.scrollBoundEl) this.scrollBoundEl.removeEventListener('scroll', this.handleScroll);
            this.handleScroll = this.handleScroll || this.onScroll.bind(this);
            this.scrollBoundEl = messageList;
            messageList.addEventListener('scroll', this.handleScroll, { passive: true });
        },

        onScroll() {
            const navState = this.ensureNavigationState();
            if (!navState) return;
            const atBottom = this.isAtBottom();
            navState.atBottom = atBottom;
            if (atBottom && navState.newMessageCount > 0) {
                navState.newMessageCount = 0;
                navState.mentionSeqNo = 0;
                navState.mentionLabel = '';
                this.markReadActiveConversation();
            }
            this.renderControls();
        },

        markReadActiveConversation() {
            if (this.ctx && typeof this.ctx.markReadActiveConversation === 'function') {
                this.ctx.markReadActiveConversation(this.getActiveConversationId());
            }
        },

        clearControls() {
            const navEl = this.getElements().navigationEl;
            if (!navEl) return;
            navEl.innerHTML = '';
            navEl.classList.remove('is-visible');
        },

        beginConversationLoad(conversationId, session) {
            const navState = this.ensureNavigationState();
            const targetConversationId = Number(conversationId || 0);
            if (!navState || !targetConversationId) return;
            const unreadCount = this.getUnreadCount(session);
            if (Number(navState.conversationId || 0) !== targetConversationId) {
                navState.conversationId = targetConversationId;
                navState.entryUnreadCount = unreadCount;
                navState.firstUnreadSeqNo = 0;
                navState.unreadAnchorPartial = false;
                navState.unreadAnchorConsumed = unreadCount <= 0;
                navState.newMessageCount = 0;
                navState.mentionSeqNo = 0;
                navState.mentionLabel = '';
                navState.atBottom = true;
                this.renderControls();
                return;
            }
            if (!navState.unreadAnchorConsumed && navState.entryUnreadCount <= 0 && unreadCount > 0) {
                navState.entryUnreadCount = unreadCount;
            }
        },

        beforeRenderMessages() {
            this.bindScrollEvents();
            const messageList = this.getElements().messageList;
            if (!messageList) return { shouldScrollBottom: true, distanceFromBottom: 0 };
            const distanceFromBottom = Math.max(0, messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight);
            return {
                shouldScrollBottom: distanceFromBottom <= BOTTOM_THRESHOLD_PX,
                distanceFromBottom: distanceFromBottom,
                scrollTop: messageList.scrollTop
            };
        },

        afterRenderMessages(snapshot) {
            this.bindScrollEvents();
            const messageList = this.getElements().messageList;
            const navState = this.ensureNavigationState();
            if (!messageList || !navState) return false;
            this.refreshUnreadAnchor();
            if (snapshot && snapshot.shouldScrollBottom) {
                this.scrollToBottom({ silent: true });
            } else if (snapshot) {
                messageList.scrollTop = Math.max(0, Number(snapshot.scrollTop || 0) || 0);
            }
            navState.atBottom = this.isAtBottom();
            if (navState.atBottom) {
                navState.newMessageCount = 0;
                navState.mentionSeqNo = 0;
                navState.mentionLabel = '';
            }
            this.renderControls();
            return true;
        },

        isMentionedInMessage(item) {
            const state = this.getState();
            if (!state || !item) return '';
            if (String(item.sender_username || '') === String(state.username || '')) return '';
            if (item.mention_all) return '@全体';
            const currentUsername = String(state.username || '').trim().toLowerCase();
            const mentionUsernames = Array.isArray(item.mention_usernames) ? item.mention_usernames : [];
            const matched = mentionUsernames.some(function(username) {
                return String(username || '').trim().toLowerCase() === currentUsername;
            });
            return matched ? '@我' : '';
        },

        refreshUnreadAnchor() {
            const state = this.getState();
            const navState = this.ensureNavigationState();
            if (!state || !navState || navState.unreadAnchorConsumed) return;
            const entryUnreadCount = Math.max(0, Number(navState.entryUnreadCount || 0) || 0);
            if (entryUnreadCount <= 0) return;
            const peerMessages = (Array.isArray(state.activeMessages) ? state.activeMessages : []).filter(function(item) {
                return item && Number(item.seq_no || 0) > 0 && String(item.sender_username || '') !== String(state.username || '');
            });
            if (!peerMessages.length) return;
            const anchorIndex = Math.max(0, peerMessages.length - entryUnreadCount);
            const anchorMessage = peerMessages[anchorIndex] || peerMessages[0];
            navState.firstUnreadSeqNo = Number(anchorMessage && anchorMessage.seq_no || 0) || 0;
            navState.unreadAnchorPartial = entryUnreadCount > peerMessages.length;
        },

        handleIncomingMessage(item) {
            const state = this.getState();
            const navState = this.ensureNavigationState();
            if (!navState || !item) return;
            if (Number(item.conversation_id || 0) !== this.getActiveConversationId()) return;
            if (state && String(item.sender_username || '') === String(state.username || '')) return;
            const mentionLabel = this.isMentionedInMessage(item);
            if (this.isAtBottom()) {
                navState.newMessageCount = 0;
                navState.atBottom = true;
                return;
            }
            if (mentionLabel) {
                navState.mentionSeqNo = Number(item.seq_no || 0) || 0;
                navState.mentionLabel = mentionLabel;
            }
            navState.newMessageCount = Math.max(0, Number(navState.newMessageCount || 0) || 0) + 1;
            navState.atBottom = false;
            this.renderControls();
        },

        findMessageNodeBySeqNo(seqNo) {
            const messageList = this.getElements().messageList;
            const targetSeqNo = Number(seqNo || 0);
            if (!messageList || !targetSeqNo) return null;
            return messageList.querySelector('[data-im-message-seq-no="' + String(targetSeqNo) + '"]');
        },

        highlightMessage(node) {
            if (!node) return;
            if (this.highlightTimer) clearTimeout(this.highlightTimer);
            node.classList.add('is-navigation-highlight');
            this.highlightTimer = setTimeout(function() {
                node.classList.remove('is-navigation-highlight');
            }, HIGHLIGHT_DURATION_MS);
        },

        scrollToNode(node) {
            const messageList = this.getElements().messageList;
            if (!messageList || !node) return false;
            const listRect = messageList.getBoundingClientRect();
            const nodeRect = node.getBoundingClientRect();
            const top = Math.max(0, messageList.scrollTop + nodeRect.top - listRect.top - 16);
            messageList.scrollTop = top;
            this.highlightMessage(node);
            return true;
        },

        scrollToFirstUnread() {
            const navState = this.ensureNavigationState();
            if (!navState) return;
            this.refreshUnreadAnchor();
            const node = this.findMessageNodeBySeqNo(navState.firstUnreadSeqNo);
            if (node && this.scrollToNode(node)) {
                navState.unreadAnchorConsumed = true;
                this.renderControls();
                return;
            }
            const messageList = this.getElements().messageList;
            if (messageList) messageList.scrollTop = 0;
        },

        scrollToMention() {
            const navState = this.ensureNavigationState();
            if (!navState) return;
            const node = this.findMessageNodeBySeqNo(navState.mentionSeqNo);
            if (node && this.scrollToNode(node)) {
                navState.mentionSeqNo = 0;
                navState.mentionLabel = '';
                this.renderControls();
            }
        },

        scrollToBottom(options) {
            const messageList = this.getElements().messageList;
            const navState = this.ensureNavigationState();
            if (!messageList) return;
            messageList.scrollTop = messageList.scrollHeight;
            if (navState) {
                navState.newMessageCount = 0;
                navState.mentionSeqNo = 0;
                navState.mentionLabel = '';
                navState.atBottom = true;
            }
            if (!options || !options.silent) this.markReadActiveConversation();
            if (!options || !options.silent) this.renderControls();
        },

        buildButton(action, text) {
            return '<button class="ak-im-message-nav-btn" type="button" data-im-message-nav-action="' + action + '">' + this.ctx.escapeHtml(text) + '</button>';
        },

        renderControls() {
            const elements = this.getElements();
            const navEl = elements.navigationEl;
            const navState = this.ensureNavigationState();
            if (!navEl || !navState || !this.ctx || typeof this.ctx.escapeHtml !== 'function') return;
            const parts = [];
            const entryUnreadCount = Math.max(0, Number(navState.entryUnreadCount || 0) || 0);
            if (entryUnreadCount > 0 && !navState.unreadAnchorConsumed) {
                parts.push(this.buildButton('unread', entryUnreadCount + '条未读消息'));
            }
            if (Number(navState.mentionSeqNo || 0) > 0 && String(navState.mentionLabel || '').trim()) {
                parts.push(this.buildButton('mention', '有人' + String(navState.mentionLabel || '').trim()));
            }
            const newMessageCount = Math.max(0, Number(navState.newMessageCount || 0) || 0);
            if (newMessageCount > 0 && !this.isAtBottom()) {
                parts.push(this.buildButton('new', newMessageCount + '条新消息'));
            }
            if (!this.isAtBottom()) {
                parts.push(this.buildButton('bottom', '回到底部'));
            }
            navEl.innerHTML = parts.join('');
            navEl.classList.toggle('is-visible', parts.length > 0);
            this.bindControlEvents(navEl);
        },

        bindControlEvents(navEl) {
            const self = this;
            Array.prototype.forEach.call(navEl.querySelectorAll('[data-im-message-nav-action]'), function(button) {
                button.addEventListener('click', function() {
                    const action = String(button.getAttribute('data-im-message-nav-action') || '').trim();
                    if (action === 'unread') {
                        self.scrollToFirstUnread();
                        return;
                    }
                    if (action === 'mention') {
                        self.scrollToMention();
                        return;
                    }
                    self.scrollToBottom();
                });
            });
        }
    };

    global.AKIMUserModules = global.AKIMUserModules || {};
    global.AKIMUserModules.messageNavigation = messageNavigationModule;
})(window);
